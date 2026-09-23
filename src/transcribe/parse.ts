// Parse jianpu-ly source text into a Score.
//
// jianpu-ly (Silas S. Brown, https://github.com/ssb22/jianpu-ly) is a
// preprocessor that turns whitespace-separated "words" into LilyPond. We can't
// run LilyPond in the browser, so this reimplements the input language and the
// ABC builder next door engraves it with abcjs — the same renderer every other
// app on this site uses.
//
// Two things come out of a parse:
//   1. the Score (movements of notes/marks, plus key/meter/tempo/lyrics), and
//   2. a flat list of Annotations — character ranges of the SOURCE tagged with
//      what they mean *in context*. The editor renders one span per annotation
//      for syntax colour and the instant hover hint, so the hint can say
//      "mi · degree 3" rather than just "the character 3".
//
// Anything jianpu-ly accepts that we can't engrave is reported as a warning
// and skipped, never a hard failure — a half-typed line should still render.

import {
  Annotation, AnnClass, ChordSym, ChordWord, Diagnostic, GraceNote, Item, KeyPoint, KeySig, Lyric,
  Movement, MusicLine, NoteItem, Pitch, Pitching, Score, SourceMark, Span, TICKS_PER_CROTCHET,
  TICKS_PER_WHOLE, Under, UnderKind,
} from './types';
import { fromRoman, isRoman } from './roman';

// ── note values ──────────────────────────────────────────────────────
// jianpu-ly's duration prefixes/suffixes, in ticks (semibreve = 128).
const DUR_LETTER: Record<string, number> = {
  h: 2,    // hemidemisemiquaver — 64th
  d: 4,    // demisemiquaver — 32nd
  s: 8,    // semiquaver — 16th
  q: 16,   // quaver — 8th
  e: 16,   // …same thing, for anyone who thinks in "eighth" (not upstream)
  c: 32,   // crotchet — 4th (the explicit form, for use after KeepLength)
};
// The beat inside a grace bracket, and the value a grace note is written as
// when it doesn't say: the quaver every engraver draws a grace note as.
const TICKS_PER_QUAVER = TICKS_PER_CROTCHET / 2;
const DUR_NAME: Record<number, string> = {
  2: 'hemidemisemiquaver', 3: 'dotted hemidemisemiquaver',
  4: 'demisemiquaver', 6: 'dotted demisemiquaver',
  8: 'semiquaver', 12: 'dotted semiquaver',
  16: 'quaver', 24: 'dotted quaver',
  32: 'crotchet', 48: 'dotted crotchet',
  64: 'minim', 96: 'dotted minim',
  128: 'semibreve', 192: 'dotted semibreve', 256: 'breve',
};
// The American names, so the hover hint reads for both vocabularies.
const DUR_US: Record<number, string> = {
  2: '64th', 3: 'dotted 64th',
  4: '32nd', 6: 'dotted 32nd',
  8: '16th', 12: 'dotted 16th',
  16: '8th', 24: 'dotted 8th',
  32: 'quarter', 48: 'dotted quarter',
  64: 'half', 96: 'dotted half',
  128: 'whole', 192: 'dotted whole', 256: 'double whole',
};

// The hint's second clause: "8th note · 1/2 beat".
function durDetail(ticks: number, crotchetsPerBeat: number): string {
  const beats = beatsClause(ticks, crotchetsPerBeat);
  const us = DUR_US[ticks];
  return us ? `${us} note · ${beats}` : beats;
}

// How long a note value is in beats, for the hover hint's second clause.
function beatsClause(ticks: number, crotchetsPerBeat: number): string {
  const beats = ticks / (TICKS_PER_CROTCHET * crotchetsPerBeat);
  if (beats === 1) return '1 beat';
  if (beats < 1) {
    const denom = Math.round(1 / beats);
    if (Math.abs(1 / beats - denom) < 1e-9) return `1/${denom} beat`;
  }
  return `${round2(beats)} beats`;
}
function round2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ── solfège + letters ────────────────────────────────────────────────
const SOLFEGE = ['', 'do', 're', 'mi', 'fa', 'sol', 'la', 'ti'];
// Natural pitch class of each letter index (C=0, D=1, … B=6).
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const LETTER_NAME = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// Position on the circle of fifths of each natural letter, as a major tonic.
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
// Major-scale semitone offsets for degrees 1..7.
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

// The accidental each natural letter carries under a signature of `sharps`
// sharps (negative = flats). Keyed by the letter's natural pitch class, which
// is what melodic-trainer's spellToAbcKeyed expects.
export function sigAccidentals(sharps: number): Record<number, number> {
  const out: Record<number, number> = { 0: 0, 2: 0, 4: 0, 5: 0, 7: 0, 9: 0, 11: 0 };
  const sharpOrder = [5, 0, 7, 2, 9, 4, 11];   // F C G D A E B
  const flatOrder = [11, 4, 9, 2, 7, 0, 5];    // B E A D G C F
  for (let i = 0; i < Math.min(7, Math.abs(sharps)); i++) {
    if (sharps > 0) out[sharpOrder[i]] = 1;
    else out[flatOrder[i]] = -1;
  }
  return out;
}

// A bass staff's home register: a bare `1` on a B: line is the tonic where a
// bass actually plays it, an octave below the one the melody counts from —
// with C as do that's C3, sitting square in the middle of the bass staff. The
// register marks then read against THAT: `,` is an octave below the bass's own
// home, not below the melody's, so the line is readable on its own terms and
// `=` puts it back where it started. Applied to the pitch itself rather than
// through baseOctave, which is exactly what keeps the two independent.
//
// A T: staff is read where the melody is, so its home is the melody's.
const BASS_OCTAVE = -1;

// The under-staff a line opens, from the letter and number it was written
// with: X:, T:, T2: … (treble) and B:, B2: … (bass). A bare letter is number
// one, so T: and T1: are the same staff.
function underOf(letter: string, digits: string): Under {
  const n = digits ? Number(digits) : 1;
  const kind: UnderKind = letter === 'X' ? 'stab' : letter === 'T' ? 'treble' : 'bass';
  return { id: n === 1 ? letter : `${letter}${n}`, kind, n, items: [] };
}

// The order the staves are engraved in: the stabs directly under the music,
// then the treble parts by number, then the bass parts by number.
const UNDER_ORDER: Record<UnderKind, number> = { stab: 0, treble: 1, bass: 2 };
function underRank(u: Under): number { return UNDER_ORDER[u.kind] * 1000 + u.n; }

const DEFAULT_KEY: KeySig = {
  tonicPc: 0, tonicLetterPc: 0, sharps: 0, name: 'C', minor: false, label: '1=C',
};

// ── the parse ────────────────────────────────────────────────────────

type Ctx = {
  ann: Annotation[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  // The M1 M2 … written anywhere in the document — see SourceMark and
  // markWord below. They belong to the TEXT rather than to a movement or a
  // staff, since what they name is a place in the writing.
  marks: SourceMark[];
  // What CONCERT= said, if it said anything — see the directive above. Also a
  // property of the whole text rather than of a movement.
  concert: Pitching;
};

// A numbered place in the source: M1, M2, … up to M99. Recognised in the
// music, on the staves under it and inside a chord chart — everywhere the
// parser reads words — because the spot you want to come back to is as often
// a chord as a note.
const MARK_WORD = /^M(\d+)$/;

// An M written inside a chord chart: which mark, which chord of its bar it
// stands in front of, and where it was written. See MarkItem's chordline.
type ChartCue = { n: number; idx: number; src: number };

// Take a mark if that's what the word is, and say so where it was written.
// Returns the NUMBER when the word was one — null when it wasn't — so each
// caller can drop it from whatever it would otherwise have become, and place
// it if it has somewhere to put it.
function markWord(word: string, span: Span, ctx: Ctx): number | null {
  const m = MARK_WORD.exec(word);
  if (!m) return null;
  const n = Number(m[1]);
  const twice = ctx.marks.find(x => x.n === n);
  if (twice) {
    ctx.warnings.push({ span, msg: `Mark ${n} is set twice — only the first one is jumped to.` });
  }
  ctx.marks.push({ n, span });
  ctx.ann.push({
    ...span, cls: 'mark', label: `mark ${n}`,
    detail: `jumps here from the recording's ${ordinal(n)} bookmark`,
  });
  return n;
}

// An annotation over a run of source, stepping OVER the holes in it. A chord
// line is coloured as one thing, but a % comment and an M1 inside it are not
// that thing and have each said what they are already — and the innermost
// annotation wins, so a hole left uncut would swallow the run around it.
function runsExcept(
  ctx: Ctx, from: number, to: number, holes: Span[],
  a: { label: string; detail?: string; cls: AnnClass },
) {
  let at = from;
  const inside = holes
    .filter(h => h.end > from && h.start < to)
    .sort((x, y) => x.start - y.start);
  for (const h of inside) {
    if (h.start > at) ctx.ann.push({ start: at, end: h.start, ...a });
    at = Math.max(at, h.end);
  }
  if (to > at) ctx.ann.push({ start: at, end: to, ...a });
}

function ordinal(n: number): string {
  const t = n % 100, u = n % 10;
  const suffix = t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

// Something a ] closes. All three are spans that CHANGE HOW THE WORDS INSIDE
// THEM READ — a tuplet scales their durations, a beat group renames the beat,
// a key group renumbers the degrees — so they share one bracket and one stack
// and nest against each other. Slurs are deliberately not in here: a slur is
// something you draw, it keeps its own ( ), and it may cross any of these.
type Group =
  // `prevDur` is set when the opener named a note value too (`3\[ … ]`): the
  // one bracket is both a tuplet and a beat group, so its ] puts back both.
  // `prevAnchor` rides along with it — inside the bracket the group's own beat
  // is what a standalone \ or = counts from, and the ] restores that too.
  | { t: 'tuplet'; span: Span; p: number; items: NoteItem[]; prevDur?: number; prevAnchor?: number }
  | { t: 'dur'; span: Span; prev: number; prevAnchor: number }
  | { t: 'key'; span: Span; prevKey: KeySig; prevPrint: { name: string; sharps: number } | null }
  // Grace notes. The odd one out: the words inside it don't join the music at
  // all — they're collected here and hung on the note that follows the ].
  // It's a bracket like the others because that's the shape a reader already
  // knows, and because it nests: g[ … ] inside a tuplet is still grace notes.
  | { t: 'grace'; span: Span; slash: boolean; notes: GraceNote[] };

// Halve (\) or double (/) a note value once per character of `run`, off
// whatever beat is in force. Clamped at the ends of the tick grid: a
// hemidemisemiquaver below, a breve above.
function scaleDur(base: number, run: string): number {
  let d = base;
  for (let k = 0; k < run.length; k++) {
    d = run[0] === '\\'
      ? Math.max(2, Math.round(d / 2))
      : Math.min(TICKS_PER_WHOLE * 2, d * 2);
  }
  return d;
}

// The beat a `\[` / `3\[` opener sets: slashes count off the beat already in
// force, so a group inside a group halves what its parent set, while a letter
// names a value outright. Trailing dots lengthen it as they do on a note.
export function groupDur(spec: string, dots: string, base: number): number {
  const d = (/[\\/]/.test(spec) ? scaleDur(base, spec) : DUR_LETTER[spec]) * dotFactor(dots.length);
  return Number.isInteger(d) ? d : Math.max(1, Math.round(d));
}

// ── the standalone marks, read ───────────────────────────────────────
//
// A mark standing on its own says one thing about the beat (\ or /) and one
// about the register (' or ,), in either order, and may carry a RESET that the
// runs then count from: `:` puts the beat back to the passage's own, `;` the
// register back to the middle, `=` both at once. It's read as runs of like
// characters, so the two halves can be written either way round and a
// contradiction (`\/`, `,'`) is simply two runs of one kind rather than a
// special case of its own.
//
// Reset then move is what gives a mark absolute footing: `;,` is one octave
// below the middle however far the music had already wandered, and `:\` is a
// quaver whatever beat was running. Relative is still the default, and by far
// the common case — a bare `,` counts off where you are.
//
// Everyone who has to know what a mark says reads it through here — the token
// pass below, the transposer, the respeller and the migration ladder — so
// there is one answer to "is this a mark, and what does it name".
export type ResetWhat = 'both' | 'beat' | 'oct';

export type MarkRuns = {
  beat: { from: number; to: number } | null;   // the \ or / run, and its dots
  oct: { from: number; to: number } | null;    // the , or ' run
  reset: { at: number; what: ResetWhat } | null;   // the = : or ; in it
  stray: boolean;                              // a character naming neither
  dup: boolean;                                // it says one of them twice
};

const RESET_CHAR: Record<string, ResetWhat> = { '=': 'both', ':': 'beat', ';': 'oct' };

export function readMarkRuns(T: string): MarkRuns | null {
  if (!/^[\\/,'=:;.]+$/.test(T) || !/[\\/,'=:;]/.test(T)) return null;
  const m: MarkRuns = { beat: null, oct: null, reset: null, stray: false, dup: false };
  for (let i = 0; i < T.length;) {
    const c = T[i];
    if (c === '\\' || c === '/') {
      let j = i;
      while (j < T.length && T[j] === c) j++;
      while (j < T.length && T[j] === '.') j++;   // \. is a dotted beat
      if (m.beat) m.dup = true; else m.beat = { from: i, to: j };
      i = j;
    } else if (c === ',' || c === "'") {
      let j = i;
      while (j < T.length && T[j] === c) j++;
      if (m.oct) m.dup = true; else m.oct = { from: i, to: j };
      i = j;
    } else if (RESET_CHAR[c]) {
      if (m.reset) m.dup = true; else m.reset = { at: i, what: RESET_CHAR[c] };
      i++;
    }
    else { m.stray = true; i++; }
  }
  return m;
}

// Whether the mark is one that can be read at all: it names each thing at most
// once, and holds nothing that names neither. Two resets (`=;`, `:;`) are one
// of those things said twice — `=` is already how you say "both".
export function markOk(m: MarkRuns): boolean {
  return !m.stray && !m.dup;
}

// Whether the mark's reset — if it has one — touches the register, and whether
// it touches the beat. `=` does both; `;` and `:` one each.
function resetsOct(m: MarkRuns): boolean { return !!m.reset && m.reset.what !== 'beat'; }
function resetsBeat(m: MarkRuns): boolean { return !!m.reset && m.reset.what !== 'oct'; }

// The register a mark leaves in force, given the one that was running: `=` or
// `;` puts it back to the middle, and a run of , or ' MOVES it from wherever
// that left it. `null` when the mark says nothing about the register at all.
export function markRegister(T: string, m: MarkRuns, base: number): number | null {
  if (!markOk(m)) return null;
  const reset = resetsOct(m);
  if (!reset && !m.oct) return null;
  let out = reset ? 0 : base;
  if (m.oct) {
    const n = m.oct.to - m.oct.from;
    out += T[m.oct.from] === ',' ? -n : n;
  }
  return out;
}

// A register in words, for the hint over a mark: where the marks so far have
// left the music, counted from the octave the passage started in.
export function registerName(base: number): string {
  if (!base) return 'back in the middle register';
  const n = Math.abs(base);
  return `now ${n === 1 ? 'an octave' : `${n} octaves`} ${base < 0 ? 'below' : 'above'} it`;
}

// The most BRs one token may stand for. A run this long is already a blank
// page; past it the number is a typo rather than a layout.
const BR_MAX = 32;

// What a reset character says, for the hint that sits over it: the beat it
// puts back is the passage's own, so the name of that value is the useful part.
function resetHint(what: ResetWhat, anchor: number): { label: string; detail?: string; cls: AnnClass } {
  const beatName = DUR_NAME[anchor] ?? `${anchor}/128`;
  if (what === 'oct') return { label: 'back to the middle register', cls: 'octave' };
  if (what === 'beat') return { label: `back to a ${beatName} beat`, cls: 'dur' };
  return { label: 'back to the original', detail: `a ${beatName} beat, middle register`, cls: 'dur' };
}

// …and the beat it leaves in force: `=` or `:` puts back `anchor` — the beat
// the passage itself is in — and the slashes then halve and double from there,
// the dots lengthening the result. `null` when it says nothing about the beat.
export function markBeat(T: string, m: MarkRuns, base: number, anchor: number): number | null {
  if (!markOk(m)) return null;
  const reset = resetsBeat(m);
  if (!reset && !m.beat) return null;
  let out = reset ? anchor : base;
  if (m.beat) {
    const run = T.slice(m.beat.from, m.beat.to);
    const slashes = run.replace(/\./g, '');
    out = groupDur(slashes, run.slice(slashes.length), out);
  }
  return out;
}

// What n dots multiply a note value by. Each one adds half of what the one
// before it added — 3/2, then 7/4, then 15/8 — so they stack the way they do
// on paper rather than compounding (1.5 twice would be 9/4, which is a value
// no dotting can write).
function dotFactor(n: number): number {
  return 2 - Math.pow(2, -n);
}

const DOT_NAME: Record<number, string> = { 1: 'dotted', 2: 'double dotted', 3: 'triple dotted' };

export function parseJianpu(text: string): Score {
  const ctx: Ctx = { ann: [], errors: [], warnings: [], marks: [], concert: 'C' };
  const movements: Movement[] = [];
  let mv = newMovement();
  // Where push() is currently putting things. It's mv.items for the music, and
  // an under-staff's own items for the length of one X:/T:/B: line — see the
  // under-line block below.
  let sink: Item[] = mv.items;

  // Parser state that persists across the tokens of one movement.
  let lastDur = TICKS_PER_CROTCHET;   // for KeepLength
  let keepLength = false;
  // The beat a bare note is written against. A crotchet normally; a standalone
  // \ or / moves it from here on, and a `\[ … ]` group makes it something
  // else for the length of the group.
  let baseDur = TICKS_PER_CROTCHET;
  // …and what a = puts BACK: the beat the passage itself is in — the movement's
  // crotchet, or the group's beat inside a bracket. The marks themselves count
  // off baseDur (a \ halves whatever is running); this is the one fixed point
  // they can be brought home to.
  let beatAnchor = TICKS_PER_CROTCHET;
  let baseOctave = 0;                 // moved by a standalone ' or ,
  let pendingSlurOpen = 0;
  let pendingTie = false;
  let pendingGrace: GraceNote[] | null = null;
  let pendingDecos: string[] = [];
  let pendingAbove: string | undefined;
  let pendingBelow: string | undefined;
  // Every open bracket, innermost last. One ] closes whichever is innermost,
  // so `3[ \[ 1 2 ] q1 ]` reads the way the brackets look.
  const groups: Group[] = [];
  let lastNote: NoteItem | null = null;
  // The key in force as the tokens go by. Until the first note it IS the
  // movement's key (and belongs in the header); after that a declaration is a
  // modulation, and lands in the stream as a mark instead.
  let curKey: KeySig = { ...DEFAULT_KEY };
  let curPrintKey: { name: string; sharps: number } | null = null;
  // Every key in force, in source order, starting with the implicit default.
  const keys: KeyPoint[] = [{ at: 0, span: null, key: curKey, printKey: null }];
  // Every line the token pass reads, in source order. Only a rewriting tool
  // wants this — but only the line pass can say it, since which lines are
  // music is decided here and nowhere else.
  const music: MusicLine[] = [];

  // The register each under-staff is written in, kept across its own lines. A
  // run of B: lines is ONE bass part threaded through the document, not a
  // fresh part per line: a `,` on one line is still in force on the next, the
  // way it is in the music, so a part that lives low says so once. Per staff,
  // so what a T2: line does can't reach the B: line under it. (The beat isn't
  // kept — see the reset below.)
  const underOctave = new Map<string, number>();

  function resetMovementState() {
    sink = mv.items;
    underOctave.clear();
    lastDur = TICKS_PER_CROTCHET;
    keepLength = false;
    baseDur = TICKS_PER_CROTCHET;
    beatAnchor = TICKS_PER_CROTCHET;
    baseOctave = 0;
    pendingSlurOpen = 0;
    pendingTie = false;
    pendingGrace = null;
    pendingDecos = [];
    pendingAbove = pendingBelow = undefined;
    groups.length = 0;
    lastNote = null;
    curKey = { ...DEFAULT_KEY };
    curPrintKey = null;
  }

  // A new movement starts back at the default key, which is a key point of
  // its own — otherwise a lookup inside movement two would report movement
  // one's last modulation.
  function resetKeyAt(at: number) {
    keys.push({ at, span: null, key: curKey, printKey: curPrintKey });
  }

  // Route the key that curKey/curPrintKey now describe to the right place, and
  // report whether it was a mid-piece change. A mark carries the whole
  // resulting state, so the ABC builder and the player never have to remember
  // which half of it moved.
  function applyKey(span: Span): boolean {
    keys.push({ at: span.start, span, key: curKey, printKey: curPrintKey });
    const mid = mv.items.some(i => i.kind === 'note');
    if (mid) {
      mv.items.push({ kind: 'mark', mark: { t: 'key', keySig: curKey, printKey: curPrintKey }, src: span });
    } else {
      mv.keySig = curKey;
      mv.printKey = curPrintKey;
    }
    return mid;
  }

  // The grace bracket we're inside, if any. Innermost wins, the way the one
  // closer does — g[ … ] may sit inside a tuplet or a beat group.
  function innermostGrace(): (Group & { t: 'grace' }) | null {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].t === 'grace') return groups[i] as Group & { t: 'grace' };
    }
    return null;
  }

  // A note joins the innermost tuplet still open, looking past any beat or key
  // group in between — those change how the note is WRITTEN, not whether it is
  // part of the triplet it sits inside.
  function push(it: Item) {
    if (it.kind === 'note') {
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g.t !== 'tuplet') continue;
        it.inTuplet = true;
        g.items.push(it);
        break;
      }
    }
    sink.push(it);
  }

  // ── line pass ──────────────────────────────────────────────────────
  const lines = splitLines(text);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // A % comment runs to end of line (LilyPond's rule) — and a %%% runs to
    // the end of the PAGE. There's no closing it: it's the line you draw under
    // the piece, with everything you've stopped working on swept below it, and
    // a closer would only invite the question of what happens after one. The
    // page itself ends it.
    const pct = indexOfComment(line.text);
    let body = line.text;
    const ends = pct >= 0 && line.text.startsWith('%%%', pct);
    if (pct >= 0) {
      ctx.ann.push({
        start: line.start + pct, end: ends ? text.length : line.start + line.text.length,
        label: ends ? 'the rest of the page' : 'comment',
        detail: ends ? 'everything from here down is ignored — %%% has no closer' : 'ignored',
        cls: 'comment',
      });
      body = line.text.slice(0, pct);
    }
    // Whatever stood in front of the %%% is still music; nothing under it is.
    if (ends) lines.length = li + 1;
    const trimmed = body.trim();
    if (!trimmed) continue;

    // Block delimiters we can't engrave — skip to the matching close.
    const blockOpen = /^(LP|LPH|Harm):/.exec(trimmed);
    if (blockOpen) {
      const tag = blockOpen[1];
      const from = li;
      while (li < lines.length && !new RegExp(`^:${tag}\\b`).test(lines[li].text.trim())) li++;
      const to = Math.min(li, lines.length - 1);
      const span = { start: lines[from].start, end: lines[to].start + lines[to].text.length };
      ctx.ann.push({ ...span, label: `${tag} block`, detail: 'raw LilyPond — not engraved', cls: 'unknown' });
      ctx.warnings.push({ span, msg: `${tag}: block skipped — raw LilyPond can't be engraved.` });
      continue;
    }

    // Lyrics: "L: syllables" / "H: 汉字". Empty after the colon means the
    // block continues on following lines until a blank one.
    const lyr = /^([LH]):(.*)$/.exec(trimmed);
    if (lyr) {
      const hanzi = lyr[1] === 'H';
      let content = lyr[2].trim();
      const from = li;
      if (!content) {
        const parts: string[] = [];
        while (li + 1 < lines.length && lines[li + 1].text.trim()) parts.push(lines[++li].text.trim());
        content = parts.join(' ');
      }
      const to = Math.min(li, lines.length - 1);
      ctx.ann.push({
        start: lines[from].start, end: lines[to].start + lines[to].text.length,
        label: hanzi ? 'hanzi lyrics' : 'lyrics',
        detail: hanzi ? 'auto-spaced per character' : 'syllables under the notes', cls: 'lyric',
      });
      addLyric(mv, content, hanzi);
      continue;
    }

    // ── a chord chart ────────────────────────────────────────────────
    // One line above the music it belongs to:
    //
    //   C"G G7/B | C7 C#dim | G7 | |"
    //
    // …or a whole FORM, pasted in once, between a pair of triple quotes:
    //
    //   C"""
    //   |: G G7/B | C7 C#dim | G7 | | :|
    //   A7 | | D7 | |
    //   """
    //
    // Bars are separated by |, chords inside a bar are spread across it, and
    // an empty bar simply carries nothing. The post-pass anchors the chart to
    // whichever bar comes next.
    //
    // The block form is a form, not just a longer line: a newline ends a bar
    // the way a | does, |: … :| plays a section twice, and the whole thing
    // LOOPS — round and round until another chord chart takes over or the
    // music runs out. Ending it on a final barline (|.) plays it once.
    if (trimmed.startsWith('C"""')) {
      const from = li;
      const openCol = line.text.indexOf('C"""');
      const openAt = line.start + openCol + 4;
      // The closing """ — later on the opening line, or on a line below it.
      let closeAt = -1;
      const here = body.indexOf('"""', openCol + 4);
      if (here >= 0) closeAt = line.start + here;
      else {
        for (let j = li + 1; j < lines.length; j++) {
          const k = lines[j].text.indexOf('"""');
          if (k >= 0) { closeAt = lines[j].start + k; li = j; break; }
        }
      }
      if (closeAt < 0) {
        // Nothing closes it. Rather than swallow the tune, stop at the first
        // blank line — the same place every other block in this language ends.
        li = li + 1;
        while (li < lines.length && lines[li].text.trim()) li++;
        li = Math.min(li, lines.length) - 1;
        closeAt = lines[li].start + lines[li].text.length;
        ctx.warnings.push({
          span: { start: line.start, end: closeAt },
          msg: 'C""" form never closed with """ — it ends at the blank line.',
        });
      }
      const to = li;
      const endAt = Math.min(closeAt + 3, lines[to].start + lines[to].text.length);

      // A % comment inside the form is blanked rather than cut out, so every
      // chord after it keeps the source offset it actually has.
      const chars = text.slice(openAt, closeAt).split('');
      const cuts: Span[] = [];
      for (let j = from; j <= to; j++) {
        const a = Math.max(lines[j].start, openAt);
        const b = Math.min(lines[j].start + lines[j].text.length, closeAt);
        const at = text.slice(a, b).indexOf('%');
        if (at < 0) continue;
        cuts.push({ start: a + at, end: b });
        for (let k = a + at; k < b; k++) chars[k - openAt] = ' ';
      }

      const markedFrom = ctx.marks.length;
      const chart = parseChordChart(chars.join(''), openAt, ctx);
      const marked = ctx.marks.slice(markedFrom).map(m => m.span);
      const span = { start: line.start, end: endAt };
      mv.items.push({
        kind: 'mark',
        mark: { t: 'chordline', bars: chart.bars, order: chart.order, cues: chart.cues, loop: !chart.final },
        src: span,
      });
      const n = chart.bars.reduce((a, b) => a + b.length, 0);
      const detail = `${n} over ${chart.order.length} bar${chart.order.length === 1 ? '' : 's'}`
        + (chart.final ? ' · once through' : ' · looping');
      // One run per line, so a comment inside the form still reads as one.
      for (let j = from; j <= to; j++) {
        const a = Math.max(lines[j].start, line.start + openCol);
        const b = Math.min(lines[j].start + lines[j].text.length, endAt);
        if (b <= a) continue;
        for (const cut of cuts) {
          if (cut.start >= a && cut.start < b) {
            ctx.ann.push({ start: cut.start, end: cut.end, label: 'comment', detail: 'ignored', cls: 'comment' });
          }
        }
        runsExcept(ctx, a, b, [...cuts, ...marked], { label: 'chords', detail, cls: 'chordsym' });
      }
      continue;
    }
    const cline = /^C"(.*)"?\s*$/.exec(trimmed);
    if (cline && trimmed.startsWith('C"')) {
      const inner = cline[1].replace(/"\s*$/, '');
      // Where the inner text starts in the document, so each symbol can keep
      // its own characters — that's what a diagnostic underlines later.
      const markedFrom = ctx.marks.length;
      const chart = parseChordChart(inner, line.start + line.text.indexOf(trimmed) + 2, ctx);
      const marked = ctx.marks.slice(markedFrom).map(m => m.span);
      const span = { start: line.start, end: line.start + line.text.length };
      mv.items.push({
        kind: 'mark',
        mark: { t: 'chordline', bars: chart.bars, order: chart.order, cues: chart.cues, loop: false },
        src: span,
      });
      const n = chart.bars.reduce((a, b) => a + b.length, 0);
      runsExcept(ctx, span.start, span.end, marked, {
        cls: 'chordsym', label: 'chords',
        detail: `${n} over ${chart.order.length} bar${chart.order.length === 1 ? '' : 's'}`,
      });
      continue;
    }

    // Guitar chords: "chords=c2. g:7 c", same one-line-or-block shape.
    const ch = /^chords=(.*)$/.exec(trimmed);
    if (ch) {
      const from = li;
      // Words, each with the characters it was written as: one line's worth
      // after `chords=`, or the block of lines under a bare `chords=`.
      const words = wordSpans(ch[1], line.start + line.text.indexOf(trimmed) + 'chords='.length);
      if (!words.length) {
        while (li + 1 < lines.length && lines[li + 1].text.trim()) {
          const l = lines[++li];
          words.push(...wordSpans(l.text, l.start));
        }
      }
      const to = Math.min(li, lines.length - 1);
      const span = { start: lines[from].start, end: lines[to].start + lines[to].text.length };
      const markedFrom = ctx.marks.length;
      mv.chords = parseChordMode(notMarks(words, ctx), ctx);
      runsExcept(ctx, span.start, span.end, ctx.marks.slice(markedFrom).map(m => m.span), {
        label: 'guitar chords', detail: 'LilyPond chordmode', cls: 'chordsym',
      });
      continue;
    }

    // What the page is written FOR: CONCERT=C (the default) or CONCERT=Bb.
    //
    // It says nothing about the notation — not one character moves — only
    // about what the writing SOUNDS: a B♭ part read on a trumpet or a tenor
    // comes out a tone under what it says. So the app plays the score (and a
    // MIDI keyboard played over it) a tone down, which is what puts a B♭
    // transcription and the concert-pitch recording it was made from into the
    // same key. It belongs to the DOCUMENT rather than to a movement — a page
    // is written for one instrument all the way down.
    const conc = /^concert\s*=\s*(.*)$/i.exec(trimmed);
    if (conc) {
      const span = { start: line.start, end: line.start + line.text.length };
      const said = conc[1].trim();
      const want = CONCERT_KEYS[said.toLowerCase()];
      if (!want) {
        ctx.errors.push({
          span,
          msg: `CONCERT= takes C or Bb — "${said}" isn't one of them.`,
        });
        ctx.ann.push({ ...span, label: 'concert', detail: 'unreadable', cls: 'unknown' });
      } else {
        ctx.concert = want;
        ctx.ann.push({
          ...span, cls: 'directive', label: `written in ${want === 'Bb' ? 'B♭' : 'C'}`,
          detail: want === 'Bb'
            ? 'a B♭ part — playback sounds a tone lower, to meet the recording'
            : 'concert pitch — playback sounds as written',
        });
      }
      continue;
    }

    // Lilypond headers on a line of their own: title=… composer=… etc.
    const hdr = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (hdr && !/^\d/.test(hdr[1]) && HEADER_KEYS.has(hdr[1])) {
      const span = { start: line.start, end: line.start + line.text.length };
      ctx.ann.push({ ...span, label: hdr[1], detail: 'score header', cls: 'header' });
      mv.headers[hdr[1]] = hdr[2].trim();
      if (hdr[1] === 'title') mv.title = hdr[2].trim();
      continue;
    }
    if (hdr && hdr[1] === 'frets') {
      const span = { start: line.start, end: line.start + line.text.length };
      ctx.ann.push({ ...span, label: 'frets', detail: 'fret diagrams — not engraved', cls: 'directive' });
      continue;
    }

    // ── a line that rides UNDER the music ────────────────────────────
    // X:  x x. \x | 0 \x x -       the comping rhythm
    // T:  3 5 | 3 2                 a part in treble clef …
    // T2: 1 3 | 1 7,                …and a second one under it
    // B:  1, 5, | 1 3 5 3           the bass line, in bass clef
    // B2: 1, - | 5, -               …and a second one under that
    //
    // All of them are written in exactly the language the music is written in
    // — the same degrees, the same duration marks, the same brackets, the same
    // |. What makes one of them what it is is only where it LANDS: a stream of
    // its own on a staff of its own under the music, taking no time away from
    // the line being transcribed, so it can say what the music has no room for
    // — a stab on the AND of 2 under a held minim, an inner voice under the
    // tune, a bass note under a rest.
    //
    // Bar for bar against the music, exactly like the chord line above it.
    let under: Under | null = null;
    {
      const m = /^([ \t]*)([XTB])(\d*):/.exec(body);
      if (m) {
        const at = m[1].length;
        const want = underOf(m[2], m[3]);
        under = mv.unders.find(u => u.id === want.id) ?? want;
        if (!mv.unders.includes(under)) mv.unders.push(under);
        const mark = m[2] + m[3] + ':';
        ctx.ann.push({
          start: line.start + at, end: line.start + at + mark.length,
          label: under.kind === 'stab' ? 'stabs' : under.id,
          detail: under.kind === 'stab'
            ? 'comping rhythm, on its own staff'
            : `a part on a ${under.kind}-clef staff of its own`,
          cls: 'directive',
        });
        // Blanked rather than sliced off, so every token after it keeps the
        // source offset it actually has.
        body = `${body.slice(0, at)}${' '.repeat(mark.length)}${body.slice(at + mark.length)}`;
      }
    }
    // Each of these is its own little piece of music: it starts at the beat the
    // movement started at and in the register ITS OWN last line left off in,
    // and nothing it does to the beat, the register or the brackets is allowed
    // to leak into the music around it. (For a bass staff that register is its
    // own — see BASS_OCTAVE.)
    const held: {
      baseDur: number; beatAnchor: number; baseOctave: number; lastDur: number;
      keepLength: boolean; lastNote: NoteItem | null; groups: Group[];
    } | null = under ? {
      baseDur, beatAnchor, baseOctave, lastDur, keepLength, lastNote,
      groups: groups.splice(0, groups.length),
    } : null;
    if (held) {
      sink = under!.items;
      baseDur = beatAnchor = TICKS_PER_CROTCHET;
      baseOctave = underOctave.get(under!.id) ?? 0; lastDur = TICKS_PER_CROTCHET;
      keepLength = false; lastNote = null;
    }

    music.push({
      span: { start: line.start, end: line.start + body.length },
      under: under ? under.id : null,
    });

    // ── token pass ───────────────────────────────────────────────────
    for (const tok of tokenize(body, line.start)) {
      const T = tok.text;
      const span: Span = { start: tok.start, end: tok.start + T.length };
      const A = (label: string, cls: AnnClass, detail?: string) =>
        ctx.ann.push({ ...span, label, detail, cls });

      // ---- movement / part breaks -----------------------------------
      if (T === 'NextScore') {
        A('NextScore', 'directive', 'starts a new movement');
        movements.push(mv); mv = newMovement(); resetMovementState(); resetKeyAt(span.start);
        continue;
      }
      if (T === 'NextPart') {
        A('NextPart', 'directive', 'second part — rendered as its own score');
        movements.push(mv); mv = newMovement(); resetMovementState(); resetKeyAt(span.start);
        continue;
      }

      // ---- key / meter / tempo --------------------------------------
      // 1=C or 6=F# — degree N is this pitch.
      //
      // Written before any note it's the movement's key; written later it's a
      // MODULATION — the numbers mean something new from that point on, and
      // the staff gets a fresh key signature there. Jazz lives on this: the
      // bridge that goes up a minor third stays readable as 1 2 3 5 instead of
      // turning into a wall of accidentals.
      //
      // With a [ on the end it's a MODULATION THAT ENDS: 1=Eb[ … ] numbers
      // just the passage inside the brackets, and the ] puts back whatever was
      // running before it — the bridge, without having to remember what the
      // key was on the way out.
      const key = /^([1-7])=([A-Ga-g])([#b]*)(\[)?$/.exec(T);
      if (key) {
        const label = T.slice(0, T.length - (key[4] ? 1 : 0));
        if (key[4]) groups.push({ t: 'key', span, prevKey: curKey, prevPrint: curPrintKey });
        curKey = makeKey(Number(key[1]), key[2].toUpperCase(), key[3], label);
        const mid = applyKey(span);
        A(T, 'key', `${SOLFEGE[Number(key[1])]} = ${key[2].toUpperCase()}${key[3]} · ${curKey.name}${key[4] ? ' · until the ]' : mid ? ' · from here on' : ''}`);
        continue;
      }
      // K=Eb — the printed key signature, independent of where do sits. Also
      // changeable mid-piece, and just as sticky: once set it keeps overriding
      // what a later 1= would otherwise print, until another K= replaces it.
      const pk = /^K=([A-Ga-g])([#b]*)(m|min|minor)?(\[)?$/.exec(T);
      if (pk) {
        if (pk[4]) groups.push({ t: 'key', span, prevKey: curKey, prevPrint: curPrintKey });
        curPrintKey = makePrintKey(pk[1].toUpperCase(), pk[2], !!pk[3]);
        const mid = applyKey(span);
        A(T, 'key', `key signature ${curPrintKey.name} · ${sigCount(curPrintKey.sharps)}${pk[4] ? ' · until the ]' : mid ? ' · from here on' : ''}`);
        continue;
      }

      // 4=85 — tempo (a note value equals a bpm).
      const tempo = /^(1|2|4|8|16)\.?=(\d+)$/.exec(T);
      if (tempo) {
        mv.tempo = { unit: Number(tempo[1]), bpm: Number(tempo[2]) };
        A(T, 'tempo', `${tempo[2]} per 1/${tempo[1]} note`);
        continue;
      }
      // 4/4 or 6/8,4 — time signature with optional anacrusis.
      const meter = /^(\d+)\/(\d+)(?:,(\d+)\.?)?$/.exec(T);
      if (meter) {
        mv.meter = { bn: Number(meter[1]), den: Number(meter[2]) };
        let detail = `${meter[1]} beats of 1/${meter[2]}`;
        if (meter[3]) {
          mv.pickup = TICKS_PER_WHOLE / Number(meter[3]);
          detail += ` · pickup of 1/${meter[3]}`;
        }
        A(T, 'meter', detail);
        continue;
      }

      // ---- structural words -----------------------------------------
      if (T === 'KeepLength') { keepLength = true; A(T, 'directive', 'later notes reuse the last note value'); continue; }

      // A beat group: `\[ … ]`. The opener is a note value written the way it
      // would be on a note — \ for half a crotchet, // for four of them, or a
      // duration letter — with a [ stuck on the end, and it says "for the next
      // few words, THIS is the beat". Inside, a bare number is one of them, \
      // and / halve and double against it, and a hold dash adds one. The ]
      // puts back whatever beat was running before.
      //
      // It's the difference between writing a run of sixteenths as
      // "s1 s2 s3 s4" and as "\\[ 1 2 3 4 ]" — same music, but the second one
      // says the passage is IN sixteenths rather than repeating it per note.
      // A tuplet is the same shape one level up (3[ … ]), which is the point:
      // both brackets change how the words inside them read.
      const durOpen = /^(\\+|\/+|[hdsqec])(\.*)\[$/.exec(T);
      if (durOpen) {
        const d = groupDur(durOpen[1], durOpen[2], baseDur);
        groups.push({ t: 'dur', span, prev: baseDur, prevAnchor: beatAnchor });
        baseDur = d;
        beatAnchor = d;
        A(T, 'dur', `${DUR_NAME[d] ?? `${d}/128`} beat until the ] · ${durDetail(d, 4 / mv.meter.den)}`);
        continue;
      }
      // ── the two "from here on" marks: the register, and the beat ────
      // ' and , move the base octave everything after them is written against;
      // \ and / move the beat a bare number is worth, halving and doubling it
      // exactly as they do stuck to a digit. Both count off WHERE YOU ARE
      // rather than where the passage started: ,, is two octaves below the
      // register in force, and a , after a , is a third octave down. That's
      // the same thing the characters mean on a note — one reading of ' and ,
      // wherever they're written — and it composes, so a line can be dropped
      // an octave without knowing what register the music around it is in.
      //
      // The reset characters are what give absolute footing: `;` puts the
      // register back to the middle, `:` the beat back to the passage's own,
      // and `=` both. A line that wants to say where it is on its own opens
      // with one of those and then the marks it needs — and since a reset is
      // counted first, `;,` and `:\` are the absolute spellings of "an octave
      // below the middle" and "in quavers".
      //
      // The move characters are the same ones a note carries, which is the
      // point: the mark that means "an octave up" or "half as long" stuck to a
      // digit means it standing alone too. One token may say both — `\,` is
      // "in quavers, an octave down, from here on" — and the order doesn't
      // matter. The sign pair can't join any of it — a lone - is already the
      // hold dash — which is why + and - are turned away just below.
      const mark = readMarkRuns(T);
      if (mark) {
        const { beat, oct, reset } = mark;
        if (mark.stray || mark.dup) {
          A(T, 'unknown', mark.dup ? 'says the same thing twice' : 'says two things about the same thing');
          ctx.errors.push({ span, msg: `"${T}" can't be read — a mark says one thing about the beat (\\ or /) and one about the register (, or '), with at most one reset in front of them (= both, : the beat, ; the register).` });
          continue;
        }
        // Reset first, then the moves count off what it left — which is what
        // markBeat and markRegister do, so this is the same one reading the
        // transposer and the migration ladder get.
        const d = markBeat(T, mark, baseDur, beatAnchor);
        const o = markRegister(T, mark, baseOctave);
        if (d != null) baseDur = d;
        if (o != null) baseOctave = o;
        // Each part is annotated over the characters that said it, so the
        // colour and the hint land there. The label is the move, the detail
        // where it leaves you — the thing you'd otherwise scan back for.
        if (reset) {
          ctx.ann.push({
            start: span.start + reset.at, end: span.start + reset.at + 1,
            ...resetHint(reset.what, beatAnchor),
          });
        }
        if (beat) {
          const run = T.slice(beat.from, beat.to);
          const n = run.replace(/\./g, '').length;
          const dots = run.length - n;
          ctx.ann.push({
            start: span.start + beat.from, end: span.start + beat.to,
            label: `${run[0] === '\\' ? 'halve' : 'double'}${n > 1 ? ` ${n}×` : ''}${dots ? ', dotted' : ''}`,
            cls: 'dur',
            detail: `a ${DUR_NAME[baseDur] ?? `${baseDur}/128`} beat from here on · ${durDetail(baseDur, 4 / mv.meter.den)}`,
          });
        }
        if (oct) {
          const n = oct.to - oct.from;
          ctx.ann.push({
            start: span.start + oct.from, end: span.start + oct.to,
            label: `${n === 1 ? 'an octave' : `${n} octaves`} ${T[oct.from] === ',' ? 'down' : 'up'}`,
            cls: 'octave', detail: `the register from here on · ${registerName(baseOctave)}`,
          });
        }
        continue;
      }

      // A lone + or -- is someone reaching for the base-octave shift with the
      // note-mark spelling. It can't be that: a lone - is already the hold
      // dash, so both signs stay note marks and the shift is ' / ,.
      const looseSign = /^(\++|-{2,})$/.exec(T);
      if (looseSign) {
        const up = T[0] === '+';
        A(T, 'unknown', `octave marks go on a note (1${T[0]}) — use ${up ? "'" : ','} to shift the base`);
        ctx.errors.push({ span, msg: `"${T}" on its own isn't an octave shift — write ${(up ? "'" : ',').repeat(T.length)} for the base octave, or ${up ? '1+' : '1-'} to move one note.` });
        continue;
      }

      // The old angle spelling — see OLD_REGISTER. Caught here, and again after
      // the note tokens for the ones that carry a digit, so it reads as "that
      // character moved" rather than "no idea what that is".
      if (OLD_REGISTER.test(T)) {
        A(T, 'unknown', `the register marks are ' and , now — this is ${respellOldOctaves(T)}`);
        ctx.errors.push({ span, msg: `"${T}" was the old spelling of the register mark — write ${respellOldOctaves(T)}.` });
        continue;
      }

      if (T === 'R{') { push({ kind: 'mark', mark: { t: 'repeatStart' }, src: span }); A('R{', 'repeat', 'start of a repeat'); continue; }
      if (T === '}') { push({ kind: 'mark', mark: { t: 'repeatEnd' }, src: span }); A('}', 'repeat', 'end of a repeat'); continue; }
      if (T === 'A{') { push({ kind: 'mark', mark: { t: 'alt', n: 1 }, src: span }); A('A{', 'repeat', 'first alternate ending'); continue; }
      const shortRep = /^R(\d+)\{$/.exec(T);
      if (shortRep) {
        push({ kind: 'mark', mark: { t: 'repeatStart' }, src: span });
        A(T, 'repeat', `percent repeat ×${shortRep[1]}`);
        continue;
      }
      const multirest = /^R\*(\d+)$/.exec(T);
      if (multirest) {
        push({ kind: 'mark', mark: { t: 'multirest', bars: Number(multirest[1]) }, src: span });
        A(T, 'rest', `${multirest[1]} bars' rest`);
        continue;
      }
      // BR ends the staff line, and a run of them opens up more space before
      // the next one. BR3 is that run written as a count — three BRs said once
      // — and a reset character on the end does exactly what it does standing
      // alone, which is most of what the head of a fresh line wants to say:
      // BR= starts the next line back on the passage's own beat, in the middle
      // register, without a second token to write it.
      const br = /^BR(\d*)([=:;]?)$/.exec(T);
      if (br) {
        // The count is what gets written out as a run of breaks, so it has a
        // ceiling: 0 breaks nothing, and a number with no bottom to it would
        // have the writer opening a gap taller than any page.
        const n = br[1] ? Number(br[1]) : 1;
        if (n < 1 || n > BR_MAX) {
          A(T, 'unknown', 'a BR count is how many line breaks');
          ctx.errors.push({ span, msg: `"${T}" isn't a run of breaks — the number after BR is how many BRs in a row, so it has to be between 1 and ${BR_MAX}.` });
          continue;
        }
        for (let i = 0; i < n; i++) push({ kind: 'mark', mark: { t: 'linebreak' }, src: span });
        const brEnd = span.start + 2 + br[1].length;
        ctx.ann.push({
          start: span.start, end: brEnd, cls: 'bar', label: T.slice(0, 2 + br[1].length),
          detail: n === 1
            ? 'end the staff line here · repeat for more space'
            : `end the staff line here · ${n} in a row, so ${n - 1} extra ${n - 1 === 1 ? 'gap' : 'gaps'} of space before the next`,
        });
        if (br[2]) {
          const r = readMarkRuns(br[2])!;
          const d = markBeat(br[2], r, baseDur, beatAnchor);
          const o = markRegister(br[2], r, baseOctave);
          if (d != null) baseDur = d;
          if (o != null) baseOctave = o;
          ctx.ann.push({ start: brEnd, end: span.end, ...resetHint(r.reset!.what, beatAnchor) });
        }
        continue;
      }

      if (T === 'R') {
        // Resolved to a real length by resolveFillRests once the movement is
        // parsed — the parser doesn't track bar positions as it goes, and the
        // length depends on what comes AFTER it in the bar as well as before.
        const r: NoteItem = {
          kind: 'note', pitches: [], perc: false, dur: 0, tie: false,
          slurOpen: 0, slurClose: 0, decos: [], inTuplet: false, fill: true, src: span,
        };
        push(r);
        lastNote = null;   // a dash after a bar-filling rest is meaningless
        A('R', 'rest', 'rest sized to fill out the bar');
        continue;
      }

      if (T === '|') {
        push({ kind: 'mark', mark: { t: 'bar', sym: '|' }, src: span });
        A('|', 'bar', 'barline');
        continue;
      }

      // Tuplets: 3[ … ] — and 3\[ … ], which is the same bracket with a beat
      // group folded into it. Nearly every triplet is written in one value
      // throughout, and "3[ \1 \2 \3 ]" makes you say so three times; the
      // note value rides the opener instead, exactly as it would on "\[".
      const tupOpen = /^(\d+)(?:(\\+|\/+|[hdsqec])(\.*))?\[$/.exec(T);
      if (tupOpen) {
        const p = Number(tupOpen[1]);
        // The number before the [ is how many notes go in the bracket, so it
        // has to be 2 or more: "0 in the time of 2" isn't music. It also can't
        // be allowed through, because every sounding position inside a tuplet
        // is measured as cum * q / p — with p of 0 that's Infinity, and the
        // bar cursor that walks a position down a bar at a time (`while (pos
        // >= cap) pos -= cap`) then never comes back. Turning it away here,
        // where the number was written, means nothing downstream ever holds a
        // tuplet it can't measure.
        //
        // It's an easy thing to type by accident: a `0` in front of a beat
        // group — `0\[ 5, 1 3 4 ]` — is one token, so it reads as an opener
        // rather than as a rest followed by a bracket.
        if (p < 2) {
          A(T, 'unknown', 'a tuplet needs 2 or more notes in the bracket');
          ctx.errors.push({ span, msg: `"${T}" isn't a tuplet — the number before the [ is how many notes go inside it, so it has to be 2 or more.` });
          continue;
        }
        const g: Group = { t: 'tuplet', span, p, items: [] };
        let detail = `${p} in the time of ${tupletQ(p)}`;
        if (tupOpen[2]) {
          const d = groupDur(tupOpen[2], tupOpen[3], baseDur);
          g.prevDur = baseDur;
          g.prevAnchor = beatAnchor;
          baseDur = d;
          beatAnchor = d;
          detail += ` · each one a ${DUR_NAME[d] ?? `${d}/128`} until the ]`;
        }
        groups.push(g);
        A(T, 'tuplet', detail);
        continue;
      }
      // Grace notes: g[ e f e ] 1 — the same bracket as a tuplet's, holding
      // ordinary notes. They are written the way every other note on the line
      // is (letters or degrees, marks and all); what makes them grace notes is
      // the bracket, not a private spelling inside it. g/[ … ] is the crushed
      // one — the slash through the stem.
      if (T === 'g[' || T === 'g/[') {
        const slash = T === 'g/[';
        groups.push({ t: 'grace', span, slash, notes: [] });
        A(T, 'deco', `${slash ? 'crushed grace notes' : 'grace notes'} · they lean on the note after the ]`);
        continue;
      }

      // The one closer, for all four openers: it ends whichever bracket is
      // still innermost.
      if (T === ']') {
        const g = groups.pop();
        if (!g) {
          A(T, 'tuplet', 'end of group');
          ctx.warnings.push({ span, msg: '] with nothing open to close.' });
        } else if (g.t === 'tuplet') {
          closeTuplet(g, ctx);
          // A 3\[ opener set the beat as well; this ] puts it back.
          if (g.prevDur != null) { baseDur = g.prevDur; beatAnchor = g.prevAnchor ?? beatAnchor; }
          A(T, 'tuplet', g.prevDur != null
            ? `end of tuplet · back to a ${DUR_NAME[g.prevDur] ?? `${g.prevDur}/128`} beat`
            : 'end of tuplet');
        } else if (g.t === 'dur') {
          baseDur = g.prev;
          beatAnchor = g.prevAnchor;
          A(T, 'dur', `back to a ${DUR_NAME[baseDur] ?? `${baseDur}/128`} beat`);
        } else if (g.t === 'grace') {
          if (!g.notes.length) {
            ctx.warnings.push({ span: g.span, msg: 'Empty grace group — nothing between g[ and ].' });
            A(T, 'deco', 'end of the grace notes — there were none');
          } else {
            // The slash is drawn on the first of the group, which is where ABC
            // puts it and where a reader looks for it.
            if (g.slash) g.notes[0].slash = true;
            // Two brackets in a row lean on the same note rather than the
            // second one throwing the first away.
            pendingGrace = pendingGrace ? [...pendingGrace, ...g.notes] : g.notes;
            A(T, 'deco', `end of the grace notes · ${g.notes.length} of them`);
          }
        } else {
          curKey = g.prevKey;
          curPrintKey = g.prevPrint;
          applyKey(span);
          A(T, 'key', `back to ${curKey.label}${curPrintKey ? ` · signature ${curPrintKey.name}` : ''}`);
        }
        continue;
      }

      // The after-grace, [..]g, is gone: ABC has no such thing, so it was only
      // ever drawn in front of the following note anyway — a spelling that
      // said one thing and did another. Caught by name rather than left to
      // "no idea what that is".
      const afterGrace = /^\[(.+)\]g$/.exec(T);
      if (afterGrace) {
        A(T, 'unknown', `grace notes go in front, in g[ … ] — this is g[ ${afterGrace[1]} ]`);
        ctx.errors.push({ span, msg: `"${T}" was the after-grace spelling, which isn't read any more — write "g[ ${afterGrace[1]} ]" in front of the note it leans on.` });
        continue;
      }

      // Ties and slurs.
      if (T === '~') { pendingTie = true; if (lastNote) lastNote.tie = true; A('~', 'tie', 'tie to the next note'); continue; }
      // Slurs keep their own ( ) and their own counting, so one may start or
      // end anywhere — including across the edge of a tuplet or a beat group.
      if (T === '(') { pendingSlurOpen++; A('(', 'slur', 'slur begins'); continue; }
      if (T === ')') { if (lastNote) lastNote.slurClose++; A(')', 'slur', 'slur ends'); continue; }
      if (T === '[(') { pendingSlurOpen++; A('[(', 'slur', 'instrumental break begins'); continue; }
      if (T === ')]') { if (lastNote) lastNote.slurClose++; A(')]', 'slur', 'instrumental break ends'); continue; }

      // A mark: M1, M2 … a place to come back to, paired with the recording's
      // bookmark of the same number. Nothing is engraved and no time passes —
      // it is only a spot in the writing.
      if (markWord(T, span, ctx) != null) continue;

      // Rehearsal marks: letterA, letterB, letter3, letterAA
      const letter = /^letter(\w+)$/.exec(T);
      if (letter) {
        push({ kind: 'mark', mark: { t: 'rehearsal', label: letter[1] }, src: span });
        A(T, 'deco', `rehearsal mark ${letter[1]}`);
        continue;
      }

      // Navigation words.
      if (NAV_WORDS[T]) {
        push({ kind: 'mark', mark: { t: 'text', above: NAV_WORDS[T] }, src: span });
        A(T, 'deco', NAV_WORDS[T]);
        continue;
      }

      // Text above / below a note: ^"…" and _"…"
      const txt = /^([\^_])"(.*)"$/.exec(T);
      if (txt) {
        if (txt[1] === '^') pendingAbove = txt[2]; else pendingBelow = txt[2];
        A(T, 'deco', `text ${txt[1] === '^' ? 'above' : 'below'} the note`);
        continue;
      }

      // \bar "||"  — an explicit barline.
      const barCmd = /^\\bar$/.exec(T);
      if (barCmd) { A(T, 'bar', 'explicit barline (symbol follows)'); continue; }
      const barSym = /^"(\|\||\|\.|\.\||:\||\|:|\|\]|)"$/.exec(T);
      if (barSym) {
        push({ kind: 'mark', mark: { t: 'bar', sym: abcBarline(barSym[1]) }, src: span });
        A(T, 'bar', barlineName(barSym[1]));
        continue;
      }

      // One-word LilyPond \commands: \p \mp \f \fermata \> \! …
      if (T.startsWith('\\')) {
        const word = T.slice(1);
        const deco = LY_DECO[word];
        if (deco) {
          pendingDecos.push(deco);
          if (lastNote && DECO_ON_PREVIOUS.has(word)) { lastNote.decos.push(deco); pendingDecos.pop(); }
          A(T, 'deco', LY_DECO_NAME[word] ?? word);
        } else {
          A(T, 'unknown', 'LilyPond command — not engraved');
          ctx.warnings.push({ span, msg: `\\${word} isn't supported by the renderer — skipped.` });
        }
        continue;
      }

      // Erhu / ornament words we recognise but can't draw.
      if (UNSUPPORTED_WORDS.has(T) || /^(Fr|slide)=/.test(T)) {
        A(T, 'unknown', 'erhu/ornament — not engraved');
        ctx.warnings.push({ span, msg: `"${T}" is an erhu/ornament word with no notation equivalent — skipped.` });
        continue;
      }

      // No-op layout directives: recognised, deliberately ignored.
      if (IGNORED_WORDS.has(T)) { A(T, 'directive', `${IGNORED_WORDS.get(T)}`); continue; }

      // ---- dashes: extend the previous note by one crotchet ----------
      if (T === '-' || T === '.') {
        if (lastNote) {
          lastNote.dur += baseDur;
          const unit = baseDur === TICKS_PER_CROTCHET ? 'beat' : (DUR_NAME[baseDur] ?? `${baseDur}/128`);
          A(T, 'dash', `holds one more ${unit} · now a ${DUR_NAME[lastNote.dur] ?? `${lastNote.dur}/128`}`);
        } else {
          A(T, 'dash', 'hold — but there is no note to extend');
          ctx.warnings.push({ span, msg: `"${T}" extends the previous note, but none has been written yet.` });
        }
        continue;
      }

      // ---- notes ------------------------------------------------------
      // Inside g[ … ] the beat is the quaver: a grace note is written as one
      // unless it says otherwise, and a \ or / inside the bracket counts off
      // that rather than off the beat the music is in. KeepLength doesn't
      // reach in either — grace notes are their own little world.
      const grace = innermostGrace();
      const note = parseNoteToken(
        T, span, baseOctave,
        grace ? TICKS_PER_QUAVER : keepLength ? lastDur : baseDur,
        grace ? TICKS_PER_QUAVER : baseDur,
        mv, ctx, curKey,
      );
      if (note && grace) {
        // Collected rather than played: they don't join the stream, take no
        // time, and leave lastNote alone — a dash after the ] extends the note
        // the graces lean on, not the last of them.
        if (!note.pitches.length || note.perc) {
          A(T, 'unknown', 'a grace note needs a pitch');
          ctx.errors.push({ span, msg: `"${T}" is inside g[ … ], where there is nothing for a ${note.perc ? 'percussion beat' : 'rest'} to do — grace notes are pitches.` });
          continue;
        }
        grace.notes.push({ pitches: note.pitches, dur: note.dur, src: span });
        continue;
      }
      if (note) {
        // A stab line is a rhythm, so everything on it that isn't a rest is a
        // hit. Writing a pitch there is answered rather than obeyed — the
        // rhythm staff has one line and nothing to put a pitch on.
        if (under?.kind === 'stab' && note.pitches.length) {
          note.pitches = [];
          note.perc = true;
          ctx.warnings.push({ span, msg: `"${T}" is on a stab line, which carries a rhythm and no pitches — drawn as a hit.` });
        }
        note.slurOpen = pendingSlurOpen; pendingSlurOpen = 0;
        if (pendingTie) { pendingTie = false; }
        if (pendingGrace) { note.grace = pendingGrace; pendingGrace = null; }
        if (pendingDecos.length) { note.decos.push(...pendingDecos); pendingDecos = []; }
        if (pendingAbove) { note.above = pendingAbove; pendingAbove = undefined; }
        if (pendingBelow) { note.below = pendingBelow; pendingBelow = undefined; }
        // The bass staff's own home register, applied here rather than through
        // baseOctave so the register marks keep reading against the BASS line's
        // home rather than the melody's — see BASS_OCTAVE.
        if (under?.kind === 'bass') {
          for (const p of note.pitches) p.octave += BASS_OCTAVE;
          if (note.grace) for (const g of note.grace) for (const p of g.pitches) p.octave += BASS_OCTAVE;
        }
        lastDur = note.dur;
        lastNote = note;
        push(note);
        continue;
      }

      // ---- anything left ----------------------------------------------
      // A note in the old angle spelling reads as a note that lost its octave,
      // so it gets its own word rather than "no idea".
      if (isOldNote(T)) {
        A(T, 'unknown', `octave marks are ' and , now — this is ${respellOldOctaves(T)}`);
        ctx.errors.push({ span, msg: `"${T}" uses the old < > octave marks — write ${respellOldOctaves(T)}.` });
        continue;
      }
      // `#c` for `c#`: a letter note whose marks were written in front. Only
      // the register marks can lead — see LETTER_NOTE — so this is a spelling
      // to point at rather than a token with no meaning.
      if (isBackwardsLetterNote(T)) {
        const fix = letterMarksAfter(T);
        A(T, 'unknown', `a letter note carries its marks after the letter — this is ${fix}`);
        ctx.errors.push({ span, msg: `"${T}" writes its marks in front of the letter — only ' and , can lead. Write "${fix}".` });
        continue;
      }
      A(T, 'unknown', 'not recognised');
      ctx.errors.push({ span, msg: `Don't know what "${T}" means.` });
    }

    if (held) {
      for (const g of groups) {
        ctx.warnings.push({ span: g.span, msg: `A bracket opened on a ${under!.id}: line has to close on it — this one runs off the end.` });
      }
      groups.length = 0;
      groups.push(...held.groups);
      underOctave.set(under!.id, baseOctave);
      baseDur = held.baseDur; beatAnchor = held.beatAnchor; baseOctave = held.baseOctave;
      lastDur = held.lastDur; keepLength = held.keepLength; lastNote = held.lastNote;
      sink = mv.items;
    }
  }

  for (const g of groups) {
    const what = g.t === 'tuplet' ? 'Tuplet' : g.t === 'dur' ? 'Beat group'
      : g.t === 'grace' ? 'Grace group' : 'Key group';
    ctx.warnings.push({ span: g.span, msg: `${what} opened but never closed with ] — it runs to the end.` });
  }
  // Grace notes lean on the note AFTER them, so a bracket with nothing left to
  // follow it is written but never drawn. Said out loud rather than dropped.
  if (pendingGrace?.length) {
    ctx.warnings.push({ span: pendingGrace[0].src, msg: 'Grace notes with no note to lean on — nothing follows the ], so they are not drawn.' });
  }
  movements.push(mv);

  for (const m of movements) {
    resolveFillRests(m, ctx, m.items);
    m.items = padShortBars(m, m.items);
    splitRestsAtChords(m);
    // Every staff under it gets the same treatment, so an R fills its bar and
    // a bar that came up short is padded — the staves then hold the same
    // number of bars, which is the whole basis of their being read together.
    // The pitched ones need it for one more reason: they're PLAYED, so a bar
    // one came up short in has to hold real silence or everything after it
    // slides forward against the tune.
    for (const u of m.unders) {
      if (!u.items.length) continue;
      resolveFillRests(m, ctx, u.items);
      u.items = padShortBars(m, u.items);
    }
    // Into engraved order — the stabs, then the treble parts, then the bass
    // ones — however they were written down the page.
    m.unders.sort((a, b) => underRank(a) - underRank(b));
  }

  // Chords written as roman numerals are read into the letter chords they
  // name, in the key in force where each was written. Everything downstream
  // plays and voices `sym`; only the engraving, asked for numerals, goes back
  // to what was written.
  const readRoman = (c: { sym: string; src?: Span; roman?: string }) => {
    if (!c.src || c.roman) return;
    const letter = fromRoman(c.sym, keyAt(keys, c.src.start).key);
    if (letter) { c.roman = c.sym; c.sym = letter; }
  };
  for (const m of movements) {
    for (const c of m.chords) readRoman(c);
    for (const it of m.items) {
      if (it.kind === 'mark' && it.mark.t === 'chordline') for (const bar of it.mark.bars) for (const w of bar) readRoman(w);
    }
  }

  ctx.ann.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    movements: movements.filter(m => m.items.length || m.title || Object.keys(m.headers).length),
    annotations: dedupeAnnotations(ctx.ann),
    errors: ctx.errors,
    warnings: ctx.warnings,
    keys,
    music,
    marks: ctx.marks.slice().sort((a, b) => a.span.start - b.span.start),
    concert: ctx.concert,
  };
}

// The key in force at a source offset — the last one declared at or before it.
export function keyAt(keys: KeyPoint[], offset: number): KeyPoint {
  let out = keys[0];
  for (const k of keys) {
    if (k.at > offset) break;
    out = k;
  }
  return out;
}

// Read a key centre the way a person would type one into a box: "Eb", "F#m",
// "1=Eb", "6=F#". Minor spellings become a 6= declaration, which is how this
// syntax says "la is here".
export function keyFromSpec(spec: string): KeySig | null {
  const t = spec.trim();
  const m = /^(?:([1-7])=)?([A-Ga-g])([#b]*)\s*(m|min|minor)?$/.exec(t);
  if (!m) return null;
  const letter = m[2].toUpperCase();
  const accs = m[3];
  const degree = m[1] ? Number(m[1]) : (m[4] ? 6 : 1);
  return makeKey(degree, letter, accs, `${degree}=${letter}${accs}`);
}

// Split RESTS so that every chord has a notehead to sit on.
//
// A chord symbol in ABC can only hang off a note or rest. A bar of rests
// carrying two changes would otherwise show only the first, because the
// second falls in the middle of a single whole-bar rest — exactly the case a
// chord chart is full of. Splitting the rest is what a copyist does anyway.
//
// Only rests: splitting a NOTE would mean adding a tie and changing how the
// rhythm reads, which is the engraver's call, not ours.
function splitRestsAtChords(mv: Movement): void {
  if (!mv.chords.length) return;
  const ticks = Array.from(new Set(mv.chords.map(c => c.tick))).sort((a, b) => a - b);
  const spb = TICKS_PER_WHOLE / mv.meter.den;
  const barTicks = mv.meter.bn * spb;

  const out: Item[] = [];
  let pos = 0;
  let cap = mv.pickup ?? barTicks;
  let abs = 0;
  let tup: { p: number; q: number; r: number; start: number; cum: number; seen: number } | null = null;

  for (const item of mv.items) {
    if (item.kind === 'mark') {
      if (item.mark.t === 'bar' || item.mark.t === 'multirest') {
        if (pos !== 0) abs += cap - pos;
        pos = 0; cap = barTicks;
      }
      out.push(item);
      continue;
    }
    const isRest = !item.perc && item.pitches.length === 0;
    const splittable = isRest && !item.inTuplet && item.dur > 0;
    if (!splittable) {
      out.push(item);
      const before = pos;
      // A tuplet's members are WRITTEN longer than they sound — three quavers
      // of a 3:2 take two quavers between them — so a walk that adds up what's
      // written runs ahead of the clock by the difference, and stays ahead for
      // the rest of the bar. That's how a rest after a triplet came to be cut
      // at a tick nothing is written on: an eighth adrift, so the crotchet rest
      // on beat 2 came out as a dotted quaver and a semiquaver. Counted
      // cumulatively rather than member by member, like every other walk over
      // this language (see padShortBars), so the rounding lands where the
      // playback's does.
      if (item.tuplet) tup = { ...item.tuplet, start: pos, cum: 0, seen: 0 };
      if (item.inTuplet && tup) {
        tup.cum += item.dur;
        tup.seen++;
        pos = tup.start + Math.round(tup.cum * tup.q / tup.p);
        if (tup.seen >= tup.r) tup = null;
      } else {
        pos += item.dur;
      }
      abs += pos - before;
      while (pos >= cap) { pos -= cap; cap = barTicks; }
      continue;
    }

    // Cut points strictly inside this rest.
    const cuts = ticks.filter(t => t > abs && t < abs + item.dur);
    if (!cuts.length) {
      out.push(item);
      pos += item.dur;
      abs += item.dur;
      while (pos >= cap) { pos -= cap; cap = barTicks; }
      continue;
    }
    let from = abs;
    for (const cut of [...cuts, abs + item.dur]) {
      out.push({ ...item, dur: cut - from, fill: false });
      from = cut;
    }
    pos += item.dur;
    abs += item.dur;
    while (pos >= cap) { pos -= cap; cap = barTicks; }
  }
  mv.items = out;
}

// Which beats a bar's chords sit on.
//
// Not even spacing — chord charts put changes on strong beats. In 4/4 that's
// one chord on beat 1; two on beats 1 and 3; three on 1, 3 and 4; four on
// every beat. That pattern falls out of halving the bar and pushing the extra
// chord into the LATER half, which generalises to other meters for free
// (6/8 gets its two dotted beats, 3/4 gets beats 1 and 3).
//
// More chords than beats is past what beats can express, so those spread
// evenly and land wherever they land.
export function chordBeatOffsets(n: number, bn: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  if (n >= bn) return Array.from({ length: n }, (_, i) => i * bn / n);
  if (bn % 2 === 0) {
    const half = bn / 2;
    const left = Math.floor(n / 2);
    return [
      ...chordBeatOffsets(left, half),
      ...chordBeatOffsets(n - left, half).map(o => o + half),
    ];
  }
  return Array.from({ length: n }, (_, i) => Math.round(i * bn / n));
}

// The sounding length of everything between a bare `R` and the end of its
// bar: notes up to the next explicit barline (or another R, or the end of the
// movement). It's what makes `R 1 |` three beats' rest and a crotchet on beat
// 4 rather than a whole bar's rest with the 1 pushed into the next bar.
function spaceAfterFill(items: Item[], from: number): number {
  let sum = 0;
  let tup: { p: number; q: number; r: number; cum: number; seen: number } | null = null;
  for (let i = from + 1; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'mark') {
      if (it.mark.t === 'bar' || it.mark.t === 'multirest') break;
      continue;
    }
    if (it.fill) break;   // the next R sizes itself against what follows IT
    if (it.tuplet) tup = { ...it.tuplet, cum: 0, seen: 0 };
    if (it.inTuplet && tup) {
      const before = Math.round(tup.cum * tup.q / tup.p);
      tup.cum += it.dur;
      tup.seen++;
      sum += Math.round(tup.cum * tup.q / tup.p) - before;
      if (tup.seen >= tup.r) tup = null;
    } else {
      sum += it.dur;
    }
  }
  return sum;
}

// Give every bare `R` a concrete length: whatever is left of the bar it sits
// in once the notes on either side of it have had their share. Runs once per
// movement, after parsing, because bar positions only exist when the whole
// item list is known. Mirrors the bar arithmetic in abc.ts — pickup-aware, and
// tuplet members advance on cumulative sounding position.
function resolveFillRests(mv: Movement, ctx: Ctx, items: Item[]): void {
  const needsChords = items.some(i => i.kind === 'mark' && i.mark.t === 'chordline');
  // The walk also stamps every note with where it falls (NoteItem.tick), which
  // is what an M anywhere in the document is placed by — so a document with
  // marks in it is walked whether or not it has an R or a chart to resolve.
  if (!needsChords && !ctx.marks.length && !items.some(i => i.kind === 'note' && i.fill)) return;
  const spb = TICKS_PER_WHOLE / mv.meter.den;
  const barTicks = mv.meter.bn * spb;
  let pos = 0;
  let cap = mv.pickup ?? barTicks;
  let abs = 0;   // absolute ticks from the start of the movement
  let tup: { p: number; q: number; r: number; start: number; cum: number; seen: number } | null = null;
  // The chord charts, in the order written, each with the bar it anchors to.
  // Laid out after the walk rather than during it: a looping form fills the
  // bars up to whatever comes next, and what comes next — the following
  // chart, or the end of the music — isn't known until the walk is done.
  const charts: {
    bars: ChordWord[][]; order: number[]; loop: boolean; at: number;
    cues: { n: number; idx: number; src: number }[][];
  }[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (item.kind === 'mark') {
      if (item.mark.t === 'chordline') {
        // Anchor to the bar about to be written. Mid-bar, that's the next one.
        const at = pos === 0 ? abs : abs + (cap - pos);
        if (pos !== 0) {
          ctx.warnings.push({ span: item.src, msg: 'Chord line lands mid-bar — anchored to the next barline.' });
        }
        charts.push({ ...item.mark, at });
        continue;
      }
      // An explicit barline starts a new bar wherever it lands.
      if (item.mark.t === 'bar' || item.mark.t === 'multirest') {
        if (pos !== 0) { abs += cap - pos; }
        pos = 0; cap = barTicks;
      }
      continue;
    }

    item.tick = abs;

    if (item.fill) {
      const left = cap - pos;
      if (left <= 0) {
        ctx.warnings.push({ span: item.src, msg: 'R has no room — the bar is already full.' });
        item.dur = 0;
        continue;
      }
      // Room left over once what follows has taken its share. The modulo is
      // for material that runs past this bar (`R 1 1 1 1 1 |`): only the
      // remainder has to fit here, and a whole number of bars' worth after R
      // leaves R the whole bar, which is the plain `R |` case.
      let dur = left - (spaceAfterFill(items, idx) % barTicks);
      while (dur <= 0) dur += barTicks;
      item.dur = dur;
      abs += dur;
      pos += dur;
      while (pos >= cap) { pos -= cap; cap = barTicks; }
      continue;
    }

    const before = pos;
    if (item.tuplet) tup = { ...item.tuplet, start: pos, cum: 0, seen: 0 };
    if (item.inTuplet && tup) {
      tup.cum += item.dur;
      tup.seen++;
      pos = tup.start + Math.round(tup.cum * tup.q / tup.p);
      if (tup.seen >= tup.r) tup = null;
    } else {
      pos += item.dur;
    }
    abs += pos - before;
    while (pos >= cap) { pos -= cap; cap = barTicks; }
  }

  // The music ends at the barline that closes it, so a form that loops fills
  // whole bars right to the end.
  const end = abs + (pos === 0 ? 0 : cap - pos);
  for (let i = 0; i < charts.length; i++) {
    const c = charts[i];
    if (!c.order.length) continue;
    // A chart runs until the next one takes over, or until the music stops.
    const stop = i + 1 < charts.length ? charts[i + 1].at : end;
    // A looping form goes round as many times as that takes — but always at
    // least once through, so a form longer than the music still reads whole.
    const bars = c.loop
      ? Math.max(c.order.length, Math.ceil((stop - c.at) / barTicks))
      : c.order.length;
    // A bar the form goes round to a second time is the same bar of writing —
    // and a mark in it is one place in the recording, not one per time round.
    const marked = new Set<number>();
    for (let k = 0; k < bars; k++) {
      const bi = c.order[k % c.order.length];
      const chords = c.bars[bi];
      const barStart = c.at + k * barTicks;
      const beats = chordBeatOffsets(chords.length, mv.meter.bn);
      chords.forEach((ch, j) => {
        mv.chords.push({ tick: barStart + Math.round(beats[j] * spb), sym: ch.sym, src: ch.src, lead: ch.lead, run: ch.run });
      });
      if (marked.has(bi)) continue;
      marked.add(bi);
      for (const q of c.cues[bi] ?? []) {
        // On the beat of the chord it was written in front of — or, written
        // after the last of them, on the barline that ends the bar.
        const off = !beats.length ? 0
          : q.idx < beats.length ? Math.round(beats[q.idx] * spb)
          : barTicks;
        mv.cues.push({ tick: barStart + off, n: q.n, src: q.src });
      }
    }
  }
}

// A barline that lands mid-bar gets the rest it implies: every bar is padded
// out to the meter, exactly as if an `R` had been written at the end of it.
// Both a short bar (`1 1 |` → two beats' rest) and one that spilled over
// (`1 1 1 1 1 |` → the stray beat plus three beats' rest) come out as whole
// bars. Runs after resolveFillRests, so every duration is already known and
// the padding never has to guess. The absolute clock is untouched: the
// remainder these rests occupy is exactly what the barline used to skip, so
// chord ticks stay where the chord pass put them.
function padShortBars(mv: Movement, src: Item[]): Item[] {
  const barTicks = mv.meter.bn * (TICKS_PER_WHOLE / mv.meter.den);
  const items: Item[] = [];
  let pos = 0;
  let cap = mv.pickup ?? barTicks;
  let tup: { p: number; q: number; r: number; start: number; cum: number; seen: number } | null = null;

  for (const item of src) {
    if (item.kind === 'mark') {
      // Only the marks that actually start a new bar; a repeat sign or an
      // ending bracket can sit mid-bar without closing it.
      if (item.mark.t === 'bar' || item.mark.t === 'multirest') {
        if (pos !== 0) {
          items.push({
            kind: 'note', pitches: [], perc: false, dur: cap - pos, tie: false,
            slurOpen: 0, slurClose: 0, decos: [], inTuplet: false, src: item.src,
          });
          pos = 0;
        }
        cap = barTicks;
      }
      items.push(item);
      continue;
    }

    items.push(item);
    if (item.tuplet) tup = { ...item.tuplet, start: pos, cum: 0, seen: 0 };
    if (item.inTuplet && tup) {
      tup.cum += item.dur;
      tup.seen++;
      pos = tup.start + Math.round(tup.cum * tup.q / tup.p);
      if (tup.seen >= tup.r) tup = null;
    } else {
      pos += item.dur;
    }
    while (pos >= cap) { pos -= cap; cap = barTicks; }
  }
  return items;
}

// ── note tokens ──────────────────────────────────────────────────────
//
// A note is a run of digits with duration/accidental/octave marks around it.
// jianpu-ly says order doesn't matter within a note (#1 == 1#, s1 == 1s), and
// several digits in one token make a chord (,135' is a three-note chord).
//
// Binding rules for a multi-digit (chord) token, which is where "order doesn't
// matter" becomes ambiguous:
//   • an accidental binds to the digit AFTER it when there is one (so 1b3 is
//     the chord 1 + ♭3, matching the README), otherwise to the digit before;
//   • an octave mark binds to the digit BEFORE it when there is one (the dot
//     sits over the number it raises), otherwise to the digit after.
// For a single-digit token both rules collapse to "this note", so #1/1#/'1/1'
// all behave identically as documented.
//
// Octave marks come in two spellings, and they mean the same thing and mix
// freely: jianpu-ly's ' and , (the dots above and below the number), and + and
// - . The ' and , are also the standalone register marks — one pair of
// characters for "an octave up/down" wherever it's written. A written = is the
// family's no-op: it moves nothing, and exists so a line can show at a glance
// that a bare note was meant to be bare.
const NOTE_CHARS = /^[0-9xX#bf',+\-=.\\sqecdh/]+$/;

// ── letter notes ─────────────────────────────────────────────────────
// The other way to write a pitch: by name rather than by number. `c` is
// middle C, `c'` the octave above it, `f#` an F sharp — and everything after
// the letter is read exactly as it is on a number, so `c\` is a quaver and
// `c.` a dotted crotchet.
//
// What tells it apart from a number is that it carries no digit — `c1` is a
// crotchet on degree 1 and `f3` a flat third, while `c` and `f` are notes.
//
// Everything else about it reads the same as a number, the register included:
// `c` is middle C, but under a standalone ' it is the C above, and a bare =
// puts it back — `' c = c` is the C above middle C and then middle C again.
// The letter says WHICH note; the base register says which octave you are
// writing in, and it says it to every note on the line.
//
// The degree it comes out as depends on the key in force, which is the whole
// point: write `c` in 1=Bb and the page reads 2, because that's what a C is
// there. It's the same machine either way past this point — a letter note is
// turned into a degree the moment it's read, and nothing downstream can tell
// which spelling it was written in.
//
// The marks go AFTER the letter — `c#`, `c\`, `c'` — with one exception: the
// register marks may also lead, so `'d` and `d'` are the same note. They can
// because they are the only marks that are not also note names: a leading `b`
// or `f` is a B or an F rather than a flat, and a leading `c`, `d` or `e` is
// the note rather than the beat, so for every other mark "in front" is a
// spelling that would have to mean something else. Writing one there is
// caught and pointed at the spelling that works.
const LETTER_NOTE = /^[',+\-=]*[A-Ga-g][#bf',+\-=.\\sqecdh/]*$/;
// A token that would be a letter note if its marks were on the other side.
const LETTER_MARKS_FIRST = /^[#bf',+\-=.\\sqecdh/]+$/;
const LETTER_INDEX: Record<string, number> = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };

// The same token with every mark moved behind the letter, for that hint.
export function letterMarksAfter(word: string): string {
  const at = word.search(/[A-Ga-g]/);
  return word[at] + word.slice(0, at) + word.slice(at + 1);
}

// Is this a letter note written back to front — `#c` for `c#`?
export function isBackwardsLetterNote(word: string): boolean {
  return LETTER_MARKS_FIRST.test(word) && /[A-Ga-g]/.test(word) && !LETTER_NOTE.test(word);
}

// The degree, octave and accidental a letter note stands for under `key`.
// `register` is 0 for the octave that starts at middle C, +1 for the one
// above — the base register plus whatever the note's own marks added to it —
// and `acc` is the semitones the written # / b moved the letter by.
function letterToPitch(letterIdx: number, acc: number, register: number, key: KeySig): Pitch {
  const tonicIdx = LETTER_PC.indexOf(key.tonicLetterPc);
  const degree = (((letterIdx - tonicIdx) % 7) + 7) % 7 + 1;
  // How many octaves up from the tonic the scale had to climb to reach this
  // letter — the same sum degreeToSpelling does, run backwards.
  const carry = Math.floor((tonicIdx + degree - 1) / 7);
  // The signature already puts an accidental on this letter; what's stored is
  // the difference, so the note sounds where it was written whatever the key
  // does. A C in 1=G is degree 4 with nothing on it; an F in 1=G is degree 7
  // flattened, which is exactly how jianpu writes an F natural there.
  return { degree, octave: register - carry, acc: acc - sigAccidentals(key.sharps)[LETTER_PC[letterIdx]] };
}

// ── the old angle spelling ───────────────────────────────────────────
// > and < used to be a third spelling of the same marks — on a note (1>) and
// standing alone as the register (>>). They're gone: the dots do that job
// everywhere now, and one spelling for one thing is worth more than the
// choice was. Nothing here reads them, so a document still holding them is
// caught and pointed at the new spelling rather than quietly losing an octave.
//
// The v3 → v4 migration respells saved documents on load, and it finds the
// marks BY these shapes — which is why they live here, next to the reading
// that retired them, rather than in migrate.ts.
// A standalone register mark: > and <<.
export const OLD_REGISTER = /^(<+|>+)$/;
// A note token in the old shape — the current one with the angles added back.
const OLD_NOTE_CHARS = /^[0-9xX#bf',+\-=<>.\\sqecdh/]+$/;

// A leading \ is checked because a token that starts with one has always been
// a LilyPond command rather than a note (that's what made \[ its own
// migration), so the < in a \<x has never been an octave mark.
export function isOldNote(word: string): boolean {
  return /[<>]/.test(word) && /[0-9xX]/.test(word)
    && !word.startsWith('\\') && OLD_NOTE_CHARS.test(word);
}

// Is this token one the old spelling reached into? Grace notes aren't in here
// any more: their insides are ordinary note tokens now, so a stale < inside a
// bracket is caught as the note it's on rather than as part of a grace list.
export function hasOldOctave(word: string): boolean {
  return OLD_REGISTER.test(word) || isOldNote(word);
}

// The same token in the spelling that replaced it. > and < map one for one
// onto ' and , — same direction, same position, same count — which is what
// makes the migration a substitution rather than a rewrite.
export function respellOldOctaves(word: string): string {
  return word.replace(/</g, ',').replace(/>/g, "'");
}

function parseNoteToken(
  T: string, span: Span, baseOctave: number, defaultDur: number, baseDur: number,
  mv: Movement, ctx: Ctx, key: KeySig,
): NoteItem | null {
  // A letter note is a note written by name — see LETTER_NOTE. It's read by
  // the same loop as a number, with the letter standing in for the digit.
  const letterAt = LETTER_NOTE.test(T) ? T.search(/[A-Ga-g]/) : -1;
  const letter = letterAt < 0 ? -1 : LETTER_INDEX[T[letterAt].toLowerCase()];
  if (letter < 0) {
    if (!NOTE_CHARS.test(T)) return null;
    if (!/[0-9xX]/.test(T)) return null;
  }

  const A = (start: number, end: number, label: string, cls: AnnClass, detail?: string) =>
    ctx.ann.push({ start: span.start + start, end: span.start + end, label, detail, cls });

  const body = T;

  let dur = defaultDur;
  let durSet = false;
  let dots = 0;
  let perc = false;
  const pitches: Pitch[] = [];
  // Index into `pitches` of the digit most recently seen, and the marks
  // waiting for the next digit.
  let last = -1;
  let pendAcc: number | null = null;
  let pendOct = 0;
  // A letter counts as the token's one digit: the marks around it bind to it
  // exactly as they bind to a number.
  const digitCount = (body.match(/[0-9xX]/g) ?? []).length + (letter >= 0 ? 1 : 0);

  const crotchetsPerBeat = 4 / mv.meter.den;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    // The letter itself. It goes in as a placeholder — degree 0, in whatever
    // register is in force — and is turned into a real degree once the whole
    // token has been read and the accidental and octave marks on it are known.
    if (letter >= 0 && i === letterAt) {
      pitches.push({ degree: 0, octave: baseOctave + pendOct, acc: pendAcc });
      pendOct = 0; pendAcc = null;
      last = 0;
      continue;
    }

    if (c >= '0' && c <= '9') {
      const n = Number(c);
      if (n === 0) {
        pitches.push({ degree: 0, octave: baseOctave, acc: null });
        last = pitches.length - 1;
        A(i, i + 1, 'rest', 'rest', 'silence');
      } else {
        // 8 and 9 are shorthand for 1' and 2'.
        const degree = n >= 8 ? n - 7 : n;
        const oct = n >= 8 ? 1 : 0;
        pitches.push({ degree, octave: baseOctave + oct, acc: null });
        last = pitches.length - 1;
        const p = pitches[last];
        A(i, i + 1, `${SOLFEGE[degree]} · degree ${degree}`, 'degree',
          n >= 8 ? `shorthand for ${degree}′` : undefined);
        // A mark that was waiting for a digit lands here.
        if (pendAcc !== null) { p.acc = pendAcc; pendAcc = null; }
        if (pendOct) { p.octave += pendOct; pendOct = 0; }
      }
      if (pendAcc !== null && pitches[last]) { pitches[last].acc = pendAcc; pendAcc = null; }
      if (pendOct && pitches[last]) { pitches[last].octave += pendOct; pendOct = 0; }
      continue;
    }

    if (c === 'x' || c === 'X') {
      perc = true;
      pitches.push({ degree: 0, octave: baseOctave, acc: null });
      last = pitches.length - 1;
      A(i, i + 1, 'percussion beat', 'perc', 'unpitched');
      continue;
    }

    if (c === '#' || c === 'b' || c === 'f') {
      // b and f both mean flat — jianpu-ly spells it b, but f reads more
      // naturally to anyone used to "flat".
      const acc = c === '#' ? 1 : -1;
      const name = c === '#' ? 'sharp' : 'flat';
      // Bind forward when a digit still follows, else back onto the last.
      const laterDigit = /[0-9]/.test(body.slice(i + 1));
      if (laterDigit) {
        pendAcc = acc;
        A(i, i + 1, name, 'acc', 'raises the next degree a semitone'.replace('raises', acc > 0 ? 'raises' : 'lowers'));
      } else if (last >= 0) {
        pitches[last].acc = acc;
        const what = letter >= 0 ? LETTER_NAME[letter] : `degree ${pitches[last].degree}`;
        A(i, i + 1, name, 'acc', `${acc > 0 ? 'raises' : 'lowers'} ${what} a semitone`);
      } else {
        pendAcc = acc;
        A(i, i + 1, name, 'acc');
      }
      continue;
    }

    if (c === "'" || c === ',' || c === '+' || c === '-') {
      const step = c === "'" || c === '+' ? 1 : -1;
      const name = step > 0 ? 'octave up' : 'octave down';
      // Bind backward onto the digit it sits over, else forward.
      if (last >= 0 && digitCount > 0) {
        pitches[last].octave += step;
        const what = letter >= 0 ? LETTER_NAME[letter] : `degree ${pitches[last].degree || 0}`;
        A(i, i + 1, name, 'octave', `${what} ${step > 0 ? 'up' : 'down'} an octave`);
      } else {
        pendOct += step;
        A(i, i + 1, name, 'octave');
      }
      continue;
    }

    // = says "no octave mark here" — it moves nothing, and exists so a written
    // line can show that a note sits at the base octave on purpose.
    if (c === '=') {
      A(i, i + 1, 'no octave change', 'octave',
        letter >= 0 ? `${LETTER_NAME[letter]} stays at the base octave`
          : last >= 0 && digitCount > 0
          ? `degree ${pitches[last].degree || 0} stays at the base octave`
          : 'stays at the base octave');
      continue;
    }

    if (DUR_LETTER[c] != null) {
      dur = DUR_LETTER[c]; durSet = true;
      A(i, i + 1, DUR_NAME[dur] ?? 'note value', 'dur', durDetail(dur, crotchetsPerBeat));
      continue;
    }

    if (c === '\\' || c === '/') {
      // Halve or double, counted off the beat in force — the crotchet unless a
      // `\( … )` group set another one: 1\ is a quaver, 1\\ a semiquaver, 1/ a
      // minim, 1// a semibreve. A trailing . still dots whatever you land on,
      // so 1/. is a dotted minim.
      //
      // NB: upstream jianpu-ly spells TREMOLO with slashes (1///). We can't
      // engrave tremolo through abcjs anyway, so / is free for this.
      let j = i;
      while (j < body.length && body[j] === c) j++;
      dur = scaleDur(baseDur, body.slice(i, j));
      durSet = true;
      A(i, j, DUR_NAME[dur] ?? 'note value', 'dur', durDetail(dur, crotchetsPerBeat));
      i = j - 1;
      continue;
    }

    if (c === '.') {
      dots++;
      // Each dot adds half of what the one before it added, the way dots have
      // always worked: 1. is half as long again, 1.. half of THAT again on top.
      A(i, i + 1, DOT_NAME[dots] ?? `${dots} dots`, 'dot',
        dots === 1 ? 'half as long again' : 'and half of that again');
      continue;
    }
  }

  if (!durSet && !pitches.length) return null;
  dur = dur * dotFactor(dots);
  // A dotted 64th is 3 ticks — still integral. Anything finer isn't.
  if (!Number.isInteger(dur)) {
    ctx.warnings.push({ span, msg: `"${T}" is shorter than this app can place exactly — rounded.` });
    dur = Math.max(1, Math.round(dur));
  }

  // The letter becomes a degree, now that the marks that were waiting on it
  // have all been read.
  if (letter >= 0 && pitches.length) {
    const written = pitches[0].acc ?? 0;
    const register = pitches[0].octave;
    const p = letterToPitch(letter, written, register, key);
    pitches[0] = p;
    const sign = written > 0 ? '#'.repeat(written) : written < 0 ? 'b'.repeat(-written) : '';
    const num = (p.acc && p.acc > 0 ? '#'.repeat(p.acc) : p.acc && p.acc < 0 ? 'b'.repeat(-p.acc) : '') + p.degree;
    A(letterAt, letterAt + 1, `${LETTER_NAME[letter]}${sign} · ${num}`, 'degree',
      register === 0 ? 'the octave from middle C'
        : `${Math.abs(register) === 1 ? 'an octave' : `${Math.abs(register)} octaves`} ${register > 0 ? 'above' : 'below'} middle C`);
  }

  const isRest = !perc && pitches.length > 0 && pitches.every(p => p.degree === 0);

  return {
    kind: 'note',
    pitches: perc || isRest ? [] : pitches.filter(p => p.degree > 0),
    perc,
    dur,
    tie: false,
    slurOpen: 0,
    slurClose: 0,
    decos: [],
    inTuplet: false,
    src: span,
  };
}

// ── tuplets ──────────────────────────────────────────────────────────
// Standard "in the time of" denominators.
function tupletQ(p: number): number {
  if (p === 2 || p === 4 || p === 8) return 3;
  return 2;
}
function closeTuplet(t: { p: number; items: NoteItem[]; span: Span }, ctx: Ctx) {
  if (!t.items.length) {
    ctx.warnings.push({ span: t.span, msg: 'Empty tuplet — nothing between [ and ].' });
    return;
  }
  const q = tupletQ(t.p);
  t.items[0].tuplet = { p: t.p, q, r: t.items.length };
  // The group sounds q/p of its written length. Warn if that doesn't land on
  // a whole tick, since the bar cursor then can't be exact.
  const nominal = t.items.reduce((s, n) => s + n.dur, 0);
  if ((nominal * q) % t.p !== 0) {
    ctx.warnings.push({ span: t.span, msg: `A ${t.p}:${q} tuplet of these values doesn't divide evenly — bar positions are rounded.` });
  }
}

// ── key signatures ───────────────────────────────────────────────────
function makeKey(degree: number, letter: string, accs: string, label: string): KeySig {
  const acc = (accs.match(/#/g)?.length ?? 0) - (accs.match(/b/g)?.length ?? 0);
  const letterIdx = LETTER_NAME.indexOf(letter);
  const pc = (LETTER_PC[letterIdx] + acc + 120) % 12;

  // Walk back (degree − 1) scale steps to find do.
  const tonicPc = (pc - MAJOR_STEPS[degree - 1] + 120) % 12;
  const tonicLetterIdx = ((letterIdx - (degree - 1)) % 7 + 7) % 7;
  const tonicLetterPc = LETTER_PC[tonicLetterIdx];
  // The tonic's own accidental is whatever turns its natural letter into tonicPc.
  let tonicAcc = tonicPc - tonicLetterPc;
  if (tonicAcc > 6) tonicAcc -= 12;
  if (tonicAcc < -6) tonicAcc += 12;
  const sharps = LETTER_FIFTHS[LETTER_NAME[tonicLetterIdx]] + 7 * tonicAcc;

  const minor = degree === 6;
  const accStr = tonicAcc > 0 ? '#'.repeat(tonicAcc) : 'b'.repeat(-tonicAcc);
  const name = minor
    ? `${letter}${accs}m`
    : `${LETTER_NAME[tonicLetterIdx]}${accStr}`;
  return { tonicPc, tonicLetterPc, sharps, name, minor, label };
}

// The printed key signature from a K= token. Independent of the 1= tonic:
// this only decides which accidentals appear in the signature, and therefore
// which ones have to be written out on the notes.
function makePrintKey(letter: string, accs: string, minor: boolean): { name: string; sharps: number } {
  const acc = (accs.match(/#/g)?.length ?? 0) - (accs.match(/b/g)?.length ?? 0);
  // A minor key prints its relative major's signature — a minor third up,
  // which is three steps anticlockwise on the circle of fifths.
  const sharps = LETTER_FIFTHS[letter] + 7 * acc - (minor ? 3 : 0);
  const accStr = acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc);
  return { name: `${letter}${accStr}${minor ? 'm' : ''}`, sharps };
}

function sigCount(sharps: number): string {
  if (sharps === 0) return 'no sharps or flats';
  const n = Math.abs(sharps);
  return `${n} ${sharps > 0 ? 'sharp' : 'flat'}${n === 1 ? '' : 's'}`;
}

// The natural-letter index and MIDI of a jianpu degree under a key.
// Degree 1 with no octave marks sits in the octave starting at middle C.
export function degreeToSpelling(
  p: Pitch, key: KeySig, sigAcc: Record<number, number>,
): { letterPc: number; acc: number; midi: number } {
  const tonicLetterIdx = LETTER_PC.indexOf(key.tonicLetterPc);
  const seq = tonicLetterIdx + (p.degree - 1);
  const carry = Math.floor(seq / 7);
  const letterIdx = ((seq % 7) + 7) % 7;
  const letterPc = LETTER_PC[letterIdx];
  // Under the signature this letter already carries an accidental; an
  // explicit # / b in the source alters the SCALE degree by a semitone.
  const acc = p.acc == null ? sigAcc[letterPc] : sigAcc[letterPc] + p.acc;
  const midi = 12 * (5 + carry + p.octave) + letterPc + acc;
  return { letterPc, acc, midi };
}

// ── guitar chords (LilyPond chordmode subset) ────────────────────────
const LY_ROOT: Record<string, string> = {
  c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', a: 'A', b: 'B',
};
const LY_QUALITY: Record<string, string> = {
  '': '', 'm': 'm', '7': '7', 'm7': 'm7', 'maj7': 'maj7', 'maj': 'maj7',
  '6': '6', 'm6': 'm6', '9': '9', 'm9': 'm9', 'maj9': 'maj9',
  'dim': 'dim', 'dim7': 'dim7', 'aug': '+', 'sus4': 'sus4', 'sus2': 'sus2',
  '7sus4': '7sus4', '13': '13', '11': '11',
};

function parseChordMode(words: ChordWord[], ctx: Ctx): ChordSym[] {
  const out: ChordSym[] = [];
  let tick = 0;
  let dur = TICKS_PER_CROTCHET;   // LilyPond's duration is sticky, default 4
  for (const { sym: word, src } of words) {
    const m = /^([a-g])((?:is|es|s)*)(\d+)?(\.*)(?::(.*))?$/.exec(word);
    if (!m) {
      ctx.warnings.push({ span: src, msg: `Couldn't read the chord "${word}" — skipped.` });
      continue;
    }
    let root = LY_ROOT[m[1]];
    // LilyPond's Dutch note names: "is" raises, "es" lowers, and after a or e
    // the e elides (as = a-flat, es = e-flat). Consume the suffixes in order —
    // matching /es|s/ globally would find the s inside "is" and turn fis into
    // an F sharp AND flat.
    let alt = m[2];
    while (alt) {
      if (alt.startsWith('is')) { root += '#'; alt = alt.slice(2); }
      else if (alt.startsWith('es')) { root += 'b'; alt = alt.slice(2); }
      else if (alt === 's' && (m[1] === 'a' || m[1] === 'e')) { root += 'b'; alt = ''; }
      else break;
    }
    if (m[3]) {
      // LilyPond's own dots, and they stack LilyPond's way: c4. is 3/8, c4.. is
      // 7/16. Rounded, since a dot or two past a 64th stops landing on a tick.
      dur = Math.max(1, Math.round(TICKS_PER_WHOLE / Number(m[3]) * dotFactor(m[4].length)));
    }
    const qualKey = (m[5] ?? '').trim();
    const qual = LY_QUALITY[qualKey] ?? qualKey;
    out.push({ tick, sym: root + qual, src });
    tick += dur;
  }
  return out;
}

// Whitespace-separated words of `s`, each carrying where it sits in the
// document — `at` is where `s` itself starts there.
// ── chord charts ─────────────────────────────────────────────────────
// The bars of a chord chart, and the order they are played in.
//
// Bars are cut at | — and at a newline, when the line didn't end on one, so a
// form can be pasted in laid out the way it is read. A barline at the HEAD of
// a line opens that line rather than closing an empty bar in front of it, so
// both house styles come out the same:
//
//   |: G G7/B | C7 C#dim :|          |: G G7/B | C7 C#dim
//   G7 | |                           |  G7     |          :|
//
// |: … :| plays its section twice (`:|x3` three times; `:|:` closes one
// section and opens the next). The section is written once and PLAYED twice:
// `bars` is what was typed and `order` the indices to play, so every chord
// symbol keeps exactly one set of source characters — which is what a
// transpose rewrites and what a diagnostic underlines.
//
// `final` is set by a closing |. — the chart says out loud that the form ends
// there, which is how a block form asks not to be looped.
function parseChordChart(
  text: string, at: number, ctx: Ctx,
): { bars: ChordWord[][]; order: number[]; final: boolean; cues: ChartCue[][] } {
  const bars: ChordWord[][] = [];
  // The M's each bar was marked with, alongside it — see MarkItem's chordline.
  const cues: ChartCue[][] = [];
  const order: number[] = [];
  let seg = 0;              // where the bar being read starts
  let repeatFrom = 0;       // the index in `order` an open |: section starts at
  let openSpan: Span | null = null;
  let head = true;          // nothing but space since the last newline

  // Which hand the chart is written in, decided once by its FIRST line, since
  // there's no telling from a line on its own. Both are ordinary lead-sheet
  // hands and they disagree about exactly one thing — a | at the head of a
  // line:
  //
  //   | Am | D7 | G |   |      bars fenced on BOTH sides: the | that opens
  //   | Em | A7 | D |   |      the line is the one that closed the last bar
  //
  //   Am | D7 | G |   |        each bar followed by the | that ends it: the
  //      |    |   | G7 |       | at the head of the line ends an empty bar
  //
  // Read the second one the first way and every line after the first loses a
  // bar — which is a chord landing a bar early, over and over, all the way
  // down the form. So the opening barline is only an opening barline in a
  // chart that opened with one. A |: is no evidence either way: a repeat has
  // to go at the head of its section whichever hand you write in.
  const firstLine = text.split('\n').find(l => l.trim()) ?? '';
  const fenced = /^\s*\|(?!:)/.test(firstLine);

  // A bar's worth of words — less any M1 the bar was marked with, which is a
  // spot in the writing rather than a chord to play.
  const close = (end: number) => {
    const kept: ChordWord[] = [];
    const marked: ChartCue[] = [];
    for (const w of wordSpans(text.slice(seg, end), at + seg)) {
      const n = markWord(w.sym, w.src, ctx);
      // A mark stands in FRONT of a chord: it keeps the index of the symbol it
      // was written before, which is what puts it on that beat rather than on
      // the top of the bar.
      if (n != null) marked.push({ n, idx: kept.length, src: w.src.start });
      else kept.push(w);
    }
    bars.push(kept);
    cues.push(marked);
    order.push(bars.length - 1);
    seg = end;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      if (text.slice(seg, i).trim()) close(i);
      seg = i + 1; head = true; i++;
      continue;
    }
    const m = (c === '|' || c === ':') && /^(?::\|:|:\|x?(\d+)|:\||\|:|\|\.|\|\||\|)/.exec(text.slice(i));
    if (!m) {
      if (c.trim()) head = false;
      i++;
      continue;
    }
    const tok = m[0];
    const span: Span = { start: at + i, end: at + i + tok.length };
    // An opening barline never closes an empty bar; every other one does,
    // which is what makes `G7 | |` a bar of G7 and then a bar of nothing.
    // What counts as an opening one is `fenced`, above.
    if (tok === '|:') { if (text.slice(seg, i).trim()) close(i); }
    else if (!head || !fenced) close(i);
    seg = i + tok.length;
    head = false;

    if (tok.startsWith(':|')) {
      const times = m[1] ? Number(m[1]) : 2;
      const section = order.slice(repeatFrom);
      if (!section.length) {
        ctx.warnings.push({ span, msg: 'Repeat with no bars in front of it — the :| does nothing.' });
      } else if (times < 1 || times > 64) {
        ctx.warnings.push({ span, msg: `Repeat ×${times} is out of range — played once.` });
      } else {
        for (let k = 1; k < times; k++) order.push(...section);
      }
      repeatFrom = order.length;
      openSpan = null;
    }
    if (tok === '|:' || tok === ':|:') { openSpan = span; repeatFrom = order.length; }
    i += tok.length;
  }
  if (text.slice(seg).trim()) close(text.length);
  if (openSpan && order.length > repeatFrom) {
    ctx.warnings.push({ span: openSpan, msg: 'Repeat opened with |: but never closed with :| — it plays once.' });
  }
  groupTargets(bars, ctx);
  return { bars, order, cues, final: /\|\.\s*$/.test(text) };
}

// Two bits of punctuation a chart's words can carry, settled here once the
// bars are read:
//
//   V7 / II          a slash with space round it is still one chord — the
//                    words either side of it are joined (V7/II, C/E).
//   [II-7 | V7] / VI-
//                    a bracketed run (a II-V, say — barlines inside it are
//                    fine) and the chord it's the II-V OF: every numeral in
//                    the run is read in that chord's frame, exactly as if
//                    each were written II-7/VI-, V7/VI- (in B♭: A-7 D7). Each
//                    carries the target as `lead` too, so the run can be
//                    drawn as one group with the target said once.
//
// The brackets, the lone slashes and the target stop being words — they're
// punctuation on the chords, not chords, and take no beat.
function groupTargets(bars: ChordWord[][], ctx: Ctx): void {
  const drop = new Set<ChordWord>();
  let inGroup = false;
  let run: ChordWord[] = [];               // the chords in the open run
  let closed: ChordWord[] | null = null;   // a run just closed
  let slash = false;                       // …and its / is down, target next
  let joinTo: ChordWord | null = null;     // a chord waiting for what follows its /

  const lead = (target: string, src: Span) => {
    if (!closed) return;
    if (isRoman(target)) {
      for (const w of closed) {
        w.lead = target;
        if (isRoman(w.sym)) w.sym = `${w.sym}/${target}`;
      }
      if (closed.length === 1) closed[0].run = 'both';
      else { closed[0].run = 'open'; closed[closed.length - 1].run = 'close'; }
    }
    else ctx.warnings.push({ span: src, msg: `"${target}" isn't a roman numeral — the run in [ ] resolves to a numeral.` });
    closed = null; slash = false;
  };
  const join = (to: ChordWord, w: ChordWord, text: string) => {
    to.sym += text;
    to.src = { start: to.src.start, end: w.src.end };
    drop.add(w);
  };

  for (const bar of bars) {
    let prev: ChordWord | null = null;     // the last chord kept in this bar
    for (const w of bar) {
      if (closed) {
        if (w.sym === '/') { slash = true; drop.add(w); continue; }
        if (w.sym.startsWith('/') && w.sym.length > 1) { drop.add(w); lead(w.sym.slice(1), w.src); continue; }
        if (slash) { drop.add(w); lead(w.sym, w.src); continue; }
        closed = null;   // nothing to resolve to after all
      }
      if (joinTo) { join(joinTo, w, w.sym); prev = joinTo; joinTo = null; continue; }
      if (w.sym === '/' && prev) { prev.sym += '/'; joinTo = prev; drop.add(w); continue; }
      if (w.sym.startsWith('/') && w.sym.length > 1 && prev && !w.sym.startsWith('/[')) { join(prev, w, w.sym); continue; }

      let sym = w.sym;
      let { start, end } = w.src;
      if (sym.startsWith('[')) { sym = sym.slice(1); start++; inGroup = true; run = []; }
      const cut = sym.indexOf(']');
      const tail = cut < 0 ? '' : sym.slice(cut + 1);
      if (cut >= 0) { end = start + cut; sym = sym.slice(0, cut); }
      if (sym) {
        w.sym = sym; w.src = { start, end };
        prev = w;
        if (inGroup) run.push(w);
        if (cut < 0 && sym.endsWith('/') && sym.length > 1) joinTo = w;
      } else drop.add(w);
      if (cut >= 0 && inGroup) {
        inGroup = false;
        closed = run.length ? run : null;
        if (tail === '/') slash = true;
        else if (tail.startsWith('/')) lead(tail.slice(1), { start: end + 2, end: end + 1 + tail.length });
      }
    }
  }
  for (const bar of bars) {
    for (let k = bar.length - 1; k >= 0; k--) if (drop.has(bar[k])) bar.splice(k, 1);
  }
}

// The words that are chords, taking every mark out of the list as it goes —
// an M1 is written among the symbols but is not one of them.
function notMarks(words: ChordWord[], ctx: Ctx): ChordWord[] {
  return words.filter(w => markWord(w.sym, w.src, ctx) == null);
}

function wordSpans(s: string, at: number): ChordWord[] {
  const out: ChordWord[] = [];
  for (const m of s.matchAll(/\S+/g)) {
    out.push({ sym: m[0], src: { start: at + (m.index as number), end: at + (m.index as number) + m[0].length } });
  }
  return out;
}

// ── lyrics ───────────────────────────────────────────────────────────
function addLyric(mv: Movement, content: string, hanzi: boolean) {
  // "1. Here is verse one" — a leading ordinal picks the verse.
  const vm = /^(\d+)\.\s*(.*)$/.exec(content);
  const verse = vm ? Number(vm[1]) : mv.lyrics.length + 1;
  const body = vm ? vm[2] : content;
  // Hanzi get one syllable per character; western lyrics split on spaces and
  // keep jianpu-ly's trailing hyphen convention (syl- la- bles).
  const syllables = hanzi
    ? Array.from(body.replace(/\s+/g, '')).map(ch => ch)
    : body.split(/\s+/).filter(Boolean);
  mv.lyrics.push({ verse, syllables });
}

// ── word tables ──────────────────────────────────────────────────────
// What CONCERT= will answer to. Written how you'd say it out loud — "Bb", "B♭"
// — and the horns themselves, since "which horn is this written for" is the
// question actually being asked.
const CONCERT_KEYS: Record<string, Pitching> = {
  c: 'C', concert: 'C',
  bb: 'Bb', 'b♭': 'Bb', 'b-flat': 'Bb', 'bflat': 'Bb',
  tenor: 'Bb', trumpet: 'Bb', soprano: 'Bb', clarinet: 'Bb',
};

const HEADER_KEYS = new Set([
  'title', 'subtitle', 'subsubtitle', 'composer', 'poet', 'arranger',
  'copyright', 'opus', 'instrument', 'dedication', 'meter', 'piece', 'tagline',
]);

const NAV_WORDS: Record<string, string> = {
  Fine: 'Fine', DC: 'D.C.', 'DC.': 'D.C.', DS: 'D.S.',
  Segno: 'Segno', ToCoda: 'To Coda', Coda: 'Coda',
  'DCalFine': 'D.C. al Fine', 'DSalFine': 'D.S. al Fine',
};

const LY_DECO: Record<string, string> = {
  p: '!p!', pp: '!pp!', ppp: '!ppp!', mp: '!mp!', mf: '!mf!',
  f: '!f!', ff: '!ff!', fff: '!fff!', sf: '!sfz!', sfz: '!sfz!',
  fermata: '!fermata!', trill: '!trill!', staccato: '!staccato!',
  accent: '!accent!', tenuto: '!tenuto!', marcato: '!marcato!',
  '>': '!>!', '<': '!<!', '!': '!crescendo(!',
};
const LY_DECO_NAME: Record<string, string> = {
  p: 'piano', pp: 'pianissimo', ppp: 'pianississimo', mp: 'mezzo-piano',
  mf: 'mezzo-forte', f: 'forte', ff: 'fortissimo', fff: 'fortississimo',
  sf: 'sforzando', sfz: 'sforzando', fermata: 'fermata', trill: 'trill',
  staccato: 'staccato', accent: 'accent', tenuto: 'tenuto', marcato: 'marcato',
};
// jianpu-ly says dynamics attach to the PREVIOUS note.
const DECO_ON_PREVIOUS = new Set([
  'p', 'pp', 'ppp', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz',
  'fermata', 'trill', 'staccato', 'accent', 'tenuto', 'marcato',
]);

const UNSUPPORTED_WORDS = new Set([
  'souyin', 'harmonic', 'up', 'down', 'bend', 'tilde',
  'slideUp', 'slideDown', 'arpUp', 'arpDown', 'arp',
  'RepeatAccidentals', 'NormalAccidentals',
]);

const IGNORED_WORDS = new Map<string, string>([
  ['NoBarNums', 'no bar numbers — layout only'],
  ['NoIndent', 'no first-line indent — layout only'],
  ['RaggedLast', 'ragged last line — layout only'],
  ['OnePage', 'keep on one page — layout only'],
  ['WithStaff', 'the original would add a western staff; this app always draws one'],
  ['angka', 'Indonesian not-angka style — layout only'],
  ['SeparateTimesig', 'old-style time signature — layout only'],
  ['ChordsRoman', 'roman-numeral chords — not engraved'],
  ['PartMidi', 'split MIDI per part — no effect here'],
]);

function abcBarline(sym: string): string {
  switch (sym) {
    case '||': return '||';
    case '|.': return '|]';
    case '.|': return '|:';
    case ':|': return ':|';
    case '|:': return '|:';
    case '|]': return '|]';
    default: return '|';
  }
}
function barlineName(sym: string): string {
  switch (sym) {
    case '||': return 'double barline';
    case '|.': return 'final barline';
    case ':|': return 'repeat back';
    case '|:': return 'repeat forward';
    default: return 'barline';
  }
}

// ── text plumbing ────────────────────────────────────────────────────
type Line = { text: string; start: number };
function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  return out;
}

// The first % that isn't inside a "quoted string".
export function indexOfComment(line: string): number {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    else if (line[i] === '%' && !inStr) return i;
  }
  return -1;
}

export type Token = { text: string; start: number };
export function tokenize(body: string, base: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < body.length) {
    if (/\s/.test(body[i])) { i++; continue; }
    let j = i;
    let inStr = false;
    while (j < body.length && (inStr || !/\s/.test(body[j]))) {
      if (body[j] === '"') inStr = !inStr;
      j++;
    }
    for (const piece of unglue(body.slice(i, j))) out.push({ text: piece.text, start: base + i + piece.at });
    i = j;
  }
  return out;
}

// Brackets written up against what they hold. `g[e f e]` and `3[ 1 2 3]` are
// how anyone actually types a bracket, and a whitespace tokenizer would hand
// the parser "g[e" and "3]" — so the bracket characters come off as tokens of
// their own first. Only the grace opener leads: a bare `[` opens an
// instrumental break, and `3[` / `\[` carry a note value that has to stay
// glued to it. `)]` is one token in its own right, so a `]` only comes off
// while what's left in front of it isn't a `)`. A token holding a "quoted
// string" is left exactly as written — the brackets in there are text.
function unglue(t: string): { text: string; at: number }[] {
  if (t.includes('"')) return [{ text: t, at: 0 }];
  const out: { text: string; at: number }[] = [];
  let head = t;
  let at = 0;
  const open = head.startsWith('g/[') ? 3 : head.startsWith('g[') ? 2 : 0;
  if (open && head.length > open) {
    out.push({ text: head.slice(0, open), at: 0 });
    head = head.slice(open);
    at = open;
  }
  const closers: { text: string; at: number }[] = [];
  while (head.length > 1 && head.endsWith(']') && !head.endsWith(')]')) {
    head = head.slice(0, -1);
    closers.unshift({ text: ']', at: at + head.length });
  }
  out.push({ text: head, at });
  out.push(...closers);
  return out;
}

// Keep the innermost annotation when ranges overlap — a note token's per-char
// annotations should win over any coarser one covering the same characters.
function dedupeAnnotations(ann: Annotation[]): Annotation[] {
  const out: Annotation[] = [];
  for (const a of ann) {
    const prev = out[out.length - 1];
    if (prev && a.start < prev.end) {
      // Overlap: keep whichever is shorter (more specific).
      if (a.end - a.start < prev.end - prev.start) out[out.length - 1] = a;
      continue;
    }
    out.push(a);
  }
  return out;
}

function newMovement(): Movement {
  return {
    headers: {},
    keySig: { ...DEFAULT_KEY },
    meter: { bn: 4, den: 4 },
    printKey: null,
    pickup: null,
    tempo: null,
    items: [],
    unders: [],
    chords: [],
    cues: [],
    lyrics: [],
  };
}
