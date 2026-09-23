// The syntax version a saved transcription is written in, and the ladder that
// carries older ones forward.
//
// The source text IS the document, so any change to what a character MEANS is
// a change to every file already written — silently reinterpreting them is how
// a library rots. Instead each document remembers the version of the language
// it was written against, and on load it walks the ladder up to the current
// one, one migration per step.
//
// Rules for adding a migration:
//   • bump SYNTAX_VERSION and append ONE entry to LADDER whose `to` matches it;
//   • a migration is text → text, and must be a no-op on text that doesn't use
//     the thing that changed (most documents shouldn't be touched at all);
//   • it must PROVE it didn't change the music — see absoluteRegisters, which
//     replays both readings and bails out with the text untouched if they
//     disagree. A migration that can't prove it should not run.
// Purely additive changes (new syntax that used to be an error) need no
// migration and no bump: nothing already written can mean something new.
//
// A document from a NEWER build than this one is left completely alone —
// better to render it with the wrong reading than to rewrite it downwards and
// lose what the newer build meant.

import {
  MarkRuns, groupDur, hasOldOctave, indexOfComment, markBeat, markOk, markRegister,
  parseJianpu, readMarkRuns, respellOldOctaves, tokenize,
} from './parse';
import { Doc, TICKS_PER_CROTCHET } from './types';

export const SYNTAX_VERSION = 7;

type Migration = {
  to: number;                        // the version this step produces
  what: string;                      // one line, for the console note
  run: (text: string) => string;
};

const LADDER: Migration[] = [
  {
    to: 2,
    what: '< and > now SET the register rather than shifting it',
    run: absoluteRegisters,
  },
  {
    to: 3,
    what: `\\[ now opens a beat group instead of being an ignored LilyPond word`,
    run: dropBeatGroupOpeners,
  },
  {
    to: 4,
    what: `the octave marks < and > are now written , and '`,
    run: dotOctaves,
  },
  {
    to: 5,
    what: `a standalone , ' \\ or / MOVES the register and the beat rather than setting it`,
    run: relativeMarks,
  },
  {
    to: 6,
    what: `the partial resets \\= and =, are written : and ; now`,
    run: partialResets,
  },
  {
    to: 7,
    what: `%%% comments out the rest of the page, not just its own line`,
    run: spaceOutTripleComments,
  },
];

export type MigrationResult = { text: string; version: number; applied: string[] };

export function migrateText(text: string, from: number): MigrationResult {
  let version = Number.isFinite(from) && from >= 1 ? Math.floor(from) : 1;
  let out = text;
  const applied: string[] = [];
  for (const step of LADDER) {
    if (step.to <= version) continue;
    const next = step.run(out);
    if (next !== out) applied.push(step.what);
    out = next;
    version = step.to;
  }
  return { text: out, version, applied };
}

// The one moment this scheme couldn't stamp: v2 shipped before the version
// field existed, so documents edited in the hours between are v2 text with
// nothing on them saying so — and reading those as v1 would rewrite registers
// that are already right. Their edit time is the only evidence available, so
// it decides. Epoch ms of the commit that made < and > absolute.
//
// This is a one-off. Every version from here is stamped when it's written, so
// no later migration ever has to guess.
const V2_SHIPPED = 1786431055000;

// A document with no version on it predates versioning: version 1, unless it
// was last edited after v2 was already live.
export function versionOf(doc: { syntax?: number; updated?: number }): number {
  if (typeof doc.syntax === 'number' && doc.syntax >= 1) return Math.floor(doc.syntax);
  return (doc.updated ?? 0) >= V2_SHIPPED ? 2 : 1;
}

export function migrateDoc(doc: Doc): Doc {
  const said = withConcert(doc);
  const from = versionOf(said);
  if (from >= SYNTAX_VERSION) return said.syntax === from ? said : { ...said, syntax: from };
  const r = migrateText(said.text, from);
  if (r.applied.length) {
    console.info(`[transcribe] "${said.name}" → syntax v${r.version}: ${r.applied.join('; ')}`);
  }
  return { ...said, text: r.text, syntax: r.version };
}

// ── the pitching, out of the settings and into the writing ───────────
//
// "This page is a B♭ part" used to be a switch on the toolbar, kept beside the
// document. It is a fact about the transcription rather than a preference, so
// it is now said in the source: CONCERT=Bb on a line of its own. A document
// that had the switch on gets the line written in at the top — once — and the
// setting comes off it.
//
// Not a syntax migration: nothing about what the TEXT means has changed, so
// there is no version to bump and nothing to prove. A document that already
// says CONCERT= is left exactly as it is, whatever the old switch said.
function withConcert(doc: Doc): Doc {
  if (doc.pitching == null) return doc;
  const { pitching, ...rest } = doc;
  if (pitching !== 'Bb' || /^[ \t]*concert[ \t]*=/im.test(doc.text)) return rest as Doc;
  console.info(`[transcribe] "${doc.name}": the B♭ pitching is now CONCERT=Bb in the text`);
  return { ...(rest as Doc), text: `CONCERT=Bb\n${doc.text}` };
}

// ── v1 → v2 ──────────────────────────────────────────────────────────
//
// < and > used to SHIFT the base octave one step from wherever it already was,
// so "< 1 < 1" was two octaves down by the second note. They now SET it,
// counted from the register the movement started in, so that same text reads
// as one octave down twice over.
//
// The fix is to replay the old reading and write out where each mark actually
// left you: the second < becomes <<, a < that undid a > becomes =, and a lone
// mark — by far the common case — comes out exactly as it went in, which is
// why most documents pass through this untouched.
function absoluteRegisters(text: string): string {
  const toks = registerTokens(text);
  if (!toks.length) return text;

  const edits: { start: number; end: number; word: string }[] = [];
  let oldBase = 0;   // what the text used to mean, accumulated
  let newBase = 0;   // what the rewrite will mean, read absolutely
  for (const t of toks) {
    if (t.word === 'NextScore' || t.word === 'NextPart') {
      oldBase = newBase = 0;
      continue;
    }
    // A bare = meant nothing in v1 — it was an unrecognised token the parser
    // complained about and skipped. In v2 it resets the register, so left
    // alone it would start moving notes. Writing out the register that was
    // actually in force keeps the reading it had.
    if (t.word !== '=') oldBase += step(t.word);
    const word = spell(oldBase);
    newBase = word === '=' ? 0 : step(word);
    // The whole promise of a migration: the notes don't move. If the rewrite
    // wouldn't land in the same register, leave the document alone and let it
    // be read as written rather than rewritten wrongly.
    if (newBase !== oldBase) return text;
    edits.push({ start: t.start, end: t.end, word });
  }

  let out = '';
  let cur = 0;
  for (const e of edits) {
    out += text.slice(cur, e.start) + e.word;
    cur = e.end;
  }
  return out + text.slice(cur);
}

// ── v2 → v3 ──────────────────────────────────────────────────────────
//
// `\[` was one of LilyPond's bracket commands: a word this app recognised,
// warned about and skipped, with no effect on a single note. It now opens a
// beat group, so left in place it would rewrite the durations of everything
// after it — and swallow the ] that used to close a tuplet.
//
// Deleting it restores exactly the old reading — a word that did nothing is
// worth nothing once it's gone — and the result holds no beat-group openers,
// so v3 reads it the way v2 did. That's the proof; no replay is needed. The
// other spellings of an opener (`s[`, `/[`, `1=Eb[`) were hard errors before,
// so nothing already written can be one.
const BEAT_OPENER = /^\\+\.*\[$/;

function dropBeatGroupOpeners(text: string): string {
  // Found through the parser's annotations, so a `\(` sitting in a comment, a
  // lyric line, a header or an LP: block is never touched — those lines never
  // reach the token pass, and only a token does.
  const hits = parseJianpu(text).annotations.filter(a =>
    a.cls === 'dur' && BEAT_OPENER.test(text.slice(a.start, a.end)));
  if (!hits.length) return text;

  let out = '';
  let cur = 0;
  for (const a of hits.sort((x, y) => x.start - y.start)) {
    if (a.start < cur) continue;
    // Take the run of spaces after it too, so the line doesn't gap.
    let end = a.end;
    while (end < text.length && text[end] === ' ') end++;
    if (end >= text.length || text[end] === '\n') end = a.end;
    out += text.slice(cur, a.start);
    cur = end;
  }
  return out + text.slice(cur);
}

// ── v3 → v4 ──────────────────────────────────────────────────────────
//
// The octave marks were written three ways — ' , and + - and > < — and the
// angles are gone: ' and , now do that job on a note AND standing alone as the
// register, so there's one pair of characters for "an octave up/down" wherever
// it appears. Nothing reads > and < any more, so a document still holding them
// would lose an octave silently; this puts every one of them into the spelling
// that replaced it.
//
// The tokens are found by the errors the new parser raises on them, which is
// the same thing as saying the parser decides what was a mark: a < in a lyric
// line, a comment, a header, a chord line or an LP: block never becomes a
// token at all, and a \< crescendo is a LilyPond word rather than a note.
//
// The proof that the music doesn't move is character-for-character: > and <
// map one to one onto ' and , — same direction, same position, same count —
// so a token means exactly what it meant. sameMeaning checks that of every
// rewrite, and one disagreement leaves the whole document alone.
function dotOctaves(text: string): string {
  const hits = parseJianpu(text).annotations.filter(a =>
    a.cls === 'unknown' && hasOldOctave(text.slice(a.start, a.end)));
  if (!hits.length) return text;

  let out = '';
  let cur = 0;
  for (const a of hits.sort((x, y) => x.start - y.start)) {
    if (a.start < cur) continue;
    const was = text.slice(a.start, a.end);
    const now = respellOldOctaves(was);
    if (!sameMeaning(was, now)) return text;
    out += text.slice(cur, a.start) + now;
    cur = a.end;
  }
  return out + text.slice(cur);
}

// Which way a character moves a note, in either spelling. Everything else is
// 0, including the = that says "no mark here".
function moves(c: string): number {
  return c === "'" || c === '+' || c === '>' ? 1 : c === ',' || c === '-' || c === '<' ? -1 : 0;
}

// The rewrite says the same thing iff every character still moves what it
// moved, and every character that wasn't a mark came through untouched.
function sameMeaning(was: string, now: string): boolean {
  if (was.length !== now.length) return false;
  for (let i = 0; i < was.length; i++) {
    if (moves(was[i]) !== moves(now[i])) return false;
    if (moves(was[i]) === 0 && was[i] !== now[i]) return false;
  }
  return true;
}

function step(word: string): number {
  return word.length * (word[0] === '<' ? -1 : 1);
}

function spell(base: number): string {
  if (base === 0) return '=';
  return (base < 0 ? '<' : '>').repeat(Math.abs(base));
}

// Every standalone register mark and movement break in the MUSIC, in source
// order. Found through the parser's own annotations rather than a fresh scan,
// so a < inside a lyric line, a chord line, a comment or a header is never
// mistaken for one — the parser has already decided what those lines are.
function registerTokens(text: string): { start: number; end: number; word: string }[] {
  const out: { start: number; end: number; word: string }[] = [];
  for (const a of parseJianpu(text).annotations) {
    const word = text.slice(a.start, a.end);
    const alone = (a.start === 0 || /\s/.test(text[a.start - 1]))
      && (a.end === text.length || /\s/.test(text[a.end]));
    if (!alone) continue;   // the < in "1<" is a note's own mark, not a register
    // The parser stopped reading < and > in v4 and now reports them as errors,
    // so a mark this step is here to rewrite comes through as 'unknown'. It's
    // still the parser saying "this was a token", which is all this needs;
    // v3 → v4 puts the spelling right afterwards.
    if (/^(<+|>+|=)$/.test(word) && (a.cls === 'octave' || a.cls === 'unknown')) {
      out.push({ start: a.start, end: a.end, word });
    }
    else if (a.cls === 'directive' && (word === 'NextScore' || word === 'NextPart')) {
      out.push({ start: a.start, end: a.end, word });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

// ── v4 → v5 ──────────────────────────────────────────────────────────
//
// The standalone marks MOVE the register and the beat now, where they used to
// SET them. `,` meant "an octave below the register this passage started in"
// however many marks came before it; it means "an octave below where you are".
// So `, ,` was one octave down said twice and is two octaves down now, and
// every document already written says the old thing.
//
// Each mark is re-spelled as the MOVE that lands where it used to land. A lone
// mark in a passage that hadn't moved yet comes out exactly as it went in,
// which is why most documents pass through untouched; a run of them is where
// the spellings part company — `, ,` loses its second mark (it moved nothing),
// and `, ,,` becomes `, ,` (one more octave down, not two).
//
// The = is untouched in either half: it meant "back to the original" and still
// does, which is what gives the rewrite its footing — where a move can't be
// spelled in one token (a dotted beat off a dotted beat is no note value), the
// mark comes out as a reset followed by the beat it always named.
//
// The proof is the one v1 → v2 made, walking the other way: both readings are
// replayed side by side, and the rewrite has to leave the register AND the beat
// exactly where the old reading left them at every mark. One disagreement and
// the document is left alone.

// What the reader carries down a line: the register and beat in force, and the
// beat a = puts back — the movement's crotchet, or the beat of whatever bracket
// is open. Exactly the parser's own state, kept for both readings at once,
// since the whole point is that they agree.
type Frame = { oct: number; dur: number; anchor: number };

// A bracket, as far as the beat is concerned: what to put back at its ], or
// null for the ones that name no beat (a plain 3[ tuplet, a 1=Eb[ modulation).
type Bracket = { dur: number; anchor: number } | null;

const DUR_OPEN = /^(\\+|\/+|[hdsqec])(\.*)\[$/;
const TUP_OPEN = /^(\d+)(?:(\\+|\/+|[hdsqec])(\.*))?\[$/;
const KEY_OPEN = /^(?:[1-7]=[A-Ga-g][#b]*|K=[A-Ga-g][#b]*(?:m|min|minor)?)\[$/;

function relativeMarks(text: string): string {
  // The parser decides which lines are music and which staff each one belongs
  // to — a `,` in a lyric line, a chord line, a comment, a header or an LP:
  // block is not a mark and is never seen here.
  const score = parseJianpu(text);
  const edits: { start: number; end: number; text: string }[] = [];

  let f: Frame = { oct: 0, dur: TICKS_PER_CROTCHET, anchor: TICKS_PER_CROTCHET };
  let brackets: Bracket[] = [];
  // The register each under-staff was left in, exactly as the parser keeps it:
  // a B: line picks up where the last B: line left off.
  const underOct = new Map<string, number>();
  let bad = false;

  for (const line of score.music) {
    let body = text.slice(line.span.start, line.span.end);
    // The X:/T:/B: that opens the line is not a token — blanked rather than cut
    // so every offset after it is still the offset it has in the document.
    const head = /^[ \t]*[XTB]\d*:/.exec(body);
    if (head) body = ' '.repeat(head[0].length) + body.slice(head[0].length);

    // An under-staff line is its own little piece of music: it starts at the
    // movement's beat and in the register its own last line left off in, and
    // gives back everything it found when the line ends.
    const held = line.under ? { f, brackets } : null;
    if (held) {
      f = { oct: underOct.get(line.under!) ?? 0, dur: TICKS_PER_CROTCHET, anchor: TICKS_PER_CROTCHET };
      brackets = [];
    }

    for (const tok of tokenize(body, line.span.start)) {
      const T = tok.text;
      if (T === 'NextScore' || T === 'NextPart') {
        f = { oct: 0, dur: TICKS_PER_CROTCHET, anchor: TICKS_PER_CROTCHET };
        brackets = [];
        underOct.clear();
        continue;
      }
      const dur = DUR_OPEN.exec(T);
      if (dur) {
        brackets.push({ dur: f.dur, anchor: f.anchor });
        f.dur = f.anchor = groupDur(dur[1], dur[2], f.dur);
        continue;
      }
      const tup = TUP_OPEN.exec(T);
      if (tup && Number(tup[1]) >= 2) {
        if (tup[2]) {
          brackets.push({ dur: f.dur, anchor: f.anchor });
          f.dur = f.anchor = groupDur(tup[2], tup[3], f.dur);
        } else brackets.push(null);
        continue;
      }
      if (KEY_OPEN.test(T)) { brackets.push(null); continue; }
      if (T === ']') {
        const b = brackets.pop();
        if (b) { f.dur = b.dur; f.anchor = b.anchor; }
        continue;
      }
      // Only the alphabet v4 had: : and ; weren't marks then, and a token
      // holding one was an error that moved nothing.
      const m = OLD_MARK.test(T) ? readMarkRuns(T) : null;
      if (!m || !markOk(m)) continue;   // a note, a barline, or a mark nothing reads
      // v4 spelled the partial resets `\=` and `=,` — a = naming its half by
      // the mark it kept company with, and ignoring what that mark said. Those
      // characters read differently today (a reset is counted first and the
      // runs move off it), so the old reading is applied here by hand and the
      // token comes out in the spelling v6 gave it. A = naming BOTH halves was
      // turned away in v4, so it moved nothing and is left exactly as it is.
      if (m.reset) {
        if (m.beat && m.oct) continue;
        if (!m.oct) f.dur = f.anchor;
        if (!m.beat) f.oct = 0;
        const next = m.beat ? ':' : m.oct ? ';' : '=';
        if (next !== T) edits.push({ start: tok.start, end: tok.start + T.length, text: next });
        continue;
      }
      // What the OLD reading made of it: the register counted from the
      // movement's own (which is what "absolute" meant), the beat from the
      // anchor.
      const wantOct = markRegister(T, m, 0);
      const wantDur = markBeat(T, m, f.anchor, f.anchor);
      const now = { ...f };
      const spelling = respell(T, m, now, wantOct, wantDur);
      if (!spelling) { bad = true; break; }
      // …and the promise: read the rewrite the NEW way and it has to land in
      // the same register, on the same beat.
      for (const w of spelling) {
        const r = readMarkRuns(w)!;
        const o = markRegister(w, r, f.oct);
        const d = markBeat(w, r, f.dur, f.anchor);
        if (o != null) f.oct = o;
        if (d != null) f.dur = d;
      }
      if ((wantOct != null && f.oct !== wantOct) || (wantDur != null && f.dur !== wantDur)) {
        bad = true; break;
      }
      const next = spelling.join(' ');
      if (next === T) continue;
      let end = tok.start + T.length;
      // A mark that moves nothing has no spelling — it's gone, and takes the
      // space after it so the line doesn't gap.
      if (!next && text[end] === ' ') end++;
      edits.push({ start: tok.start, end, text: next });
    }
    if (bad) break;

    if (held) {
      underOct.set(line.under!, f.oct);
      f = held.f; brackets = held.brackets;
    }
  }
  if (bad || !edits.length) return text;

  let out = '';
  let cur = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    if (e.start < cur) return text;
    out += text.slice(cur, e.start) + e.text;
    cur = e.end;
  }
  return out + text.slice(cur);
}

// One old mark — never a reset; those are handled where they're read — written
// as the moves that land where it landed: nothing at all where it moved
// nothing, one token where one will do, and two — a beat reset and the beat it
// named — where the move has no single spelling. `null` if it can't be written
// at all, which leaves the document alone.
function respell(
  T: string, m: MarkRuns, now: Frame,
  wantOct: number | null, wantDur: number | null,
): string[] | null {
  const octFirst = !!m.oct && (!m.beat || m.oct.from < m.beat.from);
  let oct = '';
  if (wantOct != null) {
    const d = wantOct - now.oct;
    oct = d > 0 ? "'".repeat(d) : d < 0 ? ','.repeat(-d) : '';
  }
  let beat = '';
  if (wantDur != null && wantDur !== now.dur) {
    beat = beatMove(now.dur, wantDur) ?? '';
    if (!beat) {
      // No single move gets there — a dotted beat off a dotted beat is no note
      // value. So the mark says it the way it always said it: back to the beat
      // the passage is in, then the value it named, counted from there.
      const named = T.slice(m.beat!.from, m.beat!.to);
      return [':', octFirst && oct ? oct + named : named + oct];
    }
  }
  return [octFirst ? oct + beat : beat + oct].filter(Boolean);
}

// ── v5 → v6 ──────────────────────────────────────────────────────────
//
// The partial resets have characters of their own now. `\=` was "the beat back
// to the passage's own" and `=,` "the register back to the middle" — a = that
// named its half by the mark it kept company with — and they are `:` and `;`.
// A bare `=` still means both.
//
// What forced it is that a reset is now counted FIRST and the runs move off
// what it left, which is what makes `;,` and `:\` absolute. Under that reading
// `\=` says "both back, then halve", so a document still holding one would
// lose its register silently.
//
// The proof is one token for one token: the old reading ignored the run
// entirely — `\=` and `\\=` both meant "the beat back to the anchor", whatever
// slashes were written — so `:` says all of `\=` and `;` says all of `=,`.
// Nothing else in the alphabet moved, so a document with no = in a standalone
// mark comes through untouched.
function partialResets(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const tok of markTokens(text)) {
    const T = tok.text;
    if (!T.includes('=')) continue;
    const m = readMarkRuns(T);
    if (!m || m.stray || m.dup) continue;
    if (m.beat && m.oct) continue;   // v5 turned this away; it moved nothing
    const next = m.beat ? ':' : m.oct ? ';' : '=';
    if (next !== T) edits.push({ start: tok.start, end: tok.start + T.length, text: next });
  }
  if (!edits.length) return text;

  let out = '';
  let cur = 0;
  for (const e of edits) {
    if (e.start < cur) return text;
    out += text.slice(cur, e.start) + e.text;
    cur = e.end;
  }
  return out + text.slice(cur);
}

// ── v6 → v7 ──────────────────────────────────────────────────────────
//
// `%%%` used to be an ordinary comment — three % where one would do — and it
// now comments out the whole rest of the page. A document that used one as a
// divider would lose everything under it, silently and completely, which is
// the worst shape a change can take.
//
// A space after the first % is all it takes to say "still just a comment":
// `%%%----` becomes `% %%----`, which drew the same line across the page
// before and draws it now. The proof is that a % starts a comment that runs to
// the end of its line in both readings, and the only thing the new one looks
// at past that % is whether the next two characters are % as well.
function spaceOutTripleComments(text: string): string {
  const out: string[] = [];
  let touched = false;
  for (const line of text.split('\n')) {
    const pct = indexOfComment(line);
    if (pct >= 0 && line.startsWith('%%%', pct)) {
      out.push(`${line.slice(0, pct + 1)} ${line.slice(pct + 1)}`);
      touched = true;
    } else out.push(line);
  }
  return touched ? out.join('\n') : text;
}

// The alphabet a standalone mark was written in before v6.
const OLD_MARK = /^[\\/,'=.]+$/;

// Every token in the MUSIC written in that alphabet, in source order. The
// parser decides which lines are music and where each one starts, so a `,` in
// a lyric line, a chord line, a comment, a header or an LP: block is never one
// of these.
function markTokens(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  for (const line of parseJianpu(text).music) {
    let body = text.slice(line.span.start, line.span.end);
    // The X:/T:/B: that opens the line is not a token — blanked rather than cut
    // so every offset after it is still the offset it has in the document.
    const head = /^[ \t]*[XTB]\d*:/.exec(body);
    if (head) body = ' '.repeat(head[0].length) + body.slice(head[0].length);
    for (const tok of tokenize(body, line.span.start)) {
      if (OLD_MARK.test(tok.text)) out.push(tok);
    }
  }
  return out;
}

// The shortest run of \ or / (with dots) that turns `from` into `to`, or null
// where none does. Six halvings is the tick grid end to end, so nothing
// writable is out of reach.
function beatMove(from: number, to: number): string | null {
  for (let len = 1; len <= 9; len++) {
    for (const c of ['\\', '/']) {
      for (let dots = 0; dots <= 3; dots++) {
        const slashes = len - dots;
        if (slashes < 1) continue;
        const spec = c.repeat(slashes);
        if (groupDur(spec, '.'.repeat(dots), from) === to) return spec + '.'.repeat(dots);
      }
    }
  }
  return null;
}
