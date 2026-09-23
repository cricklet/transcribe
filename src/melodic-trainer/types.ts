// Shared types for the Melodic Trainer.
//
// The trainer drills the ii–V–I: comping it as a waltz, and running its
// chord-scales. You work through every cell of the
// active drill (the 24 keys, or a chord × root grid) at a series of metronome
// tempos (BPM "cells"). Within a tempo you must pass every cell; passing one
// means getting THREE challenges in a row correct for it.

import type { KeySig as ChartKeySig } from '../transcribe/types';

// Pitch class 0..11 (C = 0, C♯/D♭ = 1, …, B = 11).
export type PitchClass = number;

// A MIDI note number 0..127. Middle C (C4) = 60.
export type Midi = number;

export type Quality = 'major' | 'minor';
export type Direction = 'up' | 'down';

// How the player feeds notes in:
//   keyboard   — a MIDI/PC keyboard (exact, instant), reading concert pitch.
//   trumpet    — pitch detection off the B♭ TENOR through the microphone (with
//                detection latency, so it's graded more leniently). That mode is
//                the TENOR sax everywhere the player sees it; its id stays the
//                historical 'trumpet' because it's baked into every saved
//                progress blob's key (persistence.ts's "-trumpet" suffix) and
//                the stored input-mode preference — renaming the string would
//                orphan them.
//   travelsax  — the TravelSax 2 (or any wind controller) over MIDI. It READS
//                like the tenor — same written B♭ staff, same drills, the
//                accompaniment sounding in concert under it — but the notes
//                arrive as exact, instant MIDI, so it's graded to the keyboard's
//                timing rules rather than the mic's. What the device transmits
//                for a given fingering is a setting (see midi.ts's input
//                transpose), because that's the device's own business.
// Progress is tracked separately per input mode.
export type InputMode = 'keyboard' | 'trumpet' | 'travelsax';

// The two B♭-horn modes: the staff shows WRITTEN tenor pitch, so everything
// the page sounds has to be dropped to concert first (app.tsx's concertLine /
// concertVoicing), and the waltz's voiced chords are off the table.
export function isHornMode(m: InputMode): boolean {
  return m === 'trumpet' || m === 'travelsax';
}

// What's being drilled (the content axis, orthogonal to InputMode):
//   waltz  — the ii–V–I comped as a waltz: each chord's root, then its two
//            voicings (see waltz.ts).
//   scale  — 2-octave chord-scale up from a chord tone, skipping avoid notes.
//   lick   — a phrase of your own, moved round the keys (licks.ts).
// Progress is tracked separately per drill (and per input mode).
export type DrillType = 'waltz' | 'scale' | 'lick';

// One captured MIDI note-on, with the AudioContext-relative timestamp
// (in seconds) at which it was received. Keeping MIDI input on the audio
// clock means note times and click times are directly comparable.
export interface MidiHit {
  midi: Midi;
  // AudioContext time in seconds.
  t: number;
  vel?: number;   // note-on velocity (0..127), when known
  ch?: number;    // source MIDI channel (0..15), when known
}

// A musical key: a tonic pitch class + major/minor quality. Its `id` is a
// stable string ("C-major", "Eb-minor") used as the persistence key.
export interface Key {
  id: string;
  tonic: PitchClass;
  quality: Quality;
  // Display name, e.g. "C major", "E♭ minor".
  name: string;
  // Whether this key is conventionally spelled with flats (drives the
  // staff accidental spelling + abcjs key signature).
  preferFlat: boolean;
  // abcjs key-signature token, e.g. "C", "Eb", "Am", "F#m".
  abcKey: string;
}

// One time through a lick, in one key: the chord it's over, that key's
// engraving of it, which note of the phrase each engraved element draws (-1 for
// a rest or a tied continuation), how each note is spelled in that key, and the
// signature it's written under. See licks.ts.
//
// `key` is the TRANSCRIBER's KeySig (the parser's own reading of the 1= —
// tonic, mode, sharps, name), not this file's staff-drawing KeySig below: the
// step comes straight out of parseJianpu, and toRoman / the board's key labels
// read it in the transcriber's terms.
export interface LickStep {
  // The chord the phrase starts over, and every chord in it in order — a
  // two-bar lick is usually a ii–V, and naming only the first says half of what
  // it's for. `chord` is that first symbol; `chords` is the whole harmony.
  chord: string;
  chords: string[];
  // The key the step is written in — what its numerals are measured from, and
  // what a reader would call it.
  key: ChartKeySig;
  abc: string;
  // The jianpu number under each notehead abcjs draws, in the same order as
  // the engraved elements — one entry per element, its own array per notehead
  // of a chord. Null when the lick is being read as an ordinary staff, which
  // is what tells the staff to draw itself as one. See licks.ts's NumbersFrom.
  labels: (string[] | null)[] | null;
  noteAt: number[];
  notes: { midi: number; letterPc: number; acc: number }[];
  sharps: number;
}

// One drill instance. A 'chord' challenge is a single melodic line over one
// chord (the scale drill) whose notes are matched as an ordered sequence; a
// 'progression' challenge is a run of chord BLOCKS, each played as a voicing and
// graded on its tones + its bottom note (ii–V–I and the waltz).
export interface Challenge {
  kind: 'chord' | 'progression';
  // Persistence cell id — the key id ("C-major"), or a chord-grid cell.
  cellId: string;
  // Prompt label shown left of the staff, e.g. "C M7" / "E♭ 7alt".
  label: string;
  // Staff accidental spelling (flats for flat contexts).
  preferFlat: boolean;
  // abcjs key-signature token for the engraved starting note. Penta uses the
  // key's signature; chord drills use "C" so every accidental is explicit.
  abcKey: string;
  // Concrete MIDI notes. The first entry is the starting note shown on the
  // staff; a melodic drill carries its whole run here.
  expected: Midi[];
  // The ordered pitch-class sequence to match (melodic drills).
  expectedPc: PitchClass[];
  // Intended onset of each note in BEATS, relative to the first note (so [0] is
  // 0). Drives beat-grid rhythm grading for the sequence drills. Omitted → the
  // grader falls back to an even subdivision (GradeConfig.subdivisionBeats).
  expectedBeats?: number[];

  // A per-note multiplier on the grid tolerance, parallel to expectedBeats —
  // for the notes a rule should hold more loosely than the rest (the short half
  // of a swung beat). Missing, or missing an entry, means 1.
  beatTolMul?: number[];
  // Contour direction of a melodic run ('up' on a progression, unused).
  direction: Direction;
  // Skip the contour gate even on a melodic drill — the up-down scale run reverses
  // partway, so monotonic-direction grading would wrongly fail it.
  contourFree?: boolean;
  // The name of the scale this run walks ("mixolydian", "altered", …), for the
  // label beside the chord. Set by the builder because the cell id alone can't
  // say it once a ii chord is running the dominant's scale over it.
  scaleName?: string;
  // Note indices where the staff should start a NEW row, so a long run wraps along
  // its musical seams (octave boundaries, the up→down turnaround) rather than a
  // generic balanced split. Fixed at build time, so the layout never reflows.
  rowBreaks?: number[];
  // ── melodic ('chord') only ──
  // The start note is NOT specified: the staff shows no starting note (an empty
  // preview staff) — you already know where to begin. Set by the scale drill's
  // "start on the root" setting.
  startFree?: boolean;
  // Exact spelling of the engraved start note: the natural pitch class of its
  // diatonic letter, plus the accidental in semitones (−2 double-flat … +2
  // double-sharp). Lets a chord tone read by function (D♭7♭9's ♭9 is E𝄫, not
  // D) rather than via the flat/sharp heuristic. Melodic drills only.
  startSpell?: { letterPc: PitchClass; acc: number };
  // Draw the run from a LOW start note (centred on the staff) rather than the
  // chord-tone mid octave — used by the scale drill so a 2-octave climb reads
  // without piling ledger lines above the staff. See targetDisplayMidi.
  anchorLow?: boolean;
  // Functional spelling for the tonal context: pitch class → { diatonic letter
  // pitch class, accidental in semitones }. Lets the staff spell each played
  // note BY FUNCTION (A7's 3rd is C♯ but its ♭9 is B♭ — mixed) instead of via a
  // single flat/sharp flag. Notes not in the map (wrong notes) fall back to
  // preferFlat. Built by the scale-drill challenge builder.
  spelling?: Record<number, { letterPc: PitchClass; acc: number }>;
  // Pitch classes that are the scale's AVOID note(s) present in this run (only
  // the scale drill's "play all" mode includes them). The staff flags these noteheads
  // in a distinct colour — in the cheat ghost and when you actually play them — so
  // you see the passing tone you're stepping through.
  avoidPcs?: PitchClass[];
  // The FUNCTION the written chord is filling, when that's the point of the
  // exercise rather than just background — drawn beside the chord symbol as
  // "as ii". Set by the scale drill's "play the V over the ii": you're looking
  // at a D-7 and playing G altered over it, and what makes that make sense is
  // that the D-7 is the ii.
  roleLabel?: string;
  // The root the run's notes are counted from for the degree readout (the "123"
  // toggle) — the chord/scale the line is heard against — and that harmony's own
  // pitch classes, which decide the two context-sensitive names (a tritone is
  // ♯11 over a natural 5th and ♭5 without it; a major 6th is 13 where there's a
  // 7th and 6 where there isn't). Set by the melodic drills; a progression reads
  // the same two off chordPcs per block instead.
  degreeRootPc?: PitchClass;
  degreePcs?: PitchClass[];
  // ── progression (ii–V–I · waltz) only ──
  // Everything below is one entry per BLOCK, in play order — three chords for
  // ii–V–I, nine (root · voicing · voicing, per chord) for the waltz.
  // The chord's own tones per block, for the degree readout under it.
  chordPcs?: PitchClass[][];
  // Display name per block, e.g. ["Dm7", "G7", "CM7"]. An EMPTY string means the
  // block continues the chord named before it (the waltz's two voicing blocks),
  // so the names row draws one name per chord.
  chordLabels?: string[];
  // The KEY named once beside the chord symbols — set only when the symbols are
  // degrees (ii · V · I) rather than chord names, since the numerals on their own
  // don't say which key they're in.
  keyLabel?: string;
  // Per-chord functional spelling (pc → {diatonic letter pc, accidental}), one
  // map per chord in play order, so each voiced chord's notes spell by ITS
  // function — e.g. the V7 leading tone in F♯ minor reads E♯, not F. Progression
  // (ii–V–I) only.
  chordSpellings?: Array<Record<number, { letterPc: PitchClass; acc: number }>>;
  // Which way block k has to sit against the block BEFORE it — 'up' means its
  // lowest note must be higher than the previous block's lowest, 'down' lower,
  // null no rule. The waltz's two directions play the SAME notes with the same
  // bass note — only the register differs — so without this the grader can't
  // hear the difference between them at all.
  chordRelDir?: ('up' | 'down' | null)[];
  // Which side of the first voicing the second one sits on: above ('up') or
  // below ('down'). One direction for the whole progression, drawn as a single
  // arrow beside the chord names (the waltz).
  inversionDir?: 'up' | 'down';
  // Draw this progression on a GRAND staff — a treble and a bass staff braced
  // together — instead of one treble staff. `chordStaff` says which staff each
  // block belongs on; the other staff rests through that slot, so the two stay
  // in step. The waltz uses it: the root block IS a bass note and now says so on
  // the page, with the voicings up on the treble where you play them.
  grandStaff?: boolean;
  chordStaff?: ('treble' | 'bass')[];
  // The required BASS (lowest) pitch class per block — for ii–V–I the 3rd (Type
  // A) or the 7th/6th (Type B), alternating across the progression for voice
  // leading; for the waltz whatever the prescribed inversion puts on the bottom.
  // The block must be voiced with this note lowest.
  chordBass?: PitchClass[];
  // The pitch classes ACCEPTED in each chord's cluster (mode-dependent: all four
  // tones for 'full'; 3-7-and-extensions for the rootless modes — root & 5th are
  // wrong notes there). A note outside its chord's set fails.
  chordAllowed?: PitchClass[][];
  // The pitch classes that MUST be present to complete each chord (all four tones
  // for 'full'; the two guide tones for rootless).
  chordRequired?: PitchClass[][];
  // Distinct notes needed to complete each block. Drives both grading and the
  // timing-based segmentation of what you played into blocks.
  chordTargetCount?: number[];
  // Degrees mode only: the chord's REAL name per block ("D7alt"), where the
  // label drawn on the page is a numeral ("V"). Heads the hover panel, so the
  // numeral can still be checked against the chord it stands for. Empty on a
  // block that carries no name of its own.
  chordRealNames?: string[];
  // Grade the OCTAVE too: every note of a block has to be the exact MIDI note
  // chordVoicingMidi prescribes, not just the right pitch class in any
  // register — up to ONE octave offset for the whole run, which your first
  // voicing sets (registerShift in grading.ts). The waltz asks for this: it's
  // the shapes and the voice leading between them that are the drill, so the
  // chords have to keep one register together, but whether that register is the
  // one drawn or an octave off it is your hand's business.
  exactRegister?: boolean;
  // The prescribed voicing of each chord as actual MIDI notes, bottom-to-top —
  // used by cheat mode to draw exactly what to play, and (with exactRegister)
  // the notes themselves. Progression only.
  chordVoicingMidi?: Midi[][];
  // The key signature the chord/progression implies (by function), used when
  // the "show key signature" toggle is on. See keySignature() in spelling.ts.
  keySig?: KeySig;
  // ── licks only ──
  // A phrase moved round the keys (licks.ts). It is engraved rather than laid
  // out note by note like the other drills: a lick has a RHYTHM, and the
  // trainer's own staff draws pitches on an unmetered row.
  //
  // `written` is the phrase in its OWN key — what's on the page, because it's
  // the thing you learnt and moving it is the exercise. `steps` is one entry
  // per chord of the run, each with that key's engraving: what a hover over the
  // chord row draws, and what's graded. `perRep` splits a position in the run
  // into which chord you're on and where you are in the phrase.
  lick?: {
    name: string;
    written: LickStep;
    steps: LickStep[];
    perRep: number;
    // One time through in beats — the phrase rounded up to whole bars, which
    // is where the next chord starts. It's what places a note on the timing
    // row under each chord.
    spanBeats: number;
    // …and a bar of it, so the page knows whether it's drawing one bar or two.
    barBeats: number;
    // Where the phrase's first note sits in its bar, in beats — what a barline
    // is measured back from, since everything else is counted from that note.
    leadBeats: number;
  };
}

// A drawn key signature: the abcjs K: token (e.g. "D", "F#m", "Gb") plus the
// accidental each diatonic letter carries IN that signature, keyed by the
// letter's natural pitch class (0=C 2=D 4=E 5=F 7=G 9=A 11=B) → −1/0/+1. Lets
// the staff draw a note bare when it matches the signature and add an explicit
// sharp/flat/natural only where it deviates.
export interface KeySig {
  abcKey: string;
  acc: Record<number, number>;
}

// Live grading state for an in-progress challenge — updated as each MIDI
// note arrives so the UI can fail fast on a wrong note.
export interface GradeState {
  // How many expected notes have been correctly matched so far.
  matched: number;
  // Set once the run is complete and all gates pass / a gate fails.
  done: boolean;
  passed: boolean;
  // Why it ended (for the result readout).
  reason: GradeReason;
  // Diagnostics for the result card.
  startedOffsetBeats: number | null;  // first note offset from appear, in beats
  avgIoiBeats: number | null;          // average inter-onset interval, in beats
}

export type GradeReason =
  | 'in-progress'
  | 'pass'
  | 'wrong-note'
  | 'uneven-touch'
  | 'wrong-direction'
  | 'wrong-top'
  | 'wrong-register'
  | 'late-start'
  | 'timeout'
  | 'bad-pace'
  | 'too-slow';

// ───── Persistence ───────────────────────────────────────────────────

// The configuration a run was played AT — everything that makes the same cell a
// harder or easier exercise. A success is recorded against one of these, and it
// also counts for every EASIER one (see curriculum's `dominates`): clear a key
// at 120 and it's clear at 90 too; clear the two-octave run and the one-octave
// is clear; clear it up-and-back-down and the up run is clear (down is its own
// exercise, and stays unclaimed).
//
// Deliberately NOT in here — settings that change how the exercise is PRESENTED
// rather than what it asks of you: the key signature, the scale name label, the
// chord lead-in audio. Practising with them on or off is the same success.
export interface RunConfig {
  // Metronome tempo in bpm, in steps of 5. 0 = untimed (the easiest — no click,
  // no timing gates), so every real tempo dominates it.
  bpm: number;
  // Scale drill: octaves the run climbs (1 or 2). Other drills: 1.
  octaves: number;
  // Scale drill: run direction. 'updown' dominates 'up'.
  dir: Direction | 'updown';
  // Scale drill: the grouping pattern ('off', '1235', …). No ordering — a
  // pattern is a different exercise, not a harder one.
  pattern: string;
  // Scale drill: start every run on the root (vs a random chord tone).
  fromRoot: boolean;
  // Scale drill: skip the scale's avoid note(s).
  skipAvoid: boolean;
  // Scale drill: play the V's scale over a written ii.
  vForIi: boolean;
  // How close to the beat grid each note's onset has to land, in beats — the
  // rhythm tolerance. SMALLER is harder, so a tight success covers a loose run.
  // Infinity = no grid check at all (the loosest possible setting). Only counts
  // where the grid actually grades: the keyboard's scale runs at a real tempo.
  gridTol: number;
  // How far consecutive notes' MIDI velocities may differ (0…127) — the evenness
  // rule. Smaller is harder, and Infinity = not graded (the default). Only counts
  // where velocities exist to compare: the keyboard's scale runs.
  velTol: number;
  // Lick drill: how the run moves from one chord to the next (licks.ts's MOVES).
  // No ordering — round the circle and down in half steps are different
  // exercises, not a harder and an easier one.
  move: string;
  // Lick drill: how many chords the run goes through. MORE is harder, so a run
  // of four covers the same lick played twice.
  chords: number;
}

// Per-(cell, run-config) progress.
export interface KeyProgress {
  // Current consecutive-correct streak at this config.
  streak: number;
  // True once streak has reached the "in a row" bar at this config.
  passed: boolean;
  // The bar that pass cleared (see curriculum's passStreak). Absent on scores
  // written before the setting existed — read as the default 3 — so raising the
  // bar can tell a 3-in-a-row pass from a 6.
  passedAt?: number;
  // Lifetime counters at this config (for the difficulty readout).
  attempts: number;
  passes: number;
}

export interface PersistShape {
  version: 2;
  // Where the tempo slider is sitting.
  currentBpm: number;
  // cells[cellId][runKey] = progress. Sparse — only cells and configs you've
  // actually played exist. `runKey` is curriculum's encoding of a RunConfig.
  cells: Record<string, Record<string, KeyProgress>>;
}

export function blankKeyProgress(): KeyProgress {
  return { streak: 0, passed: false, attempts: 0, passes: 0 };
}

// ───── Pitch-class helpers ────────────────────────────────────────────

export const PC_NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const PC_NAMES_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

// Wrap a MIDI number's pitch class to 0..11.
export function pc(midi: Midi): PitchClass {
  return ((midi % 12) + 12) % 12;
}
