// Respell a passage into another key centre, keeping every sounding pitch
// exactly where it was.
//
// This is the jazz move the numbers make awkward: the bridge modulates, and
// suddenly the passage you already wrote is spelled against the wrong "1".
// Select it, pick a centre, and the DEGREES are rewritten around the new one —
// 1 2 3 under 1=C becomes 6 7 #1 under 1=Eb, same three pitches. A 1= is
// planted at the head of the selection, the old one restored after it, and any
// modulation the selection swallowed is dropped, since the whole passage now
// reads in one key.
//
// Only the characters that encode a pitch are touched. Durations, dots,
// dashes, ties, slurs, barlines, chord symbols and lyrics come through
// untouched, because a respelling is a change of NOTATION, not of music — and
// the plan is verified by re-parsing before it's offered, so a rewrite that
// would move a note by so much as a semitone is never applied.

import { degreeToSpelling, keyAt, markRegister, parseJianpu, readMarkRuns, sigAccidentals } from './parse';
import { buildEvents } from './playback';
import { KeyPoint, KeySig, Movement, Pitch, Score } from './types';

// Natural pitch class of each letter index (C=0, D=1, … B=6).
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

// ── the pitch maths ──────────────────────────────────────────────────

export type Spelling = { degree: number; octave: number; acc: number };

// The same MIDI note, written against a different 1=.
//
// Every degree of the new key is a candidate, so the answer is chosen rather
// than derived: the fewest written accidentals wins (a diatonic 4 beats a #3),
// then the plainest spelling, then keeping the letter the note already had.
// That's what a player would write, and it's always reachable — the five
// chromatic notes each sit a semitone from a scale tone, so some degree of any
// key can always spell any pitch with one sign.
export function respellPitch(p: Pitch, from: KeySig, to: KeySig): Spelling {
  const { letterPc, acc: totalAcc, midi } = degreeToSpelling(p, from, sigAccidentals(from.sharps));
  const toAcc = sigAccidentals(to.sharps);
  const tonicIdx = LETTER_PC.indexOf(to.tonicLetterPc);

  let best: Spelling | null = null;
  let bestScore = Infinity;
  for (let degree = 1; degree <= 7; degree++) {
    const letterIdx = (tonicIdx + degree - 1) % 7;
    const lpc = LETTER_PC[letterIdx];
    // What this letter needs on it to sound the note at all…
    let need = (((midi - lpc) % 12) + 12) % 12;
    if (need > 6) need -= 12;
    // …minus whatever the new signature already supplies is what gets WRITTEN.
    const acc = need - toAcc[lpc];
    const score = Math.abs(acc) * 10 + Math.abs(need) * 2 + (lpc === letterPc ? 0 : 1);
    if (score >= bestScore) continue;
    const carry = Math.floor((tonicIdx + degree - 1) / 7);
    bestScore = score;
    best = { degree, octave: (midi - lpc - need) / 12 - 5 - carry, acc };
  }
  return best as Spelling;
}

// ── reading a note token apart ───────────────────────────────────────

// One pitch inside a written token, and the characters that spell it.
type Atom = {
  di: number;              // index of the digit
  acci: number;            // index of the # / b / f bound to it, or -1
  accChar: string;
  octis: number[];         // indices of the ' , + - = bound to it
  degree: number;          // 0 for a rest or percussion beat
  shorthand: number;       // 1 when written as 8 or 9
  marks: number;           // net octave marks
  acc: number | null;
  style: OctStyle | null;  // which spelling its marks were written in
  plain: boolean;          // an explicit = said "no octave mark here"
};

// Which spelling of the octave marks a rewritten note should come out in.
export type OctStyle = "'" | '+';

const UP: Record<OctStyle, string> = { "'": "'", '+': '+' };
const DOWN: Record<OctStyle, string> = { "'": ',', '+': '-' };
// The spelling each mark character belongs to.
const MARK_STYLE: Record<string, OctStyle> = { "'": "'", ',': "'", '+': '+', '-': '+' };

// Pull the atoms out of a token exactly the way the parser binds them — an
// accidental leans forward when another digit follows and back otherwise, an
// octave mark leans back onto the digit it sits over. Anything else (durations,
// dots, slashes) is left for the rewriter to copy through.
function scanAtoms(tok: string): Atom[] {
  const out: Atom[] = [];
  let pendAcc: { acc: number; i: number; c: string } | null = null;
  let pendOct: { n: number; is: number[]; style: OctStyle | null; plain: boolean } =
    { n: 0, is: [], style: null, plain: false };
  const digitCount = (tok.match(/[0-9xX]/g) ?? []).length;
  const push = (a: Atom) => { out.push(a); return out.length - 1; };

  for (let i = 0; i < tok.length; i++) {
    const c = tok[i];
    if (c >= '0' && c <= '9') {
      const n = Number(c);
      const degree = n === 0 ? 0 : (n >= 8 ? n - 7 : n);
      const a: Atom = {
        di: i, acci: -1, accChar: '', octis: [], degree,
        shorthand: n >= 8 ? 1 : 0, marks: 0, acc: null, style: null, plain: false,
      };
      if (pendAcc) { a.acc = pendAcc.acc; a.acci = pendAcc.i; a.accChar = pendAcc.c; pendAcc = null; }
      if (pendOct.n || pendOct.is.length) {
        a.marks += pendOct.n;
        a.octis.push(...pendOct.is);
        a.style = a.style ?? pendOct.style;
        a.plain = a.plain || pendOct.plain;
        pendOct = { n: 0, is: [], style: null, plain: false };
      }
      push(a);
      continue;
    }
    if (c === 'x' || c === 'X') {
      push({ di: i, acci: -1, accChar: '', octis: [], degree: 0, shorthand: 0, marks: 0, acc: null, style: null, plain: false });
      continue;
    }
    if (c === '#' || c === 'b' || c === 'f') {
      const acc = c === '#' ? 1 : -1;
      const laterDigit = /[0-9]/.test(tok.slice(i + 1));
      const last = out.length - 1;
      if (laterDigit || last < 0) pendAcc = { acc, i, c };
      else { out[last].acc = acc; out[last].acci = i; out[last].accChar = c; }
      continue;
    }
    if (MARK_STYLE[c]) {
      const step = c === "'" || c === '+' ? 1 : -1;
      const last = out.length - 1;
      if (last >= 0 && digitCount > 0) {
        out[last].marks += step; out[last].octis.push(i); out[last].style ??= MARK_STYLE[c];
      } else {
        pendOct.n += step; pendOct.is.push(i); pendOct.style ??= MARK_STYLE[c];
      }
      continue;
    }
    // A written = is a mark that moves nothing. Track it like the others so a
    // respelling can keep it when the note still needs no octave mark, and
    // replace it when the note now does.
    if (c === '=') {
      const last = out.length - 1;
      if (last >= 0 && digitCount > 0) { out[last].octis.push(i); out[last].plain = true; }
      else { pendOct.is.push(i); pendOct.plain = true; }
      continue;
    }
  }
  return out;
}

// The base octave in force at an offset: ' and , MOVE it from wherever the
// marks before them left it (,, is two octaves down from there), and a = or a
// new movement puts it back to the register the movement started in. Cheap
// enough to re-derive per rewrite, and it means an atom's written octave marks
// can be recovered without the parser's help.
function baseOctaveAt(text: string, offset: number): number {
  let base = 0;
  let at = 0;
  while (at <= offset) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const upto = text.slice(at, Math.min(end, offset));
    // An X: or B: line is a register of its own: it starts in the middle and
    // puts back what it found. So its marks say nothing about the music around
    // it — and the music's marks say nothing about it either.
    if (/^[ \t]*[XB]:/.test(text.slice(at, end))) {
      if (offset <= end) {
        let own = 0;
        for (const m of upto.matchAll(/\S+/g)) own = markBase(m[0], own);
        return own;
      }
    } else {
      for (const m of upto.matchAll(/\S+/g)) base = markBase(m[0], base);
    }
    at = end + 1;
  }
  return base;
}

// Read through the parser's own reader, so a mark that says two things at once
// (`\,` is a beat AND a register) moves the register here exactly as it does
// there — and a mark that names only the beat leaves it alone.
function markBase(t: string, base: number): number {
  if (t === 'NextScore' || t === 'NextPart') return 0;
  const m = readMarkRuns(t);
  if (!m) return base;
  const next = markRegister(t, m, base);
  return next == null ? base : next;
}

function encode(s: Spelling, base: number, accChar: string, style: OctStyle, plain: boolean): string {
  const sign = s.acc > 0 ? '#'.repeat(s.acc) : (accChar === 'f' ? 'f' : 'b').repeat(-s.acc);
  const marks = s.octave - base;
  const oct = marks > 0 ? UP[style].repeat(marks)
    : marks < 0 ? DOWN[style].repeat(-marks)
    : (plain ? '=' : '');
  return sign + String(s.degree) + oct;
}

// Rewrite one token's pitches into `to`, leaving every other character alone.
function retuneToken(tok: string, base: number, from: KeySig, to: KeySig, style: OctStyle): string {
  const atoms = scanAtoms(tok).filter(a => a.degree > 0);
  if (!atoms.length) return tok;
  const byDigit = new Map<number, Atom>();
  const drop = new Set<number>();
  for (const a of atoms) {
    byDigit.set(a.di, a);
    if (a.acci >= 0) drop.add(a.acci);
    for (const i of a.octis) drop.add(i);
  }

  let out = '';
  for (let i = 0; i < tok.length; i++) {
    const a = byDigit.get(i);
    if (a) {
      const p: Pitch = { degree: a.degree, octave: base + a.shorthand + a.marks, acc: a.acc };
      // A note that already spells its octave one way keeps that way; the rest
      // follow whichever spelling the document leans on.
      out += encode(respellPitch(p, from, to), base, a.accChar, a.style ?? style, a.plain);
      continue;
    }
    if (drop.has(i)) continue;
    out += tok[i];
  }
  return out;
}

// ── planning an edit ─────────────────────────────────────────────────

export type RespellPlan = {
  from: number;              // replace [from, to) in the source…
  to: number;
  replacement: string;       // …with this
  // What the caret should end up selecting once it's applied.
  selection: { start: number; end: number };
  notes: number;             // how many note tokens were rewritten
};

export type RespellResult = RespellPlan | { error: string };

const TONIC_RE = /^[1-7]=/;

// Everything a ] closes — tuplets, grace brackets, beat groups (`\[`) and
// scoped declarations (`1=Eb[`). Only used to keep the brackets balanced when a declaration is
// dropped out of the middle of a passage.
const GROUP_OPEN = /^(?:\d+\[|g\/?\[|(?:\\+|\/+|[hdsqec])\.*\[|(?:[1-7]|K)=[A-Ga-g][#b]*(?:m|min|minor)?\[)$/;
const GROUP_CLOSE = /^\]$/;

// The ] that closes the group opening at `from`, or null when it falls outside
// [from, limit) — in which case the opener isn't ours to remove.
function matchingClose(text: string, from: number, limit: number): { start: number; end: number } | null {
  let depth = 0;
  for (const m of text.slice(from, limit).matchAll(/\S+/g)) {
    const at = from + (m.index ?? 0);
    if (GROUP_OPEN.test(m[0])) depth++;
    else if (GROUP_CLOSE.test(m[0]) && --depth === 0) return { start: at, end: at + m[0].length };
  }
  return null;
}

// Which octave spelling the document already leans on, so notes that gain a
// mark they didn't have gain it in the house style rather than always the
// jianpu-ly one. Only tokens that could be notes are counted, and only ones
// holding a digit — that's what keeps a standalone , or -- out of the tally.
// Inside a note token these characters can't be anything but octave marks.
const NOTEISH_RE = /^[0-9xX#bf',+\-=.\\sqecdh/]+$/;
function docOctStyle(text: string): OctStyle {
  const tally: Record<OctStyle, number> = { "'": 0, '+': 0 };
  for (const m of text.matchAll(/\S+/g)) {
    const t = m[0];
    if (!NOTEISH_RE.test(t) || !/[0-9]/.test(t)) continue;
    for (const c of t) if (MARK_STYLE[c]) tally[MARK_STYLE[c]]++;
  }
  // Ties go to jianpu-ly's spelling, which is also the no-marks-anywhere case.
  const best = (Object.keys(tally) as OctStyle[])
    .reduce((a, b) => (tally[b] > tally[a] ? b : a), "'");
  return best;
}

// A declaration reads badly stranded inside a group — "3[ q1 1=C q2 ]" or
// "R{ 1=C 1 2 }" — so the two helpers below step it out past whatever opens
// or closes around the note it belongs to, without ever leaving the line.
const OPENER = /(R\d*\{|A\{|\d+\[|g\/?\[|(?:\\+|\/+|[hdsqec])\.*\[|\|:|\||\\bar\s+"[^"]*")[ \t]*$/;
const CLOSER = /^[ \t]*(\]|\}|:\||\||\\bar\s+"[^"]*")/;

export function beforeOpeners(text: string, at: number, limit: number): number {
  let p = at;
  for (;;) {
    const head = text.slice(limit, p);
    const m = OPENER.exec(head);
    if (!m || /\n/.test(head.slice(m.index))) return p;
    p = limit + m.index;
  }
}

export function afterClosers(text: string, at: number, limit: number): number {
  let p = at;
  for (;;) {
    const m = CLOSER.exec(text.slice(p, limit));
    if (!m || /\n/.test(m[0])) return p;
    p += m[0].length;
  }
}

// Widen a selection to whole whitespace-delimited tokens — half a token
// rewritten is half a token wrong.
export function snap(text: string, start: number, end: number): [number, number] {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return [s, e];
}

// Every note token the parser found, in source order — including the grace
// notes hanging off them, which are note tokens like any other and read
// against the key exactly as their neighbours do. `pitched` drops the rests
// and percussion beats — they have nothing to respell, and a selection holding
// only those has no business planting a key declaration.
function noteSpans(score: Score, pitched = false, withBass = false): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const mv of score.movements) {
    // The under-staves' degrees read against the same 1= the melody's do, so a
    // respell has to renumber them too — otherwise the staves underneath go on
    // reading against a key that isn't there any more.
    for (const it of withBass ? [...mv.items, ...mv.unders.flatMap(u => u.items)] : mv.items) {
      if (it.kind !== 'note' || it.src.end <= it.src.start) continue;
      if (it.grace) for (const g of it.grace) out.push(g.src);
      if (pitched && !it.pitches.length) continue;
      out.push(it.src);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Is there anything here to respell? Asked on every selection change, so it
// stays on the parse that's already been done — no re-parsing, no allocation
// beyond the span list.
export function hasNotesIn(text: string, score: Score, selStart: number, selEnd: number): boolean {
  const [s, e] = snap(text, selStart, selEnd);
  return e > s && noteSpans(score, true).some(n => n.start >= s && n.end <= e);
}

export function planRespell(
  text: string, score: Score, selStart: number, selEnd: number, target: KeySig,
): RespellResult {
  const [s, e] = snap(text, selStart, selEnd);
  if (e <= s) return { error: 'nothing selected' };

  const notes = noteSpans(score, false, true).filter(n => n.start >= s && n.end <= e);
  // Whether there's anything to respell is asked of the MUSIC alone: a
  // declaration is global, so planting one to renumber a bass line on its own
  // would quietly renumber the tune above it as well.
  const pitched = noteSpans(score, true).filter(n => n.start >= s && n.end <= e);
  if (!pitched.length) return { error: 'no notes in the selection' };

  const here = keyAt(score.keys, s);
  // Declarations of a tonic inside the selection: the passage becomes one key,
  // so they go. A K= is left alone — that one is about what gets PRINTED.
  const inner = score.keys.filter(k =>
    k.span && k.span.start >= s && k.span.start < e && TONIC_RE.test(text.slice(k.span.start, k.span.end)));

  // Rewrite the region piece by piece, copying everything between the pieces.
  const style = docOctStyle(text);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const n of notes) {
    const from = keyAt(score.keys, n.start).key;
    if (from.label === target.label) continue;
    const tok = text.slice(n.start, n.end);
    edits.push({ ...n, text: retuneToken(tok, baseOctaveAt(text, n.start), from, target, style) });
  }
  // Dropped declarations take the space after them, so the line doesn't gap.
  // A scoped one (`1=Eb[`) takes its closing ] as well — half a group left
  // behind would reopen the key it was meant to remove.
  for (const k of inner) {
    const from = k.span!.start;
    let end = k.span!.end;
    let close: { start: number; end: number } | null = null;
    if (text[end - 1] === '[') {
      close = matchingClose(text, from, e);
      if (!close) continue;   // the group runs past the selection — leave it whole
    }
    while (end < e && text[end] === ' ') end++;
    edits.push({ start: from, end, text: '' });
    if (close) {
      let cs = close.start;
      while (cs > end && text[cs - 1] === ' ') cs--;
      edits.push({ start: cs, end: close.end, text: '' });
    }
  }
  // The new centre goes in front of the first note and the one that was
  // running at the end is restored after the last — against the NOTES rather
  // than the selection's edges, because a chord line or an L: has to keep the
  // whole line to itself, and a selection can easily start or end on one.
  // Anchored on the first and last NOTE — rests included. A passage that opens
  // on a couple of rests still opens there, and a declaration parked after them
  // reads as though it started mid-phrase.
  const head = here.key.label === target.label ? '' : target.label + ' ';
  const headAt = beforeOpeners(text, notes[0].start, s);
  if (head) edits.push({ start: headAt, end: headAt, text: head });

  const tailKey = keyAt(score.keys, e - 1).key;
  const after = noteSpans(score, false, true).find(n => n.start >= e);
  const redeclared = score.keys.some(k =>
    k.span && k.span.start >= e && (!after || k.span.start < after.start)
    && TONIC_RE.test(text.slice(k.span.start, k.span.end)));
  const tailAt = afterClosers(text, notes[notes.length - 1].end, e);
  const tail = after && !redeclared && tailKey.label !== target.label ? ' ' + tailKey.label : '';
  if (tail) edits.push({ start: tailAt, end: tailAt, text: tail });

  // Zero-width inserts sort before the edit that starts at the same place, so
  // a declaration lands in front of the note it introduces.
  edits.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));

  let replacement = '';
  let cur = s;
  for (const ed of edits) {
    if (ed.start < cur) continue;          // defensive: never overlap
    replacement += text.slice(cur, ed.start) + ed.text;
    cur = ed.end;
  }
  replacement += text.slice(cur, e);
  if (replacement === text.slice(s, e)) return { error: `already in ${target.label}` };

  // Verify before offering it: the whole point is that nothing moves. Re-parse
  // the would-be document and compare what it sounds, note for note.
  const next = text.slice(0, s) + replacement + text.slice(e);
  if (!sameMusic(text, next)) return { error: 'that would change the notes — left alone' };

  return {
    from: s, to: e, replacement,
    // Leave the new declaration inside the selection but the restored one
    // out of it: respelling the same passage again then sweeps its own
    // declaration up and replaces it, instead of stacking a dead 1= in front
    // of a live one.
    selection: { start: s, end: s + replacement.length },
    notes: notes.length,
  };
}

// Every note of every movement, as pitch + time, so a respelling can prove it
// left the music alone.
function fingerprint(text: string): string {
  const score = parseJianpu(text);
  // buildEvents only plays the voices the mix knows about, so the staves
  // underneath are fingerprinted here as well — a respell renumbers them and
  // has to prove it left the SOUND alone there too. Each note is read against
  // the key in force where it was written, which is exactly what the engraver
  // does with it.
  const under = (mv: Movement) => mv.unders.map(u => u.id + ':' + u.items.map(i => {
    if (i.kind !== 'note') return 'm';
    const key = keyAt(score.keys, i.src.start).key;
    const sig = sigAccidentals(key.sharps);
    return `${i.dur}:${i.pitches.map(p => degreeToSpelling(p, key, sig).midi).join(',')}`;
  }).join(' ')).join(' | ');
  return score.movements
    .map(mv => buildEvents(mv).events.map(ev => `${ev.midi}@${ev.at.toFixed(4)}:${ev.dur.toFixed(4)}`).join(' ')
      + ' /b/ ' + under(mv))
    .join(' // ');
}

function sameMusic(a: string, b: string): boolean {
  try { return fingerprint(a) === fingerprint(b); } catch { return false; }
}

// The distinct key centres a document uses, in the order they turn up — the
// ones worth offering as one-click targets.
export function keyChoices(keys: KeyPoint[]): KeySig[] {
  const seen = new Set<string>();
  const out: KeySig[] = [];
  for (const k of keys) {
    if (seen.has(k.key.label)) continue;
    seen.add(k.key.label);
    out.push(k.key);
  }
  return out;
}
