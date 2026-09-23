// Build an ABC string from a parsed jianpu Score, for abcjs to engrave.
//
// The heavy lifting is shared with the other notation apps:
//   • spellToAbcKeyed (melodic-trainer/staff) turns a letter + accidental +
//     MIDI into an ABC token, emitting an explicit sign only when the note
//     differs from what's already sounding under the key signature.
//   • splitInBar / abcDurTokens (rhythm-library/metric) implement this repo's
//     metric rule: a note crossing the centre of a bar is written as two tied
//     notes, except for the conventional single-notehead syncopations; rests
//     never get those exceptions. In 4/4 each half-bar is a leaf, so nothing
//     is ever broken between beats 1&2 or 3&4.
//
// Everything is counted in ticks (semibreve = 128), which is exactly ABC's
// L:1/128 unit, so a tick count is also the ABC duration multiplier.

import { spellToAbcKeyed } from '../melodic-trainer/staff';
import { splitInBar, abcDurTokens, beatGroups } from '../rhythm-library/metric';
import { degreeToSpelling, keyFromSpec, sigAccidentals } from './parse';
import { respellPitch } from './retune';
import { prettyRoman, toRoman } from './roman';
import { chordRuns } from './chord-type';
import {
  ChordFont, ChordSym, Diagnostic, Item, KeySig, Movement, NoteItem, Pitch, SourceMark, Span,
  TICKS_PER_CROTCHET, TICKS_PER_WHOLE, Under, UnderKind,
} from './types';

const BARS_PER_LINE = 4;

// The span a diagnostic gets when nothing in the source can be pointed at.
// The editor widens an empty span to the whole line it lands on.
const NOWHERE: Span = { start: 0, end: 0 };

// Extra vertical space, in points, per BR beyond the first in a run. abcjs
// leaves about 61 between systems by default, so two spare BRs open up
// roughly a blank system's worth of air.
//
// The numbers view already sits its systems much further apart (NUM_STAFFSEP
// below), so 30 there barely registers as a gap at all — a spare BR has to
// open up a comparable amount of air to read as a deliberate break.
const BR_VSKIP = 30;
const BR_VSKIP_NUM = 90;

// Where a beam must BREAK inside a bar, in bar-local ticks.
//
// This is the other half of correct layout, and it's carried by whitespace:
// in ABC, notes written adjacently are beamed together and a space breaks the
// beam. Emit everything space-separated (as this file used to) and abcjs
// flags every quaver individually.
//
// Simple meters beam per beat. Compound meters beam per dotted-beat group —
// 6/8 is two groups of three quavers, not six separate ones — which is
// exactly what beatGroups already describes.
function beamBoundaries(bn: number, den: number, spb: number): Set<number> {
  const groups = den >= 8 ? beatGroups(bn, den) : Array(bn).fill(1);
  const out = new Set<number>();
  let p = 0;
  for (const g of groups) { out.add(p * spb); p += g; }
  return out;
}

export type BuildResult = {
  abc: string;
  warnings: Diagnostic[];
  // True when the source placed its own BR breaks. abcjs's `wrap` option
  // re-flows the score and ignores newlines in the body, so the caller has to
  // turn it off for this score or the manual breaks do nothing.
  manualBreaks: boolean;
  // Where each ENGRAVED note came from in the source text, in the order abcjs
  // will lay them out. One entry per notehead — so a note split across the
  // bar's midpoint contributes two, both pointing at the token that wrote it,
  // and a rest the parser invented (a bar's padding) points at the barline
  // that implied it. That's what lets a click on the staff find its way back
  // to the character that put it there. null where nothing sensible maps.
  noteSpans: (Span | null)[];
  // The jianpu degree(s) each engraved note stands for — "1", "b3", "#4" —
  // lined up with noteSpans, one array per notehead group (a chord has
  // several, low to high). The numbers view draws these in place of the
  // noteheads. Always measured from the movement's ORIGIN key, so a
  // modulation doesn't restart the numbering mid-page.
  noteLabels: (string[] | null)[];
  // The same, one entry per staff engraved UNDER the music, in engraved order.
  // They're separate lists because each is a separate VOICE: abcjs hands its
  // selectable elements back staff by staff, so they can only be zipped once
  // they've been told apart — which is what `from` is for. Every engraved
  // element carries the offset it was written at, so the voices' offsets, in
  // order, cut the engraving into one piece per staff.
  unders: UnderStaff[];
  // Every chord symbol the engraving actually DRAWS, in the order abcjs draws
  // them, each with the characters that wrote it. One entry per symbol on the
  // page rather than one per chord in the source: a change that never reached
  // a notehead was never drawn, and one that carried on over several notes is
  // drawn once. That's what lets a click on a symbol find both its harmony and
  // its place in the text — the engraved chords and this list are the same
  // list, so they zip.
  chordMarks: ChordMark[];
};

// `show` is what the symbol SAYS on the page, in the parts it's drawn in:
// `main` at full size, and `target` — where a numeral leads (the II of
// V7/II), or where a bracketed run resolves — a size down after a slash. The
// engraver is handed the same words as plain text only so it makes room for
// them; staff.tsx hides its text and draws these itself.
//
// A bracketed run ([II-7 | V7] / VI-) is drawn as one group: `open` on its
// first chord puts a tall [ in front, `close` on its last a ] after, and
// `lead` — where the run resolves — is said once, after the ].
// Every chord in such a run — the middle ones too — is `lifted`, raised as a
// group above the chord row so the run reads as one unit set apart from the
// changes around it; so is a secondary (V7/VI-), the same idea for one chord.
// `inRun` is the run's target on every chord in it — what closeRuns reads to
// finish a run whose own last chord never reached the page.
export type ChordShow = { main: string; target?: string; open?: boolean; close?: boolean; lead?: string; lifted?: boolean; inRun?: string };
export type ChordMark = { sym: string; src: Span | null; show: ChordShow };

// One engraved under-staff: where its voice starts in the ABC, where each of
// its noteheads came from in the source, and the degrees they stand for (so
// the numbers view can draw it the way it draws the music — the alternative,
// with the staff lines and clef hidden, is a row of noteheads in space).
export type UnderStaff = {
  id: string;
  kind: UnderKind;
  from: number;
  spans: (Span | null)[];
  labels: (string[] | null)[];
};

// One structural token of the engraved music — the barlines, volta brackets,
// multirests and line breaks the melody laid down, in the order it laid them.
// The rhythm staff is written against this rather than against its own reading
// of the source, which is what keeps the two staves bar for bar: a repeat sign
// or a hand-placed break in the music puts the same one in the stabs.
type PlanStep =
  | { k: 'bar'; sym: string; cap: number }
  | { k: 'volta'; sym: string }
  | { k: 'multi'; bars: number }
  | { k: 'nl' }
  // A mid-piece key change, with the whole spelling state it put in force.
  // The rhythm staff throws it away (it prints no signature at all); the bass
  // staff writes it, and starts spelling its degrees the new way from there.
  | { k: 'key'; sym: string; keySig: KeySig; degreeAcc: Record<number, number>; printAcc: Record<number, number> };

// What the numbers view draws instead of a notehead. A tied continuation gets
// a dash, the way jianpu writes a held beat. A rest gets NOTHING — silence is
// already spelled perfectly well by an engraved rest, and a 0 sitting where
// the rest is only says the same thing twice.
const HELD = ['–'];

export type BuildOpts = {
  // The numbers view: the extra room overhead that a page of numbers and
  // floating chords needs.
  numbers?: boolean;
  // Chord symbols as roman numerals from the key, rather than letter names.
  // Its own switch, apart from `numbers`: how you read the notes and how you
  // read the changes are two different questions.
  roman?: boolean;
  // Which face the chord symbols are set in.
  chordFont?: ChordFont;
  // Ignore the source's own BR breaks and let the renderer re-flow instead —
  // what a phone needs, since a line plan written for a pane's width can't be
  // honoured in a hand's. It also has to be the ABC that changes rather than
  // just the render option: a BR run emits %%vskip, and abcjs's `wrap` throws
  // on a body carrying one (its line-break table is built per SECTION, and a
  // vskip starts a new line without starting a new section).
  reflow?: boolean;
  // Write the music this many octaves away from where it was typed. It moves
  // the NOTATION only — nothing here reaches playback — so a solo transcribed
  // at concert pitch can be read on a tenor, which sounds an octave and a tone
  // below what it reads, without a single character of the source changing.
  octaves?: number;
  // The same for the bass staff, and separate from it: the two staves are read
  // by different people off the same page, so the part that's been moved for
  // one of them can't be the part the other is reading.
  bassOctaves?: number;
  // What the numbers COUNT FROM. 'key' (the default) states every degree
  // against the movement's own 1=, which is the tune in one key. 'chord'
  // re-states each note against the root of the chord it's played over — in C
  // over a G7, G is 1 — which is the other way a line is read: not where it
  // sits in the key, but what shape it makes on the chord. A ii–V lick numbered
  // that way says the same thing over both bars.
  numbersFrom?: 'key' | 'chord';
};

// Which note each M in the writing belongs over.
//
// A mark takes no time and is written BETWEEN things, so what it points at is
// the next note after it — the same rule your eye uses reading the source. But
// "the next note" may well be on a staff the reader isn't looking at: an M on
// a B: line, or between the chords of a C" chart, still belongs over the tune.
// So the note that follows it only says WHEN — its tick — and the mark is then
// drawn on the tune's own note at that moment (the first one at or after it,
// since the tune may be holding while the bass moves).
//
// Searched over every movement at once, so a mark stranded after the last note
// of one doesn't reappear at the top of the next. What comes back doesn't go
// into the ABC at all — the staff DRAWS these into the chord row once abcjs is
// finished (see drawCue), so a marked score lays out exactly like an unmarked
// one.
export function markCues(movements: Movement[], marks: SourceMark[]): Map<number, number[]> {
  // Every note in the document that knows where it falls, in source order,
  // carrying the movement it belongs to.
  const all: { start: number; mv: number; tick: number }[] = [];
  // …and the tune's own, per movement, in playing order.
  const music: { start: number; tick: number }[][] = movements.map(() => []);
  for (let i = 0; i < movements.length; i++) {
    for (const item of movements[i].items) {
      if (item.kind !== 'note' || item.tick == null) continue;
      all.push({ start: item.src.start, mv: i, tick: item.tick });
      music[i].push({ start: item.src.start, tick: item.tick });
    }
    for (const u of movements[i].unders) {
      for (const item of u.items) {
        if (item.kind !== 'note' || item.tick == null) continue;
        all.push({ start: item.src.start, mv: i, tick: item.tick });
      }
    }
  }
  all.sort((a, b) => a.start - b.start);
  for (const m of music) m.sort((a, b) => a.tick - b.tick);

  // The ones written inside a C" chart already know their tick: a chart sits
  // above the bars it applies to rather than among them, so where a mark falls
  // in the FORM is the only thing that says where it falls in the music. The
  // parser works those out with the chords — see Movement.cues.
  const charted = new Map<number, { mv: number; tick: number }>();
  for (let i = 0; i < movements.length; i++) {
    for (const c of movements[i].cues) charted.set(c.src, { mv: i, tick: c.tick });
  }

  const out = new Map<number, number[]>();
  for (const mark of marks) {
    const spot = charted.get(mark.span.start) ?? all.find(n => n.start > mark.span.start);
    if (!spot) continue;
    const on = music[spot.mv].find(n => n.tick >= spot.tick);
    if (!on) continue;
    out.set(on.start, [...(out.get(on.start) ?? []), mark.n]);
  }
  return out;
}

// The family and size handed to %%gchordfont. abcjs measures the symbol with
// this to decide how much width to reserve, so it has to name a face abcjs has
// metrics for — the stylesheet then supplies the real fallback chain (and wins,
// since abcjs writes font-family as an attribute). Keep the two in step:
// pages/transcribe.css maps each of these to its actual stack.
const CHORD_FONTS: Record<ChordFont, string> = {
  jazz: '"Petaluma Script" 15',
  plain: '"Inter" 14',
};

// What a chord says on the page. Letters: the chord as written, slash bass
// and all. Numerals (`home` given): what was written if it was written as a
// numeral, else the letter chord numbered from home — split at its first
// slash into the function and where it leads, with a bracketed run's
// resolution after that.
function chordShow(chord: ChordSym, home: KeySig | null): ChordShow {
  if (!home) return { main: chord.sym };
  const text = chord.roman ? prettyRoman(chord.roman) : toRoman(chord.sym, home);
  const cut = text.indexOf('/');
  const main = cut < 0 ? text : text.slice(0, cut);
  const show: ChordShow = { main };
  // In a bracketed run, where each chord leads IS the run's target — said
  // once, after the run, rather than on every chord in it.
  if (cut >= 0 && !chord.lead) {
    show.target = text.slice(cut + 1);
    // A secondary (V7/VI-) is set like a bracketed run, just without the
    // brackets: raised off the row. A slash bass written as a degree (I/3)
    // isn't a function and stays put.
    if (/^(Sub)?[♭♯]?[IV]/.test(show.target)) show.lifted = true;
  }
  if (chord.lead) {
    show.lifted = true;
    show.inRun = prettyRoman(chord.lead);
    if (chord.run === 'open' || chord.run === 'both') show.open = true;
    if (chord.run === 'close' || chord.run === 'both') { show.close = true; show.lead = prettyRoman(chord.lead); }
  }
  return show;
}

// What abcjs is handed for a chord — only so it leaves the symbol room, since
// staff.tsx draws the symbol itself. It has to be about as wide as what's
// DRAWN, not the symbol at full size: the small runs (Δ7, ♭9, the /target)
// would otherwise each reserve full-size width, and a long symbol over a
// short note shoves the next note well along. So each run keeps the share of
// its characters its size says it takes. A slash is the division slash:
// abcjs reads a / in a chord symbol as a slash bass and drops what follows.
function roomFor(show: ChordShow): string {
  return chordRuns(show)
    .map(r => r.bracket ? 'l' : r.text.slice(0, Math.max(1, Math.round(r.text.length * r.size))))
    .join('')
    .replace(/\//g, '∕')
    .replace(/"/g, '');
}

// A bracketed run is opened on its first chord and closed on its last — but
// either may never reach the page (the music stops before the chart does, or
// a change falls where no note is). Never leave a bracket hanging: a run with
// no ] is closed, target and all, on the last of its chords that WAS drawn,
// and one whose [ went missing opens on the first that was.
function closeRuns(marks: ChordMark[]) {
  let start = -1;
  let last = -1;
  const close = () => {
    if (start < 0) return;
    const s = marks[last].show;
    if (!s.close) { s.close = true; s.lead = s.inRun; }
    start = -1;
  };
  marks.forEach((m, i) => {
    const s = m.show;
    if (s.inRun == null) { close(); return; }
    if (s.open || start < 0) { close(); start = i; s.open = true; }
    last = i;
    if (s.close) start = -1;
  });
  close();
}

// Space between systems in the numbers view, and above the first one. Without
// a staff to sit on, a chord row reads as belonging to whichever music is
// nearest, so the gap above it still wants to be bigger than the gap below —
// just not as much bigger as the first attempt made it.
//
// abcjs multiplies these by 4/3, so its own defaults are 46 and 5.7 in the
// same units. Each of these is that default plus half the extra the numbers
// view was originally given.
const NUM_STAFFSEP = 80;
const STAFFSEP = 64;
const NUM_MUSICSPACE = 15;

export function buildAbc(mv: Movement, index = 1, opts: BuildOpts = {}): BuildResult {
  const warnings: Diagnostic[] = [];
  const { bn, den } = mv.meter;
  const spb = TICKS_PER_WHOLE / den;          // ticks per notated beat
  const barTicks = bn * spb;
  const octaves = opts.octaves ?? 0;
  const bassOctaves = opts.bassOctaves ?? 0;
  // Two different signatures, deliberately. `degreeAcc` says what a jianpu
  // degree actually sounds (always relative to the 1= tonic); `printAcc` says
  // what the staff's key signature already covers, so spellToAbcKeyed only
  // writes an accidental where the note differs from what's printed. With no
  // K= they're the same map and nothing changes.
  // All three move together at a mid-piece key change (the 'key' mark below).
  let key = mv.keySig;
  let degreeAcc = sigAccidentals(key.sharps);
  let printName = mv.printKey ? mv.printKey.name : key.name;
  let printAcc = sigAccidentals(mv.printKey ? mv.printKey.sharps : key.sharps);

  // One BR anywhere means the whole movement is broken by hand — mixing
  // "some lines yours, the rest automatic" just reads as inconsistent.
  const manualBreaks = !opts.reflow
    && mv.items.some(i => i.kind === 'mark' && i.mark.t === 'linebreak');
  // A BR as the LAST thing written means "this line is finished too", so the
  // final system gets justified to the full width instead of trailing off
  // ragged. Barlines and other marks after it don't count as content.
  const endsWithBreak = (() => {
    for (let i = mv.items.length - 1; i >= 0; i--) {
      const it = mv.items[i];
      if (it.kind === 'note') return false;
      if (it.mark.t === 'linebreak') return true;
    }
    return false;
  })();

  // ── header ──────────────────────────────────────────────────────────
  const head: string[] = [`X:${index}`];
  if (mv.title) head.push(`T:${escapeField(mv.title)}`);
  if (mv.headers.subtitle) head.push(`T:${escapeField(mv.headers.subtitle)}`);
  if (mv.headers.composer) head.push(`C:${escapeField(mv.headers.composer)}`);
  if (mv.headers.poet && mv.headers.poet !== mv.headers.composer) head.push(`C:${escapeField(mv.headers.poet)}`);
  if (mv.headers.arranger) head.push(`C:arr. ${escapeField(mv.headers.arranger)}`);
  if (mv.headers.instrument) head.push(`V:1 name="${escapeField(mv.headers.instrument)}"`);
  // Chord symbols in Petaluma Script — the handwritten-chart face the melodic
  // trainer uses for its chord/key labels, so a chord reads the same across
  // the site. Annotations stay in the body font, matching the trainer's split
  // between the chord and the descriptor beside it. The engraved glyphs are
  // abcjs's own music font either way.
  head.push(`%%gchordfont ${CHORD_FONTS[opts.chordFont ?? 'jazz']}`);
  head.push('%%annotationfont "Reddit Mono" 12');
  if (opts.numbers) {
    head.push(`%%staffsep ${NUM_STAFFSEP}`);
    head.push(`%%musicspace ${NUM_MUSICSPACE}`);
  } else {
    // Over a staff too, more air between systems than abcjs's 46: the chord
    // row over each one needs room to read as its own.
    head.push(`%%staffsep ${STAFFSEP}`);
  }
  // The last line is stretched to the full width only when the source says
  // it's finished — a BR as the last thing written. Otherwise it's the line
  // still being written, and it stays ragged however full it gets: abcjs's
  // own default quietly stretches a last line once it's two-thirds across,
  // which would jump the notes about as each one is typed. (Re-flowed, the
  // last system is the renderer's own, so a finished one isn't forced.)
  if (endsWithBreak && !opts.reflow) head.push('%%stretchlast 1');
  else if (!endsWithBreak) head.push('%%stretchlast 0');
  head.push(`M:${bn}/${den}`);
  head.push('L:1/128');
  // No Q: — the tempo isn't drawn on the page. 4=143 still sets the playback
  // speed; buildEvents reads mv.tempo directly and never looks at the ABC.
  head.push(`K:${printName}`);

  // ── body ────────────────────────────────────────────────────────────
  const out: string[] = [];              // ABC tokens, joined with spaces
  // One source span per notehead written, in the order they're written. abcjs
  // hands its selectable elements back in exactly this order, so the two lists
  // line up index for index — no character arithmetic over the ABC needed.
  const noteSpans: (Span | null)[] = [];
  const noteLabels: (string[] | null)[] = [];
  // The key the whole movement is numbered against, whatever it modulates to.
  const origin = mv.keySig;
  // What the numbers are counting from when they're counting from the chord —
  // null until the first symbol lands, so a pickup before any chord is still
  // numbered in the key it was written in. See BuildOpts.numbersFrom.
  let chordOrigin: KeySig | null = null;
  let barPos = 0;                        // ticks into the current bar
  let barCap = mv.pickup ?? barTicks;    // this bar's capacity (short if a pickup)
  let barsOnLine = 0;
  // How many BRs in the run currently being written. The first ends the staff
  // line; each one after it widens the gap before the next system.
  let brRun = 0;
  let pendingBar: string | null = null;  // barline waiting to be written
  // A key change waiting to be written. Queued rather than pushed on the spot
  // so it always lands AFTER the barline, however the source ordered the two —
  // "1 2 3 4 1=Eb |" and "1 2 3 4 | 1=Eb" have to engrave the same.
  let pendingKey: string | null = null;
  let pendingPrefix: string[] = [];      // annotations waiting for a note
  const active = new Map<string, number>();   // accidentals sounding this bar
  const groups: ('R' | 'A')[] = [];      // open R{ / A{ nesting
  let altN = 0;
  // The tuplet currently being laid down, if any.
  let tup: { p: number; q: number; r: number; startBar: number; startTick: number; cum: number; seen: number } | null = null;
  let tick = 0;                          // absolute position, for chord symbols
  // Guitar chords carry their own durations, so a change can land between two
  // note onsets. ABC can only hang a symbol off a note, so each note takes the
  // chord IN FORCE at its position — the last one that has started. Changes
  // that never reach a note are reported rather than silently dropped.
  const chords = mv.chords.slice().sort((a, b) => a.tick - b.tick);
  let ci = 0;
  // Chords a later change overtook before any notehead came round to carry
  // them, so they were never drawn at all.
  const chordsSkipped: ChordSym[] = [];
  // Chords that had to slide forward because the beat they belong on is in
  // the middle of a held note, which has no notehead to carry a symbol.
  const chordsSlid: ChordSym[] = [];
  function chordFor(at: number): ChordSym | undefined {
    let chosen: ChordSym | undefined;
    while (ci < chords.length && chords[ci].tick <= at) {
      if (chosen) chordsSkipped.push(chosen);
      chosen = chords[ci];
      ci++;
    }
    if (chosen && chosen.tick < at) chordsSlid.push(chosen);
    return chosen;
  }
  // The symbols that reached a notehead, in the order they were written into
  // the ABC — which is the order they come out of the engraver. See ChordMark.
  const chordMarks: ChordMark[] = [];


  // What the rhythm staff will be written against — see PlanStep.
  const plan: PlanStep[] = [];
  // The staves under this one that actually hold something.
  const unders = mv.unders.filter(u => u.items.some(i => i.kind === 'note'));

  const beamBreaks = beamBoundaries(bn, den, spb);
  // True when the last thing written was a note short enough to carry a beam,
  // so the next one may be glued to it.
  let prevBeamable = false;

  // Append `text` to the previous token (beaming them) or start a new
  // space-separated token (breaking the beam).
  function emit(text: string, glue: boolean) {
    const last = out.length - 1;
    if (glue && last >= 0 && out[last] !== '\n') out[last] += text;
    else out.push(text);
  }

  // The absolute tick the last plan step left off at, so each barline can say
  // how much music it closed — a barline that closed nothing (a BR followed by
  // a "|." and no notes) must not put an empty bar on the rhythm staff.
  let planTick = 0;

  function flushBar() {
    if (pendingBar != null) {
      out.push(pendingBar);
      plan.push({ k: 'bar', sym: pendingBar, cap: tick - planTick });
      planTick = tick;
      prevBeamable = false;   // a barline always breaks the beam
      pendingBar = null;
      barsOnLine++;
      if (!manualBreaks && barsOnLine >= BARS_PER_LINE) {
        out.push('\n'); plan.push({ k: 'nl' }); barsOnLine = 0;
      }
    }
    if (pendingKey != null) {
      out.push(pendingKey);
      // The staves underneath follow the music's key, and it lands where the
      // music put it — after the barline, whichever order the source wrote
      // the two in.
      plan.push({ k: 'key', sym: pendingKey, keySig: key, degreeAcc, printAcc });
      prevBeamable = false;
      pendingKey = null;
    }
  }

  // A bar just filled up: queue its barline and reset the accidental memory.
  function closeBar() {
    barPos = 0;
    barCap = barTicks;
    active.clear();
    pendingBar = pendingBar && pendingBar !== '|' ? pendingBar : '|';
  }

  for (const item of mv.items) {
    if (!(item.kind === 'mark' && item.mark.t === 'linebreak')) brRun = 0;
    if (item.kind === 'mark') {
      const m = item.mark;
      switch (m.t) {
        case 'repeatStart':
          flushBarInto('|:');
          groups.push('R');
          break;
        case 'repeatEnd': {
          const top = groups.pop();
          if (top === 'A') { flushBarInto('|]'); altN = 0; }
          else flushBarInto(':|');
          break;
        }
        case 'alt':
          groups.push('A');
          altN = 1;
          flushBar();
          out.push('[1');
          plan.push({ k: 'volta', sym: '[1' });
          break;
        case 'bar':
          if (groups[groups.length - 1] === 'A' && m.sym === '|') {
            // Inside A{ … | … } a bare bar separates the endings.
            altN++;
            flushBarInto(':|');
            out.push(`[${altN}`);
            plan.push({ k: 'volta', sym: `[${altN}` });
          } else {
            if (barPos !== 0) {
              warnings.push({ span: item.src, msg: `Barline lands mid-bar — ${fmtTicks(barPos)} of ${fmtTicks(barCap)} filled.` });
              // Skip the unwritten remainder on the ABSOLUTE clock too. Chord
              // positions are resolved against a post-pass that does exactly
              // this, and if the two disagree — as they did after a short
              // pickup bar — every later chord lands in the wrong place.
              tick += barCap - barPos;
            }
            flushBarInto(m.sym);
            barPos = 0; barCap = barTicks; active.clear();
          }
          break;
        case 'key': {
          // What the degrees SOUND always follows the new 1=; what the staff
          // PRINTS only changes if the signature itself does — a K= override
          // in force means the modulation is spelled out in accidentals
          // instead, exactly as it is at the top of the score.
          key = m.keySig;
          degreeAcc = sigAccidentals(key.sharps);
          const name = m.printKey ? m.printKey.name : key.name;
          printAcc = sigAccidentals(m.printKey ? m.printKey.sharps : key.sharps);
          if (name !== printName) {
            printName = name;
            pendingKey = `[K:${name}]`;
            // A new signature resets what the bar has already sounded.
            active.clear();
          }
          break;
        }
        case 'rehearsal':
          pendingPrefix.push(`"^${m.label}"`);
          break;
        case 'text':
          pendingPrefix.push(`"^${m.above}"`);
          break;
        case 'linebreak':
          // Re-flowing: the break is simply not written. The bar it fell on
          // still closes here, so nothing about the music moves.
          if (opts.reflow) { flushBar(); break; }
          // BR ends the line; BR BR (BR BR BR …) pushes the next system
          // further down. abcjs's %%vskip attaches to the line that follows
          // it, and a second one would overwrite rather than add — so the
          // whole run is written as a single directive, replacing the break
          // token already queued.
          brRun++;
          if (brRun === 1) { flushBar(); out.push('\n'); plan.push({ k: 'nl' }); }
          // A %%vskip is a line of its own in the body, and a second voice
          // underneath has no way to write the same one — the two voices would
          // stop pairing up line for line. The extra air is the smaller loss.
          else if (!unders.length) out[out.length - 1] = `\n%%vskip ${(brRun - 1) * (opts.numbers ? BR_VSKIP_NUM : BR_VSKIP)}\n`;
          barsOnLine = 0;
          prevBeamable = false;
          break;
        case 'chordline':
          break;   // resolved into mv.chords by the parser's post-pass
        case 'multirest':
          flushBar();
          out.push(`Z${m.bars}`);
          plan.push({ k: 'multi', bars: m.bars });
          noteSpans.push(item.src);
          noteLabels.push(null);
          barsOnLine += m.bars;
          tick += m.bars * barTicks;
          planTick = tick;
          break;
      }
      continue;
    }

    // ── a note / rest / chord ────────────────────────────────────────
    const note = item;
    // Flush first: a tuplet opening the bar must have its bracket AFTER the
    // barline, not stranded at the end of the previous measure.
    if (note.tuplet) {
      flushBar();
      out.push(`(${note.tuplet.p}:${note.tuplet.q}:${note.tuplet.r}`);
    }

    const prefix: string[] = [];
    const chord = chordFor(tick);
    if (chord) {
      // Asked for numerals, a chord written as one shows the analysis as it
      // was written (V7/II- says more than VI7 would); a letter chord is
      // numbered from home. Asked for letters, it's the chord either way.
      const show = chordShow(chord, opts.roman ? origin : null);
      // What abcjs is given is only for spacing (see ChordShow). Its slash is
      // the division slash: abcjs reads a / in a chord symbol as a slash bass
      // and silently drops anything after it that isn't a letter.
      prefix.push(`"${roomFor(show)}"`);
      chordMarks.push({ sym: chord.sym, src: chord.src ?? null, show });
      // Counting from the chord: every note from here to the next change is
      // numbered against THIS root. A symbol whose root can't be read leaves
      // the numbering where it was rather than throwing it back to the key —
      // a bar that quietly reverts is worse than one that carries on.
      if (opts.numbersFrom === 'chord') chordOrigin = rootKey(chord.sym) ?? chordOrigin;
    }
    if (pendingPrefix.length) { prefix.push(...pendingPrefix); pendingPrefix = []; }
    if (note.above) prefix.push(`"^${note.above}"`);
    if (note.below) prefix.push(`"_${note.below}"`);
    prefix.push(...note.decos);
    if (note.grace?.length) {
      // A grace CHORD is written as one bracket here but ABC has no chord
      // inside a { } group, so its pitches come out one after another —
      // drawn in a row, sounded together.
      const inner = note.grace
        .map(g => g.pitches.map(p => tok(p, key, degreeAcc, printAcc, new Map(), octaves) + graceLen(g.dur)).join(''))
        .join('');
      prefix.push(`{${note.grace[0].slash ? '/' : ''}${inner}}`);
    }
    for (let i = 0; i < note.slurOpen; i++) prefix.push('(');

    const isRest = !note.perc && note.pitches.length === 0;
    const suffix = ')'.repeat(note.slurClose) + (note.tie ? '-' : '');

    if (note.inTuplet) {
      // Tuplet members are written at face value and never metric-split —
      // the bracket already tells the reader what the beat is.
      if (note.tuplet) {
        tup = { ...note.tuplet, startBar: barPos, startTick: tick, cum: 0, seen: 0 };
      }
      flushBar();
      {
        const beamable = !isRest && note.dur < TICKS_PER_CROTCHET;
        emit(prefix.join('') + head_(note, key, degreeAcc, printAcc, active, note.dur, octaves) + suffix,
             beamable && prevBeamable && !note.tuplet);
        noteSpans.push(note.src);
        noteLabels.push(degreeLabels(note, key, chordOrigin ?? origin));
        prevBeamable = beamable;
      }
      if (tup) {
        // Advance to the group's CUMULATIVE sounding position rather than
        // scaling each member on its own — three quavers of a 3:2 sound
        // 32/3 ticks each, and rounding those individually would drift the
        // bar cursor by a tick per group.
        tup.cum += note.dur;
        tup.seen++;
        const end = Math.round(tup.cum * tup.q / tup.p);
        tick = tup.startTick + end;
        barPos = tup.startBar + end;
        if (tup.seen >= tup.r) tup = null;
      } else {
        barPos += note.dur;
        tick += note.dur;
      }
      if (barPos >= barCap) {
        if (tup) warnings.push({ span: note.src, msg: 'A tuplet crosses a barline — abcjs may lay it out oddly.' });
        closeBar();
      }
      continue;
    }

    // Lay the note down, splitting it at barlines and then by the bar's
    // metric tree; the pieces are tied together.
    let remaining = note.dur;
    let first = true;
    while (remaining > 0) {
      flushBar();
      const space = barCap - barPos;
      const chunk = Math.min(remaining, space);
      // A pickup bar is felt as the TAIL of a full bar, so shift its positions
      // to the end of a notional full bar before consulting the metric tree.
      const shift = barCap < barTicks ? barTicks - barCap : 0;
      const pieces = splitInBar(barPos + shift, barPos + chunk + shift, bn, den, spb, !isRest);

      // Bar-local tick of the piece being written, so we can tell whether it
      // lands on a beam-group boundary.
      let cur = barPos;
      for (let pi = 0; pi < pieces.length; pi++) {
        const [a, b] = pieces[pi];
        for (const len of abcDurTokens(b - a)) {
          const body = head_(note, key, degreeAcc, printAcc, active, len, octaves);
          const more = pi < pieces.length - 1 || len !== b - a;
          // Beam it to the previous note unless it opens a new beat group, is
          // a rest, or is too long to be beamed at all.
          const beamable = !isRest && len < TICKS_PER_CROTCHET;
          const glue = beamable && prevBeamable && !beamBreaks.has(cur);
          emit((first ? prefix.join('') : '') + body + (isRest ? '' : (more ? '-' : '')), glue);
          noteSpans.push(note.src);
          // Only the head of a split note carries its number; the pieces it
          // was tied into are held beats.
          noteLabels.push(first || isRest ? degreeLabels(note, key, chordOrigin ?? origin) : HELD);
          prevBeamable = beamable;
          cur += len;
          first = false;
        }
      }

      barPos += chunk;
      tick += chunk;
      remaining -= chunk;
      if (barPos >= barCap) {
        closeBar();
        // A note carrying over the barline is tied across it.
        if (remaining > 0 && !isRest) out[out.length - 1] += '-';
      }
    }
    if (suffix) out[out.length - 1] += suffix;
  }

  flushBar();
  // One warning per chord rather than one per kind: each carries the symbol's
  // own characters, so the editor can squiggle the chord that's actually the
  // problem instead of naming it in a list.
  for (const c of chords.slice(ci)) {
    warnings.push({ span: c.src ?? NOWHERE, msg: `${c.sym} never reaches a note — it sits past the end of the written music.` });
  }
  for (const c of chordsSlid) {
    warnings.push({ span: c.src ?? NOWHERE, msg: `${c.sym} falls inside a held note, so it is drawn on the next notehead instead of on the beat.` });
  }
  for (const c of chordsSkipped) {
    warnings.push({ span: c.src ?? NOWHERE, msg: `${c.sym} fell between notes — ABC can only hang a symbol off a note, so the next change is drawn in its place.` });
  }
  if (!out.length) { out.push('z8'); noteSpans.push(null); noteLabels.push(null); }

  // Whatever the last barline didn't close: the final, part-written bar.
  const tailTicks = Math.max(0, tick - planTick);

  const body = foldTail(out.join(' ').replace(/ *\n */g, '\n').trim());
  const lyricLines = mv.lyrics
    .slice()
    .sort((a, b) => a.verse - b.verse)
    .map(l => `w:${l.syllables.join(' ')}`);

  // ── the staves underneath ───────────────────────────────────────────
  // Both are written against the plan the music above just laid down, so all
  // of them come out bar for bar and line for line however the music was
  // broken up.
  const lines = body.split('\n').length;
  // abcjs pairs the voices up line for line, so a difference of one — the
  // trailing barline the fold above took off one body but not the other —
  // would slide the whole staff a system out of step.
  const fit = (raw: string) => {
    let b = foldTail(raw);
    while (b.split('\n').length > lines) b = foldTail(b, true);
    return b;
  };
  const ranOn = (note: NoteItem, what: string) => warnings.push({
    span: note.src,
    msg: `The ${what} line runs past the end of the music — the music decides where the bars are, and there are none left for this.`,
  });

  // Each staff under the music, written against that plan. They come out in
  // the order the parser put them in, which is the order they're engraved:
  // the stabs directly under the music, then the treble parts, then the bass
  // ones.
  const written: { u: Under; body: string; spans: (Span | null)[]; labels: (string[] | null)[] }[] = [];
  for (const u of unders) {
    const w = u.kind === 'stab'
      // A hit sits on the staff's one line; B is the line a treble staff would
      // have had there, which is where abcjs draws the single line too. No key
      // and no accidentals to remember, so no hooks.
      ? writeUnder(
        u.items, plan, tailTicks, bn, den, spb, barTicks,
        (note, len) => `${note && (note.perc || note.pitches.length) ? 'B' : 'z'}${len === 1 ? '' : String(len)}`,
      )
      // Real pitches, so this one carries the whole spelling state the music
      // carries: the key it's in, what its signature already prints, and what
      // the current bar has already sounded. Each staff keeps its own copy of
      // all three — an accidental on one staff says nothing about the next.
      //
      // The music's own 8va is deliberately NOT passed on: it moves the part
      // being read, and a staff underneath isn't it. The bass staves have an
      // 8va of their own, for when the bass is what's being read.
      : (() => {
        let uKey = mv.keySig;
        let uDegreeAcc = sigAccidentals(uKey.sharps);
        let uPrintAcc = sigAccidentals(mv.printKey ? mv.printKey.sharps : uKey.sharps);
        const uActive = new Map<string, number>();
        const shift = u.kind === 'bass' ? bassOctaves : 0;
        return writeUnder(
          u.items, plan, tailTicks, bn, den, spb, barTicks,
          (note, len) => (note && (note.perc || note.pitches.length)
            ? head_(note, uKey, uDegreeAcc, uPrintAcc, uActive, len, shift)
            : `z${len === 1 ? '' : String(len)}`),
          {
            bar: () => uActive.clear(),
            key: step => {
              uKey = step.keySig; uDegreeAcc = step.degreeAcc; uPrintAcc = step.printAcc;
              uActive.clear();
            },
            // Numbered from the movement's ORIGIN key, exactly as the music
            // above is, so a modulation doesn't restart the numbering on one
            // staff and not the other.
            label: note => (note ? degreeLabels(note, uKey, origin) : null),
          },
        );
      })();
    const b = fit(w.body);
    if (b.trim()) written.push({ u, body: b, spans: w.spans, labels: w.labels });
    if (w.over) ranOn(w.over, u.id);
  }

  // The staves, and the barlines drawn straight THROUGH from one to the next,
  // so a system reads as one system rather than as several tunes stacked up.
  // The `|` between the voice names is what says so — abcjs turns it into
  // connectBarLines — and it goes in front of the K:, which is where the tune
  // header ends.
  const staves = ['1', ...written.map(w => voiceId(w.u))];
  const headLines = staves.length > 1
    ? head.flatMap(l => (l.startsWith('K:') ? [`%%score ${staves.join(' | ')}`, l] : [l]))
    : head;

  let abc = [
    ...headLines,
    ...(written.length ? ['V:1'] : []),
    body,
    ...lyricLines,
  ].join('\n');
  // In reading order down the page, so each voice's offset is past the one
  // above it and the offsets, in order, cut the engraving into staves.
  const underStaves: UnderStaff[] = [];
  for (const w of written) {
    const decl = `\n${voiceDecl(w.u)}\n`;
    // K:none on the rhythm staff draws no signature at all: it's a line to
    // hang a rhythm on, and a row of sharps on it would be saying something
    // untrue. The pitched staves inherit the tune header's key, which is the
    // one the music above is in — exactly right, since they're in it too.
    const lead = w.u.kind === 'stab' ? '[K:none]' : '';
    // The offset is the start of everything this voice writes, the inline
    // K: included: an element abcjs makes of that field belongs to THIS staff,
    // and counting it into the one above would put that staff's list out by
    // one and lose its whole mapping.
    underStaves.push({
      id: w.u.id, kind: w.u.kind,
      from: abc.length + decl.length,
      spans: w.spans, labels: w.labels,
    });
    abc = `${abc}${decl}${lead}${w.body}`;
  }

  closeRuns(chordMarks);
  return { abc, warnings, manualBreaks, noteSpans, noteLabels, unders: underStaves, chordMarks };

  // Queue a specific barline, replacing a plain one already waiting.
  function flushBarInto(sym: string) {
    pendingBar = sym;
    flushBar();
  }
}

// A BR followed only by a barline (or another mark) would strand that mark on
// a staff line of its own. Fold any trailing line with no notehead on it back
// onto the line before. `always` folds the last line whatever is on it, which
// is how the rhythm staff is brought back into step when the music's own fold
// took a line off it and not off the stabs.
function foldTail(body: string, always = false): string {
  const lines = body.split('\n');
  const hasNote = (l: string) => /[A-Ga-gzZ]/.test(l.replace(/"[^"]*"/g, ''));
  while (lines.length > 1 && (always || !hasNote(lines[lines.length - 1]))) {
    const tail = lines.pop() as string;
    // A trailing %%vskip has nothing left to push down, and folding a
    // directive into a music line would break both. Drop it instead.
    if (tail.trimStart().startsWith('%%')) { if (always) break; continue; }
    lines[lines.length - 1] += ' ' + tail.trim();
    if (always) break;
  }
  return lines.join('\n').trim();
}

// ── the staves underneath ────────────────────────────────────────────
// Each under-staff is a voice of its own. The stab staff is one line, no clef,
// no key, X noteheads, stems down — `stem=down` rather than letting the
// engraver choose, because on a one-line staff every note is ON the line and
// the choice would otherwise be arbitrary, and a rhythm read under a melody
// reads better hanging below the line than sticking up into it. The pitched
// ones get real staves in the clef their letter names.
//
// The abcjs voice id is the same name the source calls the staff, which makes
// the generated ABC readable: V:T2, V:B, V:S.
function voiceId(u: Under): string {
  return u.kind === 'stab' ? 'S' : u.id;
}

function voiceDecl(u: Under): string {
  const id = voiceId(u);
  if (u.kind === 'stab') return `V:${id} clef=none stafflines=1 stem=down style=x`;
  return `V:${id} clef=${u.kind}`;
}

// Write a stream that rides UNDER the music, against the music's own bar plan.
//
// Both staves underneath are this: their own rhythm laid into the bars the
// melody laid down. It's driven by the plan rather than by the stream's own
// barlines, because the music decides where the bars are and the line fills
// them — a bar the line has nothing for comes out as a bar's rest, which is
// exactly what a staff under a melody should say about a bar nobody played in.
//
// What it keeps from the note loop above is the metric splitting, because a
// staff under the music is read the same way the music is: a note crossing the
// centre of the bar is two tied notes, a silence splits at every boundary it
// crosses. What differs between the two staves is only what a notehead LOOKS
// like — an X on a line, or a pitch in bass clef — which is `head`'s whole job.
function writeUnder(
  stream: Item[], plan: PlanStep[], tailTicks: number,
  bn: number, den: number, spb: number, barTicks: number,
  head: (note: NoteItem | null, len: number) => string,
  hooks: {
    // Every barline, for a staff that remembers accidentals within a bar.
    bar?: () => void;
    // A mid-piece key change. Present means the staff writes it; absent means
    // it isn't one this staff has anything to say about.
    key?: (step: Extract<PlanStep, { k: 'key' }>) => void;
    // What the numbers view draws in place of this staff's noteheads. Absent
    // for a staff that has no degrees to name — the rhythm one.
    label?: (note: NoteItem | null) => string[] | null;
  } = {},
): { body: string; spans: (Span | null)[]; labels: (string[] | null)[]; over: NoteItem | null } {
  const notes = stream.filter((i): i is NoteItem => i.kind === 'note' && i.dur > 0);
  const out: string[] = [];
  const spans: (Span | null)[] = [];
  const labels: (string[] | null)[] = [];
  // One label per span, and only the HEAD of a split note carries its number —
  // the pieces it was tied into are held beats, exactly as in the music above.
  const mark = (note: NoteItem | null, first: boolean) => {
    labels.push(!hooks.label ? null : first || !sounds(note) ? hooks.label(note) : HELD);
  };
  const breaks = beamBoundaries(bn, den, spb);
  let prevBeamable = false;
  let qi = 0;          // the stab note being written
  let left = 0;        // ticks of it still to write

  function emit(text: string, glue: boolean) {
    const last = out.length - 1;
    if (glue && last >= 0 && out[last] !== '\n') out[last] += text;
    else out.push(text);
  }

  // Whether a note sounds at all — a rest, or the padding this writer invents
  // for a bar the stream had nothing for, does not.
  const sounds = (n: NoteItem | null) => !!n && (n.perc || n.pitches.length > 0);

  // Lay `note` down for `len` ticks from bar-local `at`, split at the bar's
  // metric points. A null note is silence the bar needed and nobody wrote.
  function lay(note: NoteItem | null, at: number, len: number, shift: number, tied: boolean, first = true) {
    const hit = sounds(note);
    const span = note?.src ?? null;
    const pieces = splitInBar(at + shift, at + len + shift, bn, den, spb, hit);
    let cur = at;
    let head1 = first;
    for (let pi = 0; pi < pieces.length; pi++) {
      const [a, b] = pieces[pi];
      for (const l of abcDurTokens(b - a)) {
        const more = pi < pieces.length - 1 || l !== b - a;
        const beamable = hit && l < TICKS_PER_CROTCHET;
        emit(head(note, l) + (hit && more ? '-' : ''), beamable && prevBeamable && !breaks.has(cur));
        spans.push(span);
        mark(note, head1);
        head1 = false;
        prevBeamable = beamable;
        cur += l;
      }
    }
    if (tied && hit && out.length) out[out.length - 1] += '-';
  }

  // A tuplet is written at face value and never split — the bracket over it
  // already says what the beat is.
  function writeTuplet(at: number): number {
    const t = notes[qi].tuplet as { p: number; q: number; r: number };
    out.push(`(${t.p}:${t.q}:${t.r}`);
    prevBeamable = false;
    let cum = 0;
    for (let seen = 0; seen < t.r && qi < notes.length; seen++, qi++) {
      const n = notes[qi];
      const hit = sounds(n);
      let head1 = true;
      for (const l of abcDurTokens(n.dur)) {
        const beamable = hit && l < TICKS_PER_CROTCHET;
        emit(head(n, l), beamable && prevBeamable);
        spans.push(n.src);
        mark(n, head1);
        head1 = false;
        prevBeamable = beamable;
      }
      cum += n.dur;
    }
    return at + Math.round(cum * t.q / t.p);
  }

  function writeBar(cap: number) {
    if (cap <= 0) return;
    // A short bar (a pickup) is felt as the TAIL of a full one, exactly as the
    // music above it is.
    const shift = cap < barTicks ? barTicks - cap : 0;
    let pos = 0;
    while (pos < cap) {
      if (left === 0 && qi >= notes.length) { lay(null, pos, cap - pos, shift, false); break; }
      if (left === 0 && notes[qi].tuplet) { pos = Math.min(cap, writeTuplet(pos)); continue; }
      const note = notes[qi];
      if (left === 0) left = note.dur;
      const chunk = Math.min(left, cap - pos);
      const opening = left === note.dur;
      left -= chunk;
      lay(note, pos, chunk, shift, left > 0 || note.tie, opening);
      pos += chunk;
      if (left === 0) qi++;
    }
    prevBeamable = false;
  }

  for (const step of plan) {
    switch (step.k) {
      case 'bar':
        writeBar(step.cap); out.push(step.sym); prevBeamable = false;
        hooks.bar?.();
        break;
      case 'key':
        if (hooks.key) { out.push(step.sym); hooks.key(step); prevBeamable = false; }
        break;
      case 'volta': out.push(step.sym); break;
      case 'nl': out.push('\n'); prevBeamable = false; break;
      case 'multi':
        // The music is resting for whole bars; so is the rhythm staff, and
        // anything the stabs had to say in there goes with it.
        out.push(`Z${step.bars}`);
        for (let t = 0; t < step.bars * barTicks && qi < notes.length;) { t += notes[qi].dur; qi++; }
        left = 0;
        break;
    }
  }
  writeBar(tailTicks);

  return {
    body: out.join(' ').replace(/ *\n */g, '\n').trim(),
    spans,
    labels,
    // Notes the music had no bars left to hold. They're not drawn, and saying
    // so beats letting a whole phrase go quiet with no explanation.
    over: qi < notes.length ? notes[qi] : null,
  };
}

// ── systems, after the fact ──────────────────────────────────────────
// The three below read the body back as engraved lines, so the renderer can
// ask how dense a system is and, when the answer is "too dense for the pane",
// break it into shorter ones. Working on the ABC text rather than re-running
// the build keeps this out of the engraving path: nothing above knows or cares
// how wide the score will be drawn.

// Whether a line of a built score is a system of music, as opposed to a header
// field (`K:`, `w:`) or a directive (`%%vskip`).
function isSystem(line: string): boolean {
  const t = line.trim();
  return !!t && !t.startsWith('%%') && !/^[A-Za-z]:/.test(t);
}

// One system cut at its barlines — each piece ends with the barline that closed
// it, and a part-bar with no barline after it is a piece too. Chord text and
// inline fields are stepped over, so a "C7/|" or a [K:Eb] can't be mistaken for
// a barline.
function cutBars(line: string): string[] {
  const out: string[] = [];
  let start = 0, i = 0, inStr = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') { inStr = !inStr; i++; continue; }
    if (inStr) { i++; continue; }
    if (c === '[' && /^[A-Za-z]:/.test(line.slice(i + 1, i + 3))) {
      const close = line.indexOf(']', i);
      i = close < 0 ? line.length : close + 1;
      continue;
    }
    if (c === '|' || (c === ':' && line[i + 1] === '|')) {
      let j = i;
      while (j < line.length && (line[j] === '|' || line[j] === ':')) j++;
      if (line[j] === ']') j++;                    // |] is one token
      out.push(line.slice(start, j));
      start = j; i = j;
      continue;
    }
    i++;
  }
  out.push(line.slice(start));

  // A piece with no notehead in it isn't a bar — it's the repeat sign or the
  // volta bracket that OPENS the next one, so it joins it. (A system starting
  // "|: C D E F |" holds one bar, not two.)
  const bars: string[] = [];
  let pending = '';
  for (const piece of out.map(s => s.trim()).filter(Boolean)) {
    if (!hasNotehead(piece)) { pending = pending ? `${pending} ${piece}` : piece; continue; }
    bars.push(pending ? `${pending} ${piece}` : piece);
    pending = '';
  }
  if (pending) {
    if (bars.length) bars[bars.length - 1] += ` ${pending}`;
    else bars.push(pending);
  }
  return bars;
}

// Whether an ABC fragment draws anything — chord text and inline fields are
// full of letters that aren't notes, so they go first.
function hasNotehead(piece: string): boolean {
  return /[A-Ga-gxyzZ]/.test(piece.replace(/"[^"]*"/g, '').replace(/\[[A-Za-z]:[^\]]*\]/g, ''));
}

// The systems of an ABC body, grouped by the voice that wrote them: one bucket
// per V: declaration — or a single bucket for a score with no V: at all —
// holding the line indexes of that voice's systems in engraved order.
//
// abcjs draws one system per ROW of the voices: every voice's first line makes
// the first system, every voice's second the second, and so on. That's what
// the writer keeps true (see the %%vskip note above), and it's why a cut has
// to fall on the same line of every voice at once.
function voiceSystems(lines: string[]): number[][] {
  const voices: number[][] = [];
  let cur: number[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    // A V: in the tune header (V:1 name="Flute") opens a bucket that stays
    // empty — the body's own V:1 opens the one the systems land in — so the
    // empty ones come off at the end.
    if (/^V:/.test(lines[i].trim())) { voices.push(cur = []); continue; }
    if (!isSystem(lines[i])) continue;
    if (!cur) voices.push(cur = []);
    cur.push(i);
  }
  return voices.filter(v => v.length);
}

// Where each voice's music starts in an ABC body: the character just past the
// V: line that declares it, which is the offset an UnderStaff carries. Read
// off the text rather than remembered, so it survives the score being cut into
// stepped rows — splitSystems rewrites the lines, and every offset past the
// first cut moves.
export function voiceStarts(abc: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (const line of abc.split('\n')) {
    at += line.length + 1;
    if (/^V:/.test(line.trim())) out.push(at);
  }
  return out;
}

// Bars on each system, in the order they'll be engraved — counted off the
// first voice, since one system is one line of each of them.
export function systemBars(abc: string): number[] {
  const lines = abc.split('\n');
  const first = voiceSystems(lines)[0] ?? [];
  return first.map(i => cutBars(lines[i]).length);
}

// Cut the crowded systems into rows, and say which of the results are
// continuations — a row after the first, which the renderer steps to the right
// so the run still reads as one line. Which systems those are, and how many
// rows each of them needs, belongs to the caller: it has engraved the score
// once and MEASURED it, which is the only way to know. `rows` is asked per
// system, by position among the systems, and anything under 2 leaves that
// system whole — as does a system with fewer than 2 × `min` bars in it.
//
// The bars are dealt out as evenly as the count allows, biggest row first, so
// a five-bar system comes out 3 + 2 rather than 2 + 2 + 1: a row on its own
// with one bar in it reads as a fragment rather than as the line carrying on.
// The flags come back one per engraved system, in order, so they line up with
// abcjs's own staff groups, and `used` says how many rows each ORIGINAL system
// was given — the caller sizes the page from it.
export function splitSystems(
  abc: string,
  rows: (index: number) => number,
  min: number,
): { abc: string; stepped: boolean[]; used: number[] } {
  const lines = abc.split('\n');
  const voices = voiceSystems(lines);
  const first = voices[0] ?? [];
  const whole = { abc, stepped: first.map(() => false), used: first.map(() => 1) };
  // A staff running underneath is cut along with the music, at the same
  // barline, so the pair goes on reading as one system in two rows. That needs
  // the voices level — same number of lines, same number of bars on the line
  // being cut — which is what the writer maintains. Where they aren't, the
  // score is left whole: better one crowded line than two staves out of
  // register with each other.
  if (!voices.every(v => v.length === first.length)) return whole;

  const stepped: boolean[] = [];
  const used: number[] = [];
  // What each system's line becomes, by line index. Everything else — the
  // headers, the %%vskips, the lyrics — comes through untouched.
  const cut = new Map<number, string[]>();
  for (let i = 0; i < first.length; i++) {
    const per = voices.map(v => cutBars(lines[v[i]]));
    const len = per[0].length;
    // `min` bars to a row is the floor on how far a system can be cut, whatever
    // the measurement asked for.
    const n = per.every(b => b.length === len)
      ? Math.min(Math.floor(rows(i)), Math.floor(len / Math.max(1, min)))
      : 1;
    if (n < 2) { stepped.push(false); used.push(1); continue; }
    used.push(n);
    // The remaining bars over the remaining rows, rounded up — which spends
    // any remainder on the earliest rows and leaves the rows level. One
    // sequence for every voice, so the cut falls on the same barline all the
    // way down the system.
    const takes: number[] = [];
    for (let r = 0, at = 0; r < n; r++) {
      const take = Math.ceil((len - at) / (n - r));
      takes.push(take);
      at += take;
    }
    voices.forEach((v, k) => {
      const rowsOut: string[] = [];
      for (let r = 0, at = 0; r < n; r++) { rowsOut.push(per[k].slice(at, at + takes[r]).join(' ')); at += takes[r]; }
      cut.set(v[i], rowsOut);
    });
    for (let r = 0; r < n; r++) stepped.push(r % 2 === 1);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = cut.get(i);
    if (c) out.push(...c); else out.push(lines[i]);
  }
  return { abc: out.join('\n'), stepped, used };
}

// The notehead(s) for a note at a given length, in ABC.
function head_(
  note: NoteItem, key: KeySig,
  degreeAcc: Record<number, number>, printAcc: Record<number, number>,
  active: Map<string, number>, len: number, oct: number,
): string {
  const d = len === 1 ? '' : String(len);
  if (note.perc) return `B${d}`;
  if (!note.pitches.length) return `z${d}`;
  if (note.pitches.length === 1) return tok(note.pitches[0], key, degreeAcc, printAcc, active, oct) + d;
  const inner = note.pitches
    .slice()
    .sort((p, q) => p.degree + p.octave * 7 - (q.degree + q.octave * 7))
    .map(p => tok(p, key, degreeAcc, printAcc, active, oct))
    .join('');
  return `[${inner}]${d}`;
}

// The jianpu number(s) a note stands for, low to high — in the SAME order
// head_ writes the chord's pitches, so the numbers can be zipped straight onto
// the noteheads abcjs draws.
//
// Everything is stated in the movement's origin key. Inside a modulation the
// written 1 is a different pitch, so the number on the page has to be the one
// that pitch would have been called at home: respellPitch is the same machine
// the respell-a-selection menu uses, so the two always agree.
function degreeLabels(note: NoteItem, key: KeySig, origin: KeySig): string[] | null {
  if (note.perc) return ['x'];
  if (!note.pitches.length) return null;   // a rest stays a rest
  return note.pitches
    .slice()
    .sort((p, q) => p.degree + p.octave * 7 - (q.degree + q.octave * 7))
    .map(p => {
      if (key.label === origin.label) return accMark(p.acc ?? 0) + p.degree;
      const s = respellPitch(p, key, origin);
      return accMark(s.acc) + s.degree;
    });
}

// The key a chord's ROOT names, for numbering against it: the letter and any
// accidental off the front of the symbol, read as a major key. Major because
// that's what a jianpu degree counts in — over a Dm7, the third is 3b and the
// seventh 7b, which is how the shape is spoken as well as written.
function rootKey(sym: string): KeySig | null {
  const m = /^([A-Ga-g])([#b♯♭]*)/.exec(sym.trim());
  if (!m) return null;
  const acc = m[2].replace(/♯/g, '#').replace(/♭/g, 'b');
  return keyFromSpec(`${m[1].toUpperCase()}${acc}`);
}

function accMark(n: number): string {
  return n > 0 ? '#'.repeat(n) : n < 0 ? 'b'.repeat(-n) : '';
}

function tok(
  p: Pitch, key: KeySig,
  degreeAcc: Record<number, number>, printAcc: Record<number, number>,
  active: Map<string, number>, oct: number,
): string {
  const { letterPc, acc, midi } = degreeToSpelling(p, key, degreeAcc);
  // The 8va reading moves the register and nothing else: same letter, same
  // accidental, same key signature — spellToAbcKeyed reads the octave off the
  // midi number, so the shift belongs there and nowhere else.
  return spellToAbcKeyed(letterPc, acc, midi + 12 * oct, printAcc, active);
}

// A grace note's written value, in ABC. The one place the tune's L: doesn't
// reach: inside a { } group ABC counts in QUAVERS however the unit note length
// is set, so a tick count has to be written against a quaver rather than
// against the 1/128 everything else here uses. A plain quaver grace says
// nothing, a semiquaver is "/", a crotchet is "2".
const TICKS_PER_QUAVER = TICKS_PER_CROTCHET / 2;
function graceLen(ticks: number): string {
  const g = gcd(ticks, TICKS_PER_QUAVER);
  const num = ticks / g;
  const den = TICKS_PER_QUAVER / g;
  if (den === 1) return num === 1 ? '' : String(num);
  return num === 1 ? `/${den}` : `${num}/${den}`;
}

function gcd(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

function fmtTicks(t: number): string {
  const beats = t / 32;
  return `${Math.round(beats * 100) / 100} crotchet${beats === 1 ? '' : 's'}`;
}

function escapeField(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}
