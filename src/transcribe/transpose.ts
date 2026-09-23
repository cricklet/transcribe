// Transpose a passage by semitones — the music MOVES, and every name on the
// page is rewritten to say where it went. Select the whole text and that's the
// whole chart; select a bridge and it's the bridge, with the key it interrupted
// put back after it.
//
// This is the other half of retune.ts's trade, and it shares that file's menu:
// a respelling keeps the pitches and moves the numbers, a transposition keeps
// the numbers and moves the pitches. Numbered notation makes the edit small and
// total at once — the degrees are already relative, so 1 2 3 is 1 2 3 in any
// key, and the only characters that have to change are the ones naming an
// absolute pitch: every 1= and K= declaration, every chord symbol on a C" line
// or in a chords= block, every note written by NAME rather than by number
// (`f#\` is an F sharp wherever the key goes, so that one moves too), and the
// register the passage is read in.
//
// ── which key it lands in
// That's a decision, not a calculation. Up a semitone from C is Db, not C#,
// because Db is five flats and C# is seven; up a semitone from B is C, not B#.
// The rule is the circle of fifths: a semitone up is seven steps clockwise, so
// the new signature is fixed mod 12, and what's left is choosing between the
// two spellings sitting twelve steps apart. Fewer accidentals wins, and a tie
// (F# and Gb, six each) goes the way the chart already leaned — a sharp piece
// stays sharp, and everything else takes the flat, which is where a horn chart
// lives anyway.
//
// Every other name then moves by the same GENERIC interval the key did. C→Db
// is "up a letter and a semitone", so F#7 becomes G7 rather than Gb7 and Bb7
// becomes Cb7 — one letter up, always, which is what keeps a chart's spelling
// internally consistent instead of a bag of enharmonics. A modulation gets its
// own reading of the same distance (Ab up a semitone is A, not Bbb), because a
// double flat on the page helps nobody; and a chord root that still comes out
// doubly altered is quietly spelled the plain way.
//
// ── and the register
// The part numbered notation makes surprising. Degree 1 always sits in the
// octave that starts at middle C, so 1=C and 1=B are a semitone apart on paper
// and a major seventh apart in sound. Transposing down a semitone therefore has
// to say "and an octave lower" as well — a standalone , at the head of the
// music — or the tune leaps up a seventh. That mark is planted wherever the
// sounding octave would otherwise be wrong, and any mark the document already
// carries is moved to match.
//
// ── and nothing goes in unverified
// The rewritten document is re-parsed and compared with the original: every
// note inside the passage has to have moved by exactly the semitones asked for,
// every chord with them, every note OUTSIDE it not at all, and the lyrics,
// headers and comping rhythm nowhere near any of it. Anything else and the edit
// is refused rather than applied.

import { MarkRuns, keyAt, markOk, markRegister, parseJianpu, readMarkRuns, tokenize } from './parse';
import { buildEvents } from './playback';
import { afterClosers, beforeOpeners, snap } from './retune';
import { KeySig, Movement, Score, Span } from './types';

// ── the circle of fifths ─────────────────────────────────────────────

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const LETTER_NAME = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// The letters in fifths order, which is also the order sharps arrive in (and,
// backwards, flats). C sits at index 1, so a signature of `s` sharps names the
// letter at (s + 1) mod 7, carrying floor((s + 1) / 7) sharps of its own.
const FIFTHS = 'FCGDAEB';

const mod = (a: number, b: number) => ((a % b) + b) % b;

// The accidental that turns a letter into a pitch, read the short way round —
// so B against pitch class 0 is a sharp rather than eleven flats.
function alter(pc: number, letterIdx: number): number {
  let a = mod(pc - LETTER_PC[letterIdx], 12);
  if (a > 6) a -= 12;
  return a;
}

// The signature a transposition lands in. Up a semitone is seven steps
// clockwise round the circle, which pins the answer mod 12; the two candidates
// that leaves are enharmonics of each other (C# / Db), and the one with fewer
// accidentals is the one to write. `lean` breaks the six-a-side tie: +1 keeps
// to the sharp end, anything else takes the flat.
//
// It's asked of the signature the page is READ against — the K= where there is
// one, and the 1= otherwise; see moveFor.
function targetSharps(sharps: number, semitones: number, lean: number): number {
  const up = mod(sharps + 7 * semitones, 12);       // 0…11
  const down = up - 12;                             // …the same key, spelled the other way
  if (Math.abs(down) > 7) return up;
  if (Math.abs(up) > 7) return down;
  if (up !== -down) return Math.abs(up) < Math.abs(down) ? up : down;
  return lean > 0 ? up : down;
}

// The tonic a signature belongs to: `sharps` steps clockwise from C.
function tonicOf(sharps: number): { letter: string; acc: number } {
  return { letter: FIFTHS[mod(sharps + 1, 7)], acc: Math.floor((sharps + 1) / 7) };
}

// How far a transposition moves a NAME: so many letters up the alphabet, so
// many semitones up in sound. Keeping the two apart is what spells the answer —
// C up "one letter and one semitone" is Db; up "no letters and one semitone" it
// would have been C#.
type Move = {
  letters: number;      // 0…6
  semis: number;        // 0…11
  // Octaves the written music has to be pushed by on top of that, because do
  // has landed on the far side of the C the register is counted from.
  octave: number;
};

// The printed signature, as the parser reports it.
type PrintKey = { name: string; sharps: number };

// Where do's own signature lands: from the printed one, kept the same distance
// round the circle from it that it was written at. A do that would need a
// double accidental means the two signatures aren't the pair of a key and its
// printed self at all (a K= naming something unrelated), and the passage falls
// back to reading its own 1= — one strange declaration is better than a
// document rewritten into double flats.
function sharpsFor(key: KeySig, semitones: number, lean: number, print?: PrintKey | null): number {
  if (!print) return targetSharps(key.sharps, semitones, lean);
  const from = targetSharps(print.sharps, semitones, lean) + (key.sharps - print.sharps);
  return Math.abs(tonicOf(from).acc) > 1 ? targetSharps(key.sharps, semitones, lean) : from;
}

// The accidental a key's own tonic carries.
function tonicAcc(key: KeySig): number {
  return alter(key.tonicPc, LETTER_PC.indexOf(key.tonicLetterPc));
}

// Read one key's move: where its do goes, and what that does to the register.
// Cb is a pitch of −1 here and B# is 12 — the point is exactly that they aren't
// 11 and 0, since that difference is the octave the notes have to make up.
//
// `print` is the K= in force, when the page prints a signature of its own. The
// enharmonic choice is then made from THAT — it's the signature being read, and
// the one the K= rewrite makes its own decision from — and do is spelled the
// same number of fifths away from it as it was written. Otherwise the two
// declarations decide separately and can land on opposite sides of the circle:
//
//   K=Bb 1=G   — the way a minor piece is written here, G minor on 2 flats
//   up a semitone, deciding twice:  K=B (5 sharps) with 1=Ab (4 flats)
//   …and deciding once:             K=B             with 1=G#
//
// The first is unreadable — a signature in sharps with do named in flats, every
// chord over it spelled A♭m against five sharps. The second is the key a
// copyist would write: G♯ minor, because A♭ minor is seven flats.
function moveFor(key: KeySig, semitones: number, lean: number, print?: PrintKey | null): Move {
  const fromIdx = LETTER_PC.indexOf(key.tonicLetterPc);
  const to = tonicOf(sharpsFor(key, semitones, lean, print));
  const toIdx = LETTER_NAME.indexOf(to.letter);
  const rose = (LETTER_PC[toIdx] + to.acc) - (LETTER_PC[fromIdx] + tonicAcc(key));
  return {
    letters: mod(toIdx - fromIdx, 7),
    semis: mod(semitones, 12),
    octave: (semitones - rose) / 12,
  };
}

// One written note name, moved. The letter steps first and the accidental is
// then whatever makes that letter sound right — which is how a transposition
// stays diatonic to itself instead of reaching for the nearest black key.
function moveName(letter: string, acc: number, mv: Move): { letter: string; acc: number } {
  const i = LETTER_NAME.indexOf(letter.toUpperCase());
  const j = mod(i + mv.letters, 7);
  return { letter: LETTER_NAME[j], acc: alter(mod(LETTER_PC[i] + acc + mv.semis, 12), j) };
}

// A root that comes out doubly altered (Fbb, G##) is nobody's idea of a chord
// symbol — the letter is there to be read off a page in a hurry. Fall back to
// the plainest spelling of the same pitch, taking the side of the circle the
// chart is already on when the choice is between F# and Gb.
function plainest(name: { letter: string; acc: number }, lean: number): { letter: string; acc: number } {
  if (Math.abs(name.acc) < 2) return name;
  const pc = mod(LETTER_PC[LETTER_NAME.indexOf(name.letter)] + name.acc, 12);
  let best = name;
  for (let j = 0; j < 7; j++) {
    const a = alter(pc, j);
    const closer = Math.abs(a) - Math.abs(best.acc);
    if (closer < 0 || (closer === 0 && a * lean > best.acc * lean)) best = { letter: LETTER_NAME[j], acc: a };
  }
  return best;
}

// The same, for a chord ROOT. A note can honestly be an E# — in a sharp key
// that's what the letter under the accidental is — but no chart has ever said
// E#7 or Cb9: a symbol is read off the page at speed, so a root that lands on
// a white key gets that white key's name. Roots only; the letter notes and the
// key declarations keep their diatonic spelling, where it's the right answer.
function chordRoot(name: { letter: string; acc: number }, lean: number): { letter: string; acc: number } {
  const plain = plainest(name, lean);
  if (plain.acc === 0) return plain;
  const nat = LETTER_PC.indexOf(mod(LETTER_PC[LETTER_NAME.indexOf(plain.letter)] + plain.acc, 12));
  return nat >= 0 ? { letter: LETTER_NAME[nat], acc: 0 } : plain;
}

function accStr(acc: number, sharp = '#', flat = 'b'): string {
  return acc > 0 ? sharp.repeat(acc) : flat.repeat(-acc);
}

function accOf(s: string): number {
  return (s.match(/[#♯]/g)?.length ?? 0) - (s.match(/[b♭]/g)?.length ?? 0);
}

// ── chord symbols ────────────────────────────────────────────────────

// A symbol opens on a note name and everything after it is quality — but only
// if that quality is made of the things a quality is made of. The check is what
// keeps a word that merely STARTS like a chord (Bridge, Coda, Fine) from being
// transposed into nonsense.
const ROOT_RE = /^([A-Ga-g])([#b♯♭]*)(.*)$/;
const QUALITY_RE = /^(?:maj|MAJ|Maj|min|Min|mi|sus|add|alt|dim|aug|omit|no|M|m|o|ø|Δ|°|\+|-|\d|[#b♯♭^*()[\], ])*$/;
// Brackets and quotes a symbol may be wearing, which travel with it untouched.
const WRAP_RE = /^([("[]*)(.*?)([)\]"]*)$/;

// A symbol pulled apart: root, quality, and the slash bass if there is one.
// `/9` is a voicing rather than a bass note, so anything after the slash that
// isn't a note name stays part of the quality.
type Chord = { wrap: [string, string]; letter: string; accs: string; qual: string; bass: Chord | null };

function readChord(sym: string): Chord | null {
  const w = WRAP_RE.exec(sym);
  if (!w) return null;
  const m = ROOT_RE.exec(w[2]);
  if (!m) return null;
  const cut = m[3].indexOf('/');
  const qual = cut < 0 ? m[3] : m[3].slice(0, cut);
  if (!QUALITY_RE.test(qual)) return null;
  const bass = cut < 0 ? null : readChord(m[3].slice(cut + 1));
  return {
    wrap: [w[1], w[3]],
    letter: m[1], accs: m[2],
    qual: bass ? qual : m[3],
    bass,
  };
}

function writeChord(c: Chord): string {
  return c.wrap[0] + c.letter + c.accs + c.qual + (c.bass ? '/' + writeChord(c.bass) : '') + c.wrap[1];
}

// Move one chord symbol. The accidental style it was written in is the style it
// comes back in, so a chart set in ♯/♭ stays that way.
function moveChord(sym: string, mv: Move, lean: number): string {
  const c = readChord(sym);
  if (!c) return sym;
  const step = (part: Chord): Chord => {
    const to = chordRoot(moveName(part.letter, accOf(part.accs), mv), lean);
    return {
      ...part,
      letter: part.letter === part.letter.toLowerCase() ? to.letter.toLowerCase() : to.letter,
      accs: accStr(to.acc, /♯/.test(part.accs) ? '♯' : '#', /♭/.test(part.accs) ? '♭' : 'b'),
      bass: part.bass ? step(part.bass) : null,
    };
  };
  return writeChord(step(c));
}

// The pitch class a symbol's root names, and everything about it a
// transposition must NOT change — for checking the rewrite afterwards.
function chordPc(sym: string): number | null {
  const c = readChord(sym);
  return c ? mod(LETTER_PC[LETTER_NAME.indexOf(c.letter.toUpperCase())] + accOf(c.accs), 12) : null;
}

function chordShape(sym: string): string {
  const c = readChord(sym);
  if (!c) return sym;
  const root = chordPc(sym) ?? 0;
  const bass = c.bass ? `/${mod((chordPc(writeChord(c.bass)) ?? 0) - root, 12)}` : '';
  return c.qual + bass;
}

// ── LilyPond chordmode roots ─────────────────────────────────────────
// The chords= block writes its roots in Dutch — cis, ees, aes — so they move in
// the alphabet they were written in.

const LY_RE = /^([a-g])((?:is|es|s)*)(.*)$/;

function moveLyChord(word: string, mv: Move, lean: number): string {
  const m = LY_RE.exec(word);
  if (!m) return word;
  let acc = 0;
  let alt = m[2];
  while (alt) {
    if (alt.startsWith('is')) { acc++; alt = alt.slice(2); }
    else if (alt.startsWith('es')) { acc--; alt = alt.slice(2); }
    else if (alt === 's' && (m[1] === 'a' || m[1] === 'e')) { acc--; alt = ''; }
    else return word;                       // not a spelling we know — left alone
  }
  const to = chordRoot(moveName(m[1], acc, mv), lean);
  return to.letter.toLowerCase() + (to.acc > 0 ? 'is'.repeat(to.acc) : 'es'.repeat(-to.acc)) + m[3];
}

// ── letter notes ─────────────────────────────────────────────────────
// The other way this syntax writes a pitch: by name rather than by number —
// `c`, `f#`, `a,`, `bb\`. Numbers are relative and transpose by themselves the
// moment the 1= moves; a letter is ABSOLUTE and doesn't, so it's the one kind
// of note whose own characters have to be rewritten.
//
// Two things can push it off its octave, and both are made up on the note. The
// letter can cross the C the register is counted from (b up a tone is c#, which
// on paper is a seventh DOWN), and the passage as a whole may have been pushed
// an octave to keep its do in place — a mark that moves every note on the line,
// this one included. What comes out is the note that sounds exactly `semitones`
// from where it started, and never a double accidental, which this syntax has
// no way to read.

const LETTER_STEP: Record<string, number> = { "'": 1, '+': 1, ',': -1, '-': -1 };

function moveLetterNote(
  tok: string, mv: Move, semitones: number, octave: number, lean: number,
): string {
  const at = tok.search(/[A-Ga-g]/);
  if (at < 0) return tok;
  const letter = tok[at];
  let acc = 0;          // # and b/f, which bind to the one letter wherever they sit
  let marks = 0;        // ' and , — and the + / - spelling of the same
  let plain = false;    // an explicit = said "no octave mark here"
  let signs = false;    // …and which spelling of the marks this token is in
  let rest = '';        // the durations, in the order they were written
  for (let i = 0; i < tok.length; i++) {
    if (i === at) continue;
    const c = tok[i];
    if (c === '#') { acc++; continue; }
    if (c === 'b' || c === 'f') { acc--; continue; }
    if (c === '=') { plain = true; continue; }
    const step = LETTER_STEP[c];
    if (step) {
      marks += step;
      if (c === '+' || c === '-') signs = true;
      continue;
    }
    rest += c;
  }
  const to = plainest(moveName(letter, acc, mv), lean);
  const was = LETTER_PC[LETTER_NAME.indexOf(letter.toUpperCase())] + acc;
  const now = LETTER_PC[LETTER_NAME.indexOf(to.letter)] + to.acc;
  const total = marks + (was + semitones - 12 * octave - now) / 12;
  const cased = letter === letter.toLowerCase() ? to.letter.toLowerCase() : to.letter;
  // …in whichever spelling of "flat" this token used — but the letter itself
  // is not one of them, or every f would come back saying it was flattened.
  const accs = accStr(to.acc, '#', /f/.test(tok.slice(0, at) + tok.slice(at + 1)) ? 'f' : 'b');
  const oct = total > 0 ? (signs ? '+' : "'").repeat(total)
    : total < 0 ? (signs ? '-' : ',').repeat(-total)
    : (plain ? '=' : '');
  return cased + accs + oct + rest;
}

// ── register marks ───────────────────────────────────────────────────
// A standalone mark says one thing about the beat (\ or /) and one about the
// register (' or ,), in either order, over an optional reset — `;` the
// register back to the middle, `:` the beat, `=` both. Only the register half
// is ours. It's read through the parser's own reader (readMarkRuns), so what a
// token says here is what it says there.
//
// The marks MOVE the register rather than set it, so a rewrite is arithmetic
// against the register the rewritten text has in force at that point — not a
// number the token can carry on its own. That's what `now` is for below.

// Whether this mark says anything about the register at all.
function namesRegister(m: MarkRuns): boolean {
  if (!markOk(m)) return false;
  return !!m.oct || (!!m.reset && m.reset.what !== 'beat');
}

// The mark that moves the register by `n` and says nothing else. A move of
// nothing has no spelling — there's no mark for "stay" — so callers check.
function shiftToken(n: number): string {
  return n > 0 ? "'".repeat(n) : n < 0 ? ','.repeat(-n) : '';
}

// The same mark, rewritten to leave the register at `want` when the register in
// force before it is `now`, and saying whatever it already said about the beat.
// Comes back empty when the mark had nothing left to say — the caller deletes
// the token.
//
// A reset is counted before the moves are, so the register the move starts from
// is the middle one whenever the reset touched it, and `now` otherwise. Every
// part keeps its place in the token: the reset it was written with stays (it
// says something about the beat too, often enough), and the register move is
// simply rewritten to land where the transposition wants it.
function withRegister(tok: string, m: MarkRuns, now: number, want: number): string {
  const head = m.reset ? tok[m.reset.at] : '';
  const beat = m.beat ? tok.slice(m.beat.from, m.beat.to) : '';
  const from = m.reset && m.reset.what !== 'beat' ? 0 : now;
  return head + beat + shiftToken(want - from);
}

// ── the plan ─────────────────────────────────────────────────────────
// Shaped exactly like a respelling, and applied by the same code: replace
// [from, to) with `replacement`, then leave the caret holding `selection` so
// the passage is ready for another go. The two live side by side in the menu
// over a selection, which is the only place either of them makes sense — a
// transposition is a thing you do to a PASSAGE, and selecting the lot is how
// you say "the whole chart".

export type TransposePlan = {
  from: number;
  to: number;
  replacement: string;
  selection: { start: number; end: number };
  key: string;           // what the passage is in now, for the history label
  notes: number;         // …how many notes moved
  chords: number;        // …and how many chord symbols went with them
};

export type TransposeResult = TransposePlan | { error: string };

type Edit = { start: number; end: number; text: string };

const KEY_RE = /^([1-7])=([A-Ga-g])([#b]*)(\[?)$/;
const PRINT_KEY_RE = /^K=([A-Ga-g])([#b]*)(m|min|minor)?(\[?)$/;
const TONIC_RE = /^[1-7]=/;
// A note written by name — the parser's own test, so the two always agree on
// what counts as one.
const LETTER_NOTE = /^[',+\-=]*[A-Ga-g][#bf',+\-=.\\sqecdh/]*$/;
const LIMIT = 24;      // two octaves, past anything a chart asks for

function leanOf(key: KeySig, print?: PrintKey | null): number {
  return Math.sign(print ? print.sharps : key.sharps) || Math.sign(key.sharps) || -1;
}

// How a key would be declared after a move: `1=` and wherever do landed.
function declFor(key: KeySig, mv: Move): string {
  const to = moveName(LETTER_NAME[LETTER_PC.indexOf(key.tonicLetterPc)], tonicAcc(key), mv);
  return `1=${to.letter}${accStr(to.acc)}`;
}

// What a key would be CALLED after the move — the name a player uses, which
// for a minor piece is la's rather than do's.
export function movedKeyName(key: KeySig, semitones: number, print?: PrintKey | null): string {
  if (!semitones) return key.name;
  const mv = moveFor(key, semitones, leanOf(key, print), print);
  const doIdx = LETTER_PC.indexOf(key.tonicLetterPc);
  const laIdx = mod(doIdx + 5, 7);
  const from = key.minor
    ? { letter: LETTER_NAME[laIdx], acc: alter(mod(key.tonicPc + 9, 12), laIdx) }
    : { letter: LETTER_NAME[doIdx], acc: tonicAcc(key) };
  const to = moveName(from.letter, from.acc, mv);
  return `${to.letter}${accStr(to.acc)}${key.minor ? 'm' : ''}`;
}

// Every note token of the music, in source order — the grace notes hanging off
// them included, since inside `g[ … ]` they are ordinary note tokens and move
// exactly as the notes around them do. `pitched` drops the rests and
// percussion beats: they have nothing to transpose, and a selection holding
// only those has no business planting a key declaration.
function noteSpans(score: Score, pitched = false): Span[] {
  const out: Span[] = [];
  for (const mv of score.movements) {
    for (const it of mv.items) {
      if (it.kind !== 'note' || it.src.end <= it.src.start) continue;
      if (it.grace) for (const g of it.grace) out.push(g.src);
      if (pitched && !it.pitches.length) continue;
      out.push(it.src);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// A hold dash belongs to the note before it, so "after the last note" has to
// step over any that follow — a key put between a note and its own dashes reads
// as though the held note were doing something.
function pastHolds(text: string, at: number, limit: number): number {
  let p = at;
  for (;;) {
    const m = /^[ \t]*-+(?=\s|$)/.exec(text.slice(p, limit));
    if (!m) return p;
    p += m[0].length;
  }
}

// The key regions holding at least one note that reads against the key rather
// than naming itself: a number rather than a letter. Grace notes count — they
// are note tokens like any other, and read against the key the same way.
function numberedRegions(text: string, score: Score): Set<number> {
  const out = new Set<number>();
  const notes = new Set<number>();
  for (const mv of score.movements) {
    // The staves underneath count: their degrees read against the key exactly
    // as the melody's do, and they move when the 1= does.
    for (const it of [...mv.items, ...mv.unders.flatMap(u => u.items)]) {
      if (it.kind !== 'note' || it.src.end <= it.src.start) continue;
      if (it.grace) for (const g of it.grace) notes.add(g.src.start);
      if (it.pitches.length) notes.add(it.src.start);
    }
  }
  for (const line of score.music) {
    if (line.under?.startsWith('X')) continue;   // a rhythm staff has no degrees
    for (const t of tokenize(text.slice(line.span.start, line.span.end), line.span.start)) {
      if (notes.has(t.start) && !LETTER_NOTE.test(t.text)) out.add(keyAt(score.keys, t.start).at);
    }
  }
  return out;
}

export function planTranspose(
  text: string, score: Score, selStart: number, selEnd: number, semitones: number,
): TransposeResult {
  const plan = planMove(text, score, selStart, selEnd, semitones, true);
  // A passage that prints its own signature is spelled to agree with it (see
  // moveFor), which can put do far enough round the circle that a degree of its
  // scale would need a double sharp — G♯ minor's is spellable, D♯ minor's isn't.
  // The document then fails its own check rather than going out wrong, and the
  // answer is the older reading: let the 1= choose for itself. A key that
  // disagrees with its signature is worth having over no transposition at all.
  if ('error' in plan) {
    const alone = planMove(text, score, selStart, selEnd, semitones, false);
    if (!('error' in alone)) return alone;
  }
  return plan;
}

function planMove(
  text: string, score: Score, selStart: number, selEnd: number, semitones: number,
  // Whether the K= in force gets to decide the spelling. False re-reads the
  // passage off its 1= alone — see planTranspose.
  usePrint: boolean,
): TransposeResult {
  const printAt = (p: { name: string; sharps: number } | null) => (usePrint ? p : null);
  if (!Number.isFinite(semitones) || !semitones) return { error: 'how many semitones?' };
  if (Math.abs(semitones) > LIMIT) return { error: 'more than two octaves' };
  const [s, e] = snap(text, selStart, selEnd);
  if (e <= s) return { error: 'nothing selected' };

  const all = noteSpans(score);
  const notes = all.filter(n => n.start >= s && n.end <= e);
  const pitched = noteSpans(score, true).some(n => n.start >= s && n.end <= e);
  // A passage of chord symbols over nothing but rests is a chart too — those
  // move on their own, and none of the machinery below that plants keys and
  // register marks has anything to say about them.
  const first = pitched ? notes[0] : null;
  const last = pitched ? notes[notes.length - 1] : null;

  // The passage's own key decides both the name it lands under and which way a
  // six-a-side tie is broken — a sharp piece stays sharp.
  const at = keyAt(score.keys, first ? first.start : s);
  const here = at.key;
  // The lean is the page's own: a chart that prints flats stays in flats.
  const lean = leanOf(here, printAt(at.printKey));
  // Which stretches of the document hold a note written as a NUMBER. Only they
  // need the register pushed when do lands on the far side of the C it's
  // counted from: a note written by NAME carries its own octave, so shifting
  // the line under it just means every one of them has to take it back again.
  const numbered = numberedRegions(text, score);
  const moveAt = (offset: number) => {
    const kp = keyAt(score.keys, offset);
    const mv = moveFor(kp.key, semitones, lean, printAt(kp.printKey));
    return numbered.has(kp.at) ? mv : { ...mv, octave: 0 };
  };
  const inSel = (sp: Span) => sp.start >= s && sp.end <= e;
  // A declaration standing after the last note governs what comes AFTER the
  // passage, so it isn't part of it — and leaving it alone is what lets the
  // same selection be transposed twice without the restored key going with it.
  // With no notes at all there's nothing it could be part of.
  const governs = (at: number) => !!last && at < last.end;

  const edits: Edit[] = [];
  let chords = 0;

  // ── the key declarations ───────────────────────────────────────────
  // A 1= moves by its own reading of the distance: the whole point of a
  // modulation is that it's spelled where it lands. A K= moves by the same rule
  // applied to the signature it prints, minor keys and all.
  for (const kp of score.keys) {
    if (!kp.span || !inSel(kp.span) || !governs(kp.span.start)) continue;
    const tok = text.slice(kp.span.start, kp.span.end);
    const k = KEY_RE.exec(tok);
    if (k) {
      const to = moveName(k[2], accOf(k[3]), moveFor(kp.key, semitones, lean, printAt(kp.printKey)));
      const letter = k[2] === k[2].toLowerCase() ? to.letter.toLowerCase() : to.letter;
      edits.push({ ...kp.span, text: `${k[1]}=${letter}${accStr(to.acc)}${k[4]}` });
      continue;
    }
    const p = PRINT_KEY_RE.exec(tok);
    if (p && kp.printKey) {
      const minor = !!p[3];
      const to = tonicOf(targetSharps(kp.printKey.sharps, semitones, lean) + (minor ? 3 : 0));
      edits.push({ ...kp.span, text: `K=${to.letter}${accStr(to.acc)}${p[3] ?? ''}${p[4]}` });
    }
  }

  // ── the chord symbols ──────────────────────────────────────────────
  // Both spellings of them: the C" line's own characters, and the chords= block
  // written in LilyPond's Dutch. Each moves by the key in force where it sits,
  // so a chord under a modulation is spelled in the key it's heard in.
  const onLines = new Set<string>();
  for (const mv of score.movements) {
    for (const it of mv.items) {
      if (it.kind !== 'mark' || it.mark.t !== 'chordline') continue;
      for (const bar of it.mark.bars) {
        for (const w of bar) {
          onLines.add(`${w.src.start}:${w.src.end}`);
          // A numeral names a function, not a pitch — it moves with the key
          // by itself, and is never rewritten.
          if (!inSel(w.src) || w.roman) continue;
          const next = moveChord(w.sym, moveAt(w.src.start), lean);
          if (next !== w.sym) { edits.push({ ...w.src, text: next }); chords++; }
        }
      }
    }
    for (const c of mv.chords) {
      if (!c.src || !inSel(c.src) || c.roman || onLines.has(`${c.src.start}:${c.src.end}`)) continue;
      const word = text.slice(c.src.start, c.src.end);
      const next = moveLyChord(word, moveAt(c.src.start), lean);
      if (next !== word) { edits.push({ ...c.src, text: next }); chords++; }
    }
  }

  // ── the key, and the register ──────────────────────────────────────
  // Walk the music tracking two registers — the one the source was written in
  // and the one the rewrite has put in force — and, alongside them, whether the
  // passage has said what key it's in yet. A note that would be read against
  // the wrong register gets a mark in front of it; the first note of a passage
  // that never declared a key gets the declaration it was reading implicitly.
  const noteAt = new Set<number>();
  for (const mv of score.movements) {
    for (const it of mv.items) {
      if (it.kind !== 'note' || it.src.end <= it.src.start) continue;
      if (it.grace) for (const g of it.grace) noteAt.add(g.src.start);
      if (it.pitches.length) noteAt.add(it.src.start);
    }
  }
  let base = 0;          // the register as written…
  let now = 0;           // …and as rewritten
  let declared = false;  // has the passage named its key since the last reset?
  let tail = { base: 0, now: 0 };   // where the two stood at the end of it
  for (const line of last ? score.music : []) {
    // A stab line holds the register it found and puts it back after, and has
    // no pitch of its own to correct — so it is neither read nor written to.
    // A pitched staff underneath is stepped over for the first of those
    // reasons alone: its register is its own, so reading its marks here would
    // corrupt the melody's tracking. Its degrees need no rewriting anyway —
    // they move when the 1= does. A letter note down there WOULD need it and
    // doesn't get it; sameBut catches that and refuses.
    if (line.under) continue;
    for (const t of tokenize(text.slice(line.span.start, line.span.end), line.span.start)) {
      const mine = t.start >= s && t.start < e;
      if (t.text === 'NextScore' || t.text === 'NextPart') {
        base = now = 0; declared = false;
        if (mine) tail = { base, now };
        continue;
      }
      const mark = readMarkRuns(t.text);
      if (mark && namesRegister(mark)) {
        base = markRegister(t.text, mark, base)!;
        // Outside the passage the token isn't touched, so it moves the rewritten
        // register exactly as it moves the written one.
        if (!mine) { now = markRegister(t.text, mark, now)!; continue; }
        const want = base + moveAt(t.start).octave;
        const next = withRegister(t.text, mark, now, want);
        let end = t.start + t.text.length;
        // A mark with nothing left to say goes altogether, and takes the space
        // after it so the line doesn't gap.
        if (!next && text[end] === ' ') end++;
        if (next !== t.text) edits.push({ start: t.start, end, text: next });
        now = want;
        tail = { base, now };
        continue;
      }
      if (mine && KEY_RE.test(t.text) && governs(t.start)) { declared = true; continue; }
      if (!noteAt.has(t.start)) continue;
      if (!mine) { now = base; continue; }
      // A note written by name carries its own pitch, so the key moving under
      // it doesn't move IT — the letter has to be rewritten where it stands.
      if (LETTER_NOTE.test(t.text)) {
        const mv = moveAt(t.start);
        const next = moveLetterNote(t.text, mv, semitones, mv.octave, lean);
        if (next !== t.text) edits.push({ start: t.start, end: t.start + t.text.length, text: next });
      }
      // A declaration reads badly stranded inside a bracket or after a barline,
      // so both of these step out past whatever opens around the note.
      const at = beforeOpeners(text, t.start, s);
      if (!declared) {
        edits.push({ start: at, end: at, text: `${declFor(keyAt(score.keys, t.start).key, moveAt(t.start))} ` });
        declared = true;
      }
      const want = base + moveAt(t.start).octave;
      if (want !== now) {
        edits.push({ start: at, end: at, text: `${shiftToken(want - now)} ` });
        now = want;
      }
      tail = { base, now };
    }
  }

  // ── putting back what came after ───────────────────────────────────
  // The passage is in a new key and possibly a new register; the music past the
  // selection is in neither. Both are restored after the last note — unless the
  // source says it again itself before the next note, or there's no next note
  // to say it to.
  const after = last && all.find(n => n.start >= e);
  const outKey = last ? keyAt(score.keys, last.end).key : here;
  const redeclared = last && score.keys.some(k =>
    k.span && k.span.start >= last.end && (!after || k.span.start < after.start)
    && TONIC_RE.test(text.slice(k.span.start, k.span.end)));
  if (last && after) {
    const at = afterClosers(text, pastHolds(text, last.end, e), e);
    const puts: string[] = [];
    if (!redeclared) puts.push(outKey.label);
    if (tail.now !== tail.base) puts.push(shiftToken(tail.base - tail.now));
    if (puts.length) edits.push({ start: at, end: at, text: ` ${puts.join(' ')}` });
  }

  // ── the rewrite ────────────────────────────────────────────────────
  edits.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let replacement = '';
  let cur = s;
  for (const ed of edits) {
    if (ed.start < cur) continue;              // defensive: never overlap
    replacement += text.slice(cur, ed.start) + ed.text;
    cur = ed.end;
  }
  replacement += text.slice(cur, e);
  if (replacement === text.slice(s, e)) {
    return { error: pitched || chords ? 'nothing here to transpose' : 'no notes or chords in the selection' };
  }

  const key = movedKeyName(here, semitones, printAt(at.printKey));
  const next = text.slice(0, s) + replacement + text.slice(e);
  if (!movedBy(text, next, semitones, s, e)) return { error: `couldn’t put this in ${key} — left alone` };

  return {
    from: s, to: e, replacement,
    selection: { start: s, end: s + replacement.length },
    key, notes: notes.length, chords,
  };
}

// ── proving it ───────────────────────────────────────────────────────
// Every note inside the passage moved by exactly the semitones asked for, every
// chord with them, every note OUTSIDE it not at all — and the rhythm, the
// lyrics and the headers nowhere near any of it.

function movedBy(before: string, after: string, semitones: number, s: number, e: number): boolean {
  try {
    const a = parseJianpu(before);
    const b = parseJianpu(after);
    if (b.errors.length > a.errors.length) return false;
    if (a.movements.length !== b.movements.length) return false;
    const shift = (at: number) => (at >= s && at < e ? semitones : 0);
    return a.movements.every((mv, i) => sameBut(mv, b.movements[i], shift));
  } catch {
    return false;
  }
}

function sameBut(a: Movement, b: Movement, shift: (at: number) => number): boolean {
  const sa = buildEvents(a).starts;
  const sb = buildEvents(b).starts;
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) {
    const by = shift(sa[i].start);
    if (sa[i].midis.length !== sb[i].midis.length) return false;
    if (sa[i].midis.some((m, k) => sb[i].midis[k] !== m + by)) return false;
    if (Math.abs(sb[i].at - sa[i].at) > 1e-6 || Math.abs(sb[i].dur - sa[i].dur) > 1e-6) return false;
  }
  if (JSON.stringify(a.lyrics) !== JSON.stringify(b.lyrics)) return false;
  if (JSON.stringify(a.headers) !== JSON.stringify(b.headers)) return false;
  if (a.chords.length !== b.chords.length) return false;
  for (let i = 0; i < a.chords.length; i++) {
    const ca = a.chords[i], cb = b.chords[i];
    if (ca.tick !== cb.tick) return false;
    if (chordShape(ca.sym) !== chordShape(cb.sym)) return false;
    const pa = chordPc(ca.sym), pb = chordPc(cb.sym);
    if (pa == null || pb == null) { if (ca.sym !== cb.sym) return false; continue; }
    if (pb !== mod(pa + shift(ca.src?.start ?? -1), 12)) return false;
  }
  // The staves underneath move with the 1= and are never rewritten
  // themselves, so after a transposition each has to parse to exactly what it
  // parsed to before: the same staves in the same order, the stabs' rhythm
  // untouched, and every degree where it was. A letter note down there would
  // NOT have moved — its degree changes under the new tonic instead — and
  // that shows up here, so the whole rewrite is refused rather than left
  // sounding a step out under the tune.
  const under = (m: Movement) => m.unders.map(u => `${u.id}[${u.items.map(i => (i.kind !== 'note' ? 'm'
    : u.kind === 'stab' ? String(i.dur)
    : `${i.dur}:${i.pitches.map(p => `${p.degree}/${p.octave}/${p.acc ?? '-'}`).join(',')}`)).join(' ')}]`).join('');
  return under(a) === under(b);
}
