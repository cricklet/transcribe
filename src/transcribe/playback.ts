// Playback for a parsed jianpu score.
//
// Two halves:
//   • buildEvents — walk a Movement into a flat list of {midi, at, dur} in
//     seconds, resolving tempo, tuplet scaling and ties.
//   • Player — three sampled voices from smplr, scheduled on the AudioContext
//     clock, each on its own gain bus.
//
// THREE voices, because a transcription has three things in it and they come
// from three different places in the source: the tune, the harmony (the chord
// symbols over it, comped, and any T: staves written out under it), and the
// bass (the B: staves). Each gets its own instrument and its own volume,
// remembered per song — hearing the harmony under a line you are checking by
// ear is a different job from hearing the line.

import { degreeToSpelling, sigAccidentals } from './parse';
import { parseChord } from './chords';
import {
  ChordSym, Doc, Item, KeySig, Mix, Movement, Pitching,
  TICKS_PER_CROTCHET, TICKS_PER_WHOLE, Voice, VOICES, VoiceMix,
} from './types';

export type NoteEvent = { midi: number; at: number; dur: number; vel: number; voice?: Voice };

// A chart with no 4=nn of its own still has to play at something.
const DEFAULT_BPM = 100;
const DEFAULT_VELOCITY = 88;
// The bass sits UNDER the tune rather than beside it, and an upright is a loud
// sample; a few notches down is the difference between accompaniment and a
// second melody.
const BASS_VELOCITY = 74;
// Grace notes are lighter than the note they lean on — they're a flick on the
// way in, not a note of their own.
const GRACE_VELOCITY = 0.8;

// How long one grace note sounds — the plain quaver a grace note is written as
// unless the source says otherwise. A crushed note is a flick, so this is a
// real duration and not a fraction of the beat: 70ms is about as fast as a
// hand plays one, and the synth's own 50ms floor catches anything shorter.
const GRACE_SEC = 0.07;
// Comping is behind the tune by definition, and a held voicing is present far
// longer than a struck melody note.
const CHORD_VELOCITY = 62;

// ── the mix ──────────────────────────────────────────────────────────
// What each voice can be played on. Short, curated lists rather than the whole
// General MIDI set: this is a reading tool, and the question is only ever "can
// I hear this line against that one", which four or five timbres answer.
export const PATCHES: Record<Voice, { id: string; name: string }[]> = {
  lead: [
    { id: 'acoustic_grand_piano', name: 'piano' },
    { id: 'electric_piano_1', name: 'rhodes' },
    { id: 'vibraphone', name: 'vibes' },
    { id: 'tenor_sax', name: 'tenor' },
    { id: 'trumpet', name: 'trumpet' },
    { id: 'flute', name: 'flute' },
    { id: 'acoustic_guitar_nylon', name: 'guitar' },
  ],
  chords: [
    { id: 'electric_piano_1', name: 'rhodes' },
    { id: 'acoustic_grand_piano', name: 'piano' },
    { id: 'electric_guitar_jazz', name: 'guitar' },
    { id: 'drawbar_organ', name: 'organ' },
    { id: 'vibraphone', name: 'vibes' },
    { id: 'string_ensemble_1', name: 'strings' },
  ],
  bass: [
    { id: 'acoustic_bass', name: 'upright' },
    { id: 'electric_bass_finger', name: 'electric' },
    { id: 'fretless_bass', name: 'fretless' },
    { id: 'synth_bass_1', name: 'synth' },
    { id: 'cello', name: 'cello' },
  ],
};

// The mix a song arrives with. The tune is a piano and the comping a Rhodes —
// the melody wants the attack that cuts through, the chords want the one that
// sits behind — and everything is on, because a line you wrote is a line you
// meant to hear. All three are per-song from the first time you touch them.
const DEFAULT_MIX: Mix = {
  lead: { on: true, patch: 'acoustic_grand_piano', vol: 0.9 },
  chords: { on: true, patch: 'electric_piano_1', vol: 0.75 },
  bass: { on: true, patch: 'acoustic_bass', vol: 0.85 },
};

// The document's mix, filled in from the defaults — and read defensively,
// since a Doc arrives from the cloud as well as from here.
export function mixOf(doc: Doc | null | undefined): Mix {
  const out = {} as Mix;
  for (const v of VOICES) {
    const d = DEFAULT_MIX[v];
    const o = doc?.mix?.[v] as Partial<VoiceMix> | undefined;
    const patch = typeof o?.patch === 'string' && PATCHES[v].some(p => p.id === o.patch)
      ? o.patch : d.patch;
    const vol = typeof o?.vol === 'number' && Number.isFinite(o.vol)
      ? Math.max(0, Math.min(1, o.vol)) : d.vol;
    out[v] = { on: typeof o?.on === 'boolean' ? o.on : d.on, patch, vol };
  }
  return out;
}

// Concert-pitch readings of the written page. A Bb instrument (trumpet,
// tenor, soprano, clarinet) sounds a major second BELOW what it reads, so
// playing the page "as a Bb part" means dropping everything two semitones.
// Declared in the SOURCE (CONCERT=), so it lives with the rest of the score's
// vocabulary; re-exported here because this is where it does its work.
export type { Pitching };
export const PITCHING_SEMITONES: Record<Pitching, number> = { C: 0, Bb: -2 };

// Where one written token starts sounding, in seconds from the top of the
// movement. `start` is its offset in the SOURCE text, which is how a click on
// the staff finds the moment to play from — and `midis`/`dur` are what that
// one token sounds on its own, for auditioning it with a click. A tied
// continuation carries its own pitches here rather than none: clicking it
// asks to hear that note, not to hear the tie's bookkeeping.
// One written note, tied back to the characters that wrote it. `start` and
// `end` are that token's span in the source, which is what lets alt+[ / alt+]
// walk the caret from note to note.
export type NoteStart = {
  start: number; end: number; at: number; midis: number[]; dur: number; voice: Voice;
  // Where it sits in the MOVEMENT's own time, in ticks (a crotchet is
  // TICKS_PER_CROTCHET). `at` is that in seconds at the tempo the chart
  // declares; this is the same instant in beats, for anything that has to
  // count in beats rather than play at a tempo.
  tick: number;
};

// What a performance is asked to include. Everything is optional and off-by-
// default-off is deliberate: the two callers that only want to know what the
// TUNE sounds — the respell and transpose self-checks — get exactly that.
export type PlayOpts = {
  pitching?: Pitching;
  swing?: boolean;
  chords?: boolean;
  bass?: boolean;
};

export function buildEvents(
  mv: Movement, opts: PlayOpts = {},
): { events: NoteEvent[]; totalSec: number; starts: NoteStart[] } {
  const { pitching = 'C', swing = false } = opts;
  // A tempo of `unit = bpm` means one 1/unit note per beat.
  const unitTicks = mv.tempo ? TICKS_PER_WHOLE / mv.tempo.unit : TICKS_PER_CROTCHET;
  const bpm = mv.tempo?.bpm ?? DEFAULT_BPM;
  const secPerTick = 60 / bpm / unitTicks;
  // The pitching is about the INSTRUMENT — a Bb part sounds a tone lower than
  // it reads, and nothing on the page moves. Putting the MUSIC in another key
  // is a different act entirely, and a written one: it rewrites the source (see
  // transpose.ts), so by the time the notes get here they already say it.
  const shift = PITCHING_SEMITONES[pitching];

  const events: NoteEvent[] = [];
  // One entry per written note or rest, in source order — rests included, so
  // starting from a bar of silence works as well as starting from a notehead.
  const marks: { start: number; end: number; tick: number; midis: number[]; dur: number; voice: Voice }[] = [];
  // Beats that swing has to leave alone — see straightBeat below. Only the
  // MUSIC votes on this: whether the tune swings can't depend on whether the
  // bass staff happens to be switched on, and a bass swings WITH the tune
  // rather than deciding for it.
  const straight = new Set<number>();
  // The key the music has in force at each tick, and what its signature
  // sounds. The bass staff carries no key marks of its own — a 1= is a
  // statement about the whole movement — so it reads its key off this clock.
  const keys: { tick: number; key: KeySig; sigAcc: Record<number, number> }[] = [
    { tick: 0, key: mv.keySig, sigAcc: sigAccidentals(mv.keySig.sharps) },
  ];

  // One stream, walked into events, returning where it ended. `leads` is the
  // music: it's the stream that declares the modulations and decides the
  // swing, and anything else follows the clock it laid down.
  function walk(stream: Item[], leads: boolean, on: Voice = 'bass'): number {
    // The key in force, which a mid-piece 1= moves — the numbers after it mean
    // new pitches, and the playback has to modulate with them.
    let key = keys[0].key;
    let sigAcc = keys[0].sigAcc;
    let ki = 0;
    let tick = 0;
    // Tuplet members sound q/p of their written length; track the group so the
    // cursor advances by cumulative sounding position, not per-note rounding.
    let tup: { p: number; q: number; r: number; startTick: number; cum: number; seen: number } | null = null;
    // A note tied into the next one extends that note rather than re-striking.
    let tiedFrom: NoteEvent[] | null = null;

    for (const item of stream) {
      if (item.kind === 'mark') {
        if (leads && item.mark.t === 'key') {
          key = item.mark.keySig;
          sigAcc = sigAccidentals(key.sharps);
          keys.push({ tick, key, sigAcc });
        }
        continue;
      }
      // A follower modulates by the clock rather than by anything it says.
      if (!leads) {
        while (ki + 1 < keys.length && keys[ki + 1].tick <= tick) {
          ki++; key = keys[ki].key; sigAcc = keys[ki].sigAcc;
        }
      }
      const note = item;

      const voice: Voice = leads ? 'lead' : on;
      const mark = { start: note.src.start, end: note.src.end, tick, midis: [] as number[], dur: 0, voice };
      marks.push(mark);

      if (note.tuplet) tup = { ...note.tuplet, startTick: tick, cum: 0, seen: 0 };

      // How long this note occupies, and where the cursor lands after it.
      let sounding: number;
      let nextTick: number;
      if (note.inTuplet && tup) {
        const from = tup.startTick + Math.round(tup.cum * tup.q / tup.p);
        tup.cum += note.dur;
        tup.seen++;
        nextTick = tup.startTick + Math.round(tup.cum * tup.q / tup.p);
        sounding = nextTick - from;
        if (tup.seen >= tup.r) tup = null;
      } else {
        sounding = note.dur;
        nextTick = tick + note.dur;
      }

      // Rests count as much as notes here: a beat written `s0 s1 s1 s1` is a
      // sixteenth beat whether or not the first one sounds.
      if (leads && (note.inTuplet || (note.dur > 0 && note.dur < TICKS_PER_QUAVER))) {
        const last = Math.max(tick, tick + sounding - 1);
        for (let b = beatOf(tick); b <= beatOf(last); b++) straight.add(b);
      }

      const isRest = !note.perc && note.pitches.length === 0;
      if (isRest || note.perc) {
        // Nothing sounds; a rest also breaks any pending tie.
        tiedFrom = null;
        tick = nextTick;
        continue;
      }

      // Grace notes sound in the space BEFORE the beat, borrowing it from
      // whatever came before them — which is how they're played, and what
      // keeps them off the clock: the note they lean on still starts where
      // it's written, and nothing after it moves. The flourish is measured in
      // SECONDS rather than in beats, because that's what a grace note is: a
      // flick of the fingers, played at about the same speed whether the chart
      // is at 60 or at 240 — a written quaver of it is nowhere near a quaver
      // long. The written values still divide the flourish up, so g[ s4 s5 ]
      // is two flicks in the time of one, and the whole thing is capped at a
      // quaver of real time so a slow run of them can't swallow the note in
      // front. The one exception is a grace on the very first tick, where
      // there is no space to borrow: those are played on the beat, and the
      // note they lean on waits for them.
      let onset = tick * secPerTick;
      if (note.grace?.length) {
        const written = note.grace.reduce((t, g) => t + g.dur, 0);
        const flourish = Math.min(
          written / TICKS_PER_QUAVER * GRACE_SEC,
          TICKS_PER_QUAVER * secPerTick,
        );
        let at = onset - flourish;
        if (at < 0) { at = 0; onset = flourish; }
        for (const g of note.grace) {
          const len = g.dur / written * flourish;
          for (const gp of g.pitches) {
            events.push({
              midi: degreeToSpelling(gp, key, sigAcc).midi + shift,
              at,
              dur: len,
              vel: Math.round((leads ? DEFAULT_VELOCITY : BASS_VELOCITY) * GRACE_VELOCITY),
              voice,
            });
          }
          at += len;
        }
      }

      const midis = note.pitches
        .map(p => degreeToSpelling(p, key, sigAcc).midi + shift)
        .sort((a, b) => a - b);
      mark.midis = midis;
      mark.dur = sounding * secPerTick;

      // Continue a tie when the pitches match exactly — otherwise the ~ was
      // written across a pitch change and we just re-strike.
      if (tiedFrom && sameMidis(tiedFrom.map(e => e.midi), midis)) {
        for (const e of tiedFrom) e.dur += sounding * secPerTick;
      } else {
        const fresh = midis.map(midi => ({
          midi,
          at: onset,
          // A note that waited for its own grace notes still ends where it was
          // written to end, so the one after it isn't sat on.
          dur: Math.max(sounding * secPerTick - (onset - tick * secPerTick), secPerTick),
          vel: leads ? DEFAULT_VELOCITY : BASS_VELOCITY,
          voice,
        }));
        events.push(...fresh);
        tiedFrom = fresh;
      }

      tiedFrom = note.tie ? tiedFrom : null;
      tick = nextTick;
    }
    return tick;
  }

  const musicTicks = walk(mv.items, true);
  // The staves underneath, each on the voice its clef implies: a bass-clef
  // staff is the bass, a treble one is a written-out part and goes on the
  // comping voice, which is where a part that isn't the tune belongs. Each
  // shares the movement's bars — the parser pads their short ones, so the
  // clocks can't drift apart — and the same pitching, since their degrees read
  // against the very 1= the melody's do. The rhythm staff has nothing to
  // sound.
  let underTicks = 0;
  let bassSounds = false;
  for (const u of mv.unders) {
    if (u.kind === 'stab' || !u.items.length) continue;
    const on: Voice = u.kind === 'bass' ? 'bass' : 'chords';
    if (!(on === 'bass' ? opts.bass : opts.chords)) continue;
    underTicks = Math.max(underTicks, walk(u.items, false, on));
    if (on === 'bass') bassSounds = true;
  }
  if (opts.chords) {
    comp(mv.chords, Math.max(musicTicks, underTicks), secPerTick, shift, bassSounds, events);
  }
  // Several streams deep, so put them back in the order they SOUND: the score
  // finds a note by its source offset, and one on a staff underneath should be
  // as clickable as one on the melody.
  marks.sort((a, b) => a.tick - b.tick || a.start - b.start);

  const beatSec = TICKS_PER_CROTCHET * secPerTick;
  const warp = swing ? swingWarp(beatSec, straight) : (t: number) => t;
  return {
    events: swing ? swingEvents(events, beatSec, straight) : events,
    totalSec: Math.max(musicTicks, underTicks) * secPerTick,
    starts: marks.map(m => ({
      start: m.start, end: m.end, at: warp(m.tick * secPerTick),
      midis: m.midis, dur: m.dur, voice: m.voice, tick: m.tick,
    })),
  };
}

// ── comping the chord line ───────────────────────────────────────────
// The C" symbols, realised. Not an arrangement — a reading aid: the harmony
// under the line you're checking by ear, held from one change to the next so
// you can hear what a note is sounding against rather than guess.
//
// The voicing is deliberately plain, and always in the same octave band, which
// is what makes it voice-lead by itself: every tone is placed at its lowest
// instance above CHORD_FLOOR, so two chords a step apart come out a step
// apart rather than leaping about looking for a root position.
const CHORD_FLOOR = 57;    // A3 — where the guide tones live
const ROOT_FLOOR = 43;     // G2 — and the root under them, when it's wanted
// Where a BASS puts that root instead: an octave below the left hand's, which
// is simply where the instrument lives. Play a root at G2 on an upright and it
// sounds like a bass player who has wandered up to look at the piano.
const BASS_ROOT_FLOOR = ROOT_FLOOR - 12;   // G1
// A change held forever rings into mush; a couple of bars is long enough to
// hear the harmony and short enough to let go of it.
const CHORD_MAX_TICKS = 8 * TICKS_PER_CROTCHET;

function comp(
  chords: ChordSym[], endTick: number, secPerTick: number, shift: number,
  bassSounds: boolean, into: NoteEvent[],
): void {
  const sorted = chords.slice().sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const midis = voiceChord(c.sym, bassSounds);
    if (!midis.length) continue;
    // Until the next change, or until the music stops.
    const until = i + 1 < sorted.length ? sorted[i + 1].tick : endTick;
    const span = Math.min(CHORD_MAX_TICKS, Math.max(TICKS_PER_CROTCHET / 4, until - c.tick));
    for (const midi of midis) {
      into.push({
        midi: midi + shift,
        at: c.tick * secPerTick,
        // Just short of the next change, so one voicing lets go before the
        // next arrives instead of blurring into it.
        dur: span * secPerTick * 0.92,
        vel: CHORD_VELOCITY,
        voice: 'chords',
      });
    }
  }
}

// One symbol as a handful of notes.
//
// Guide tones first — the third and the seventh are what make a chord the
// chord it is — plus whatever alterations were written, since a b9 nobody
// plays is a b9 nobody wrote. The natural fifth is left out of a seventh chord
// (it says the least of any tone in it) and kept in a triad, which has nothing
// else to say. The root goes in underneath only when no bass line is playing:
// doubling a walking bass is how comping turns to mud.
function voiceChord(sym: string, bassSounds: boolean): number[] {
  const c = parseChord(sym);
  if (!c) return [];
  const third = c.tones.find(t => t.role === 'third');
  const seventh = c.tones.find(t => t.role === 'seventh' || t.role === 'sixth');
  const fifth = c.tones.find(t => t.role === 'fifth');
  const semis: number[] = [];
  if (third) semis.push(third.semi);
  if (seventh) semis.push(seventh.semi);
  if (fifth && (!seventh || fifth.semi !== 7)) semis.push(fifth.semi);
  for (const t of c.tones) if (t.role === 'tension') semis.push(t.semi);
  const pcs = [...new Set(semis.map(n => mod(c.rootPc + n, 12)))];
  const upper = pcs
    .map(pc => CHORD_FLOOR + mod(pc - CHORD_FLOOR, 12))
    .sort((a, b) => a - b);
  if (bassSounds) return upper;
  // The slash bass is an instruction about the bottom note; with no bass staff
  // playing, this is the only voice that can carry it out.
  const low = c.bassPc ?? c.rootPc;
  return [ROOT_FLOOR + mod(low - ROOT_FLOOR, 12), ...upper];
}

// One symbol as a chord you'd know on hearing it, on its own, with nothing
// else playing — which is a different job from comping.
//
// Comping leaves things OUT on purpose: the root because the bass has it, the
// fifth because it says the least, and what's left leans on the tune above it
// to be heard as a harmony at all. Struck alone that comes out as a bare
// interval you have to work out. So this plays the whole thing: the root
// underneath (the slash bass when one is written, since that's the note the
// chord is asking to sit on), and every tone above it stacked upwards in
// close position from the register the guide tones live in, so the chord
// arrives in the order it's spelled instead of inverted into a shape.
export function auditionChord(sym: string, onBass = false): { root: number; upper: number[] } | null {
  const c = parseChord(sym);
  if (!c) return null;
  const lowPc = c.bassPc ?? c.rootPc;
  const floor = onBass ? BASS_ROOT_FLOOR : ROOT_FLOOR;
  const root = floor + mod(lowPc - floor, 12);
  // Everything the chord is made of, minus whatever is already in the bass.
  const upper: number[] = [];
  const seen = new Set<number>([lowPc]);
  let last = CHORD_FLOOR - 1;
  for (const t of c.tones) {
    if (seen.has(t.pc)) continue;
    seen.add(t.pc);
    last += 1 + mod(t.pc - last - 1, 12);
    upper.push(last);
  }
  return { root, upper };
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Triplet swing: the beat is felt as two thirds + one third, so the off-beat
// eighth lands late. Warp positions on a piecewise-linear map of the beat
// rather than rewriting durations, so notes longer than a beat are left alone
// — both their ends warp identically.
const SWING_POINT = 2 / 3;

// …but the map runs BEAT BY BEAT, and only a beat actually divided in two gets
// the lilt. Anything else in the beat and it plays dead straight.
//
// Swing is a statement about where the SECOND of two eighths lands, so it has
// nothing to say about a beat divided any other way:
//   • sixteenths — nobody swings them. A run of them is even, and the classic
//     dotted-eighth-sixteenth figure is already the long-short the map is
//     trying to impose; put it through as well and the sixteenth lands
//     somewhere no player would put it.
//   • tuplets — a written triplet has already said how the beat divides, in
//     the same thirds the swing map works in. Warping it on top just makes a
//     lopsided triplet out of an even one.
// So a beat is swung or straight as a whole, decided by what's written in it.
const TICKS_PER_QUAVER = TICKS_PER_CROTCHET / 2;

function beatOf(tick: number): number {
  return Math.floor(tick / TICKS_PER_CROTCHET);
}

// Both halves of the map agree at every beat line — the swung one sends 0 to 0
// and 1 to 1 — so mixing straight and swung beats stays continuous, and a note
// that spans the join comes out with its ends in the right places.
function swingWarp(beatSec: number, straight: Set<number>): (t: number) => number {
  if (beatSec <= 0) return t => t;
  return (t: number) => {
    const beat = Math.floor(t / beatSec + 1e-9);
    if (straight.has(beat)) return t;
    const f = t / beatSec - beat;
    const nf = f < 0.5
      ? f * (SWING_POINT / 0.5)
      : SWING_POINT + (f - 0.5) * ((1 - SWING_POINT) / 0.5);
    return (beat + nf) * beatSec;
  };
}

function swingEvents(events: NoteEvent[], beatSec: number, straight: Set<number>): NoteEvent[] {
  if (beatSec <= 0) return events;
  const warp = swingWarp(beatSec, straight);
  return events.map(e => {
    const at = warp(e.at);
    const end = warp(e.at + e.dur);
    return { ...e, at, dur: Math.max(0.03, end - at) };
  });
}

function sameMidis(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── the voices ───────────────────────────────────────────────────────
// smplr is loaded from the same CDN the page already uses for abcjs, and a
// patch is only fetched by a performance that actually needs it — a chart with
// no chord line never downloads a Rhodes, and one that never plays never
// downloads anything.
//
// Each voice gets its own gain bus, so a volume can move while the music is
// running: the whole point of a mixer here is to turn the comping down until
// the line you are checking comes through, WHILE it comes through.

const SMPLR_URL = 'https://cdn.jsdelivr.net/npm/smplr@1.0.0/dist/index.mjs';
// What a MIDI keyboard is heard on, and how loud it sits. A Rhodes because it
// sits under a recording without arguing with it, and because it is the sound
// the keyboard page next door plays — one keyboard, one voice, wherever you
// happen to have it open.
const KEYS_PATCH = 'electric_piano_1';
const KEYS_VOLUME = 0.85;

// A fixed trim inside the sampler; the per-voice bus does the actual mixing.
const PATCH_VOLUME = 110;

// How far ahead of the audio clock notes are committed, and how often we top
// the window up. 200ms is plenty to stay ahead of timer jitter while keeping
// Stop effectively instant.
const LOOKAHEAD = 0.2;
const PUMP_MS = 60;

// A clicked note is heard, not measured: long enough to register at any tempo,
// short enough that a semibreve doesn't ring on while you click the next one.
const PREVIEW_MIN = 0.32;
const PREVIEW_MAX = 1.1;

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

export class Player {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  // One bus per voice, between the sampler and the master gain.
  private bus: Partial<Record<Voice, GainNode>> = {};
  // The sampler each voice is on, and which patch it is — a voice whose patch
  // has changed has to load the new one before it can sound again.
  private inst: Partial<Record<Voice, { patch: string; inst: any }>> = {};
  private loading: Partial<Record<Voice, { patch: string; p: Promise<any> }>> = {};
  private mix: Mix = mixOf(null);
  private timer: number | null = null;
  private startedAt = 0;
  private length = 0;
  // Incremented by every stop/play so stale async work can detect it lost.
  private generation = 0;
  // The same idea for previews, counted separately so a click can't cancel
  // the transport and the transport can't cancel a click.
  private previewGen = 0;
  // ── the MIDI keyboard ──────────────────────────────────────────────
  // Its own sampler on its own bus, outside the mix entirely: the mix says how
  // the SCORE is heard, and muting the tune to check a line by ear is exactly
  // when you want the keyboard under your hands to keep speaking.
  private keys: any = null;
  private keysP: Promise<any> | null = null;
  private keysBus: GainNode | null = null;
  // Sounding keys, by the note that was PRESSED, each with the handle that
  // stops it. Keyed by the pressed note rather than the sounding one so that
  // changing CONCERT= mid-hold can't strand a note ringing.
  private held = new Map<number, () => void>();
  // …and the ones the pedal is holding after the key came up.
  private sustained = new Set<number>();
  private pedalDown = false;
  // How far what is played is moved before it sounds — see CONCERT=.
  private keyShift = 0;

  playing = false;

  // Whether the samples are still coming down the wire, for the button state.
  // The tune's: it's the one nothing can play without.
  get loadingSamples(): boolean { return !!this.loading.lead && !this.inst.lead; }

  // The mix this song is set to. Volumes take effect at once — including in
  // the middle of a performance, which is when you actually want them — and a
  // changed patch is picked up the next time that voice has to sound.
  setMix(mix: Mix): void {
    this.mix = mix;
    for (const v of VOICES) {
      const bus = this.bus[v];
      if (bus) bus.gain.value = mix[v].on ? mix[v].vol : 0;
    }
  }

  // The audio context and the master gain under everything. Split out of
  // ensure() because the MIDI keyboard needs the same two and asks for them by
  // a different road — and because the context has to be MADE synchronously,
  // inside the gesture that called for it, before anything is awaited.
  private async boot(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext!;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.ctx.destination);
    } else if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  private async ensure(voice: Voice = 'lead'): Promise<any> {
    const ctx = await this.boot();
    let bus = this.bus[voice];
    if (!bus) {
      bus = ctx.createGain();
      bus.gain.value = this.mix[voice].on ? this.mix[voice].vol : 0;
      bus.connect(this.gain as GainNode);
      this.bus[voice] = bus;
    }
    const patch = this.mix[voice].patch;
    const have = this.inst[voice];
    if (have && have.patch === patch) return have.inst;
    const going = this.loading[voice];
    if (going && going.patch === patch) return going.p;
    const p = import(/* @vite-ignore */ SMPLR_URL)
      .then(lib => {
        const inst = new lib.Soundfont(this.ctx, {
          instrument: patch,
          destination: bus,
          volume: PATCH_VOLUME,
        });
        return inst.ready.then(() => {
          // A newer patch may have been asked for while this one loaded; the
          // last one asked for is the one that wins.
          if (this.mix[voice].patch === patch) this.inst[voice] = { patch, inst };
          return inst;
        });
      })
      .catch(err => { if (this.loading[voice]?.patch === patch) delete this.loading[voice]; throw err; });
    this.loading[voice] = { patch, p };
    return p;
  }

  // Play with a LOOK-AHEAD window rather than committing the whole score to
  // the audio graph up front.
  //
  // Scheduling everything at once made Stop unreliable: smplr's voice.stop()
  // early-returns unless the voice is already "playing", so notes queued for a
  // future time could outlive it — the score kept going after Stop, and
  // pressing Play again layered a second copy on top. Here only the next
  // ~200ms is ever committed, so clearing the timer stops everything almost
  // immediately, and there is nothing left over to double up against.
  async play(events: NoteEvent[], onEnd?: () => void): Promise<void> {
    // Stop BEFORE awaiting, so a fast Play→Play can't interleave two runs.
    this.stop();
    const gen = ++this.generation;
    // Only the voices this performance actually uses are fetched — a tune with
    // no chord line and no bass staff costs exactly what it always did.
    const want = new Set<Voice>(events.map(e => e.voice ?? 'lead'));
    const on: Partial<Record<Voice, any>> = {};
    await Promise.all([...want].map(v => this.ensure(v).then(inst => { on[v] = inst; })));
    // A stop (or another play) landed while the samples were loading.
    if (gen !== this.generation || !this.ctx) return;

    const queue = events.slice().sort((a, b) => a.at - b.at);
    this.length = queue.reduce((m, e) => Math.max(m, e.at + e.dur), 0);
    const base = this.ctx.currentTime + 0.12;
    this.startedAt = base;
    this.playing = true;

    let i = 0;
    const pump = () => {
      if (gen !== this.generation || !this.ctx) return;
      const horizon = this.ctx.currentTime + LOOKAHEAD;
      while (i < queue.length && base + queue[i].at < horizon) {
        const e = queue[i++];
        on[e.voice ?? 'lead']?.start({
          note: e.midi,
          velocity: e.vel,
          time: base + e.at,
          duration: Math.max(0.05, e.dur * 0.98),
        });
      }
      if (i >= queue.length && this.ctx.currentTime > base + this.length) {
        this.playing = false;
        if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
        onEnd?.();
      }
    };
    pump();
    this.timer = window.setInterval(pump, PUMP_MS);
  }

  // Sound one written note, right now — the click-to-hear preview.
  //
  // Deliberately outside the transport: it doesn't stop what's playing, doesn't
  // touch `playing`, and doesn't bump the generation, so auditioning a note
  // mid-performance layers a single strike over it instead of cutting the run
  // short. Clicks come in faster than samples load, so a preview that arrives
  // after another one started is simply dropped.
  async preview(midis: number[], dur: number, voice: Voice = 'lead'): Promise<void> {
    return this.previewParts([{ midis, voice }], dur);
  }

  // The same, for one gesture that lands on more than one voice — a chord
  // whose root goes to the bass and whose upper structure goes to the comping
  // instrument. It has to be ONE call: each preview bumps the generation, so
  // two of them in a row would leave the second one sounding alone.
  async previewParts(parts: { midis: number[]; voice: Voice }[], dur: number): Promise<void> {
    const want = parts.filter(p => p.midis.length);
    if (!want.length) return;
    const gen = ++this.previewGen;
    const insts = await Promise.all(want.map(p => this.ensure(p.voice)));
    if (gen !== this.previewGen || !this.ctx) return;
    const length = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, dur));
    // One instant for all of them, read after the awaits, so the root and the
    // voicing over it are struck together rather than a sample-load apart.
    const time = this.ctx.currentTime;
    for (let i = 0; i < want.length; i++) {
      const voice = want[i].voice;
      const vel = voice === 'bass' ? BASS_VELOCITY
        : voice === 'chords' ? CHORD_VELOCITY
        : DEFAULT_VELOCITY;
      for (const midi of want[i].midis) {
        insts[i].start({ note: midi, velocity: vel, time, duration: length });
      }
    }
  }

  // ── the MIDI keyboard ──────────────────────────────────────────────
  //
  // Held notes rather than struck ones: a key sounds until it (and the pedal)
  // let go, which is the one thing preview() can't do.

  // Semitones between what is played and what sounds — the concert shift the
  // source declares. Only read when a key goes DOWN, so a note already ringing
  // keeps the pitch it started at.
  setKeyShift(semitones: number): void { this.keyShift = semitones; }

  // A key went down. Resolves false when the browser won't let us make a sound
  // yet — an AudioContext can only start inside a gesture, and a MIDI message
  // isn't one — so the caller can say so rather than leaving you wondering.
  async keyDown(note: number, velocity: number): Promise<boolean> {
    const ctx = await this.boot();
    const inst = await this.keysInst();
    if (ctx.state !== 'running') return false;
    // Retrigger: the same key struck again while it was still sounding.
    this.cut(note);
    this.sustained.delete(note);
    const off = inst.start({ note: note + this.keyShift, velocity });
    if (typeof off === 'function') this.held.set(note, off);
    return true;
  }

  keyUp(note: number): void {
    if (this.pedalDown) { this.sustained.add(note); return; }
    this.cut(note);
  }

  setPedal(down: boolean): void {
    this.pedalDown = down;
    if (down) return;
    for (const note of this.sustained) this.cut(note);
    this.sustained.clear();
  }

  // Everything the keyboard has sounding, off — the panic message, and what a
  // device being unplugged mid-chord has to come to.
  allKeysOff(): void {
    for (const note of [...this.held.keys()]) this.cut(note);
    this.sustained.clear();
    this.pedalDown = false;
  }

  private cut(note: number): void {
    const off = this.held.get(note);
    if (!off) return;
    this.held.delete(note);
    try { off(); } catch { /* already gone */ }
  }

  // The keyboard's sampler: a Rhodes, which sits under a recording without
  // arguing with it the way a piano does. Loaded on the first key played, and
  // once only.
  private keysInst(): Promise<any> {
    if (this.keys) return Promise.resolve(this.keys);
    if (this.keysP) return this.keysP;
    if (!this.keysBus && this.ctx && this.gain) {
      this.keysBus = this.ctx.createGain();
      this.keysBus.gain.value = KEYS_VOLUME;
      this.keysBus.connect(this.gain);
    }
    this.keysP = import(/* @vite-ignore */ SMPLR_URL)
      .then(lib => {
        const inst = new lib.Soundfont(this.ctx, {
          instrument: KEYS_PATCH,
          destination: this.keysBus,
          volume: PATCH_VOLUME,
        });
        return inst.ready.then(() => { this.keys = inst; return inst; });
      })
      .catch(err => { this.keysP = null; throw err; });
    return this.keysP;
  }

  stop(): void {
    // Bumping the generation makes any in-flight pump or pending ensure() a
    // no-op, so nothing can schedule after this point.
    this.generation++;
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
    for (const v of VOICES) {
      const held = this.inst[v];
      if (held) { try { held.inst.stop(); } catch { /* ignore */ } }
    }
    this.playing = false;
  }

  // Seconds into the performance, for a play-head. 0 when stopped.
  position(): number {
    if (!this.playing || !this.ctx) return 0;
    return Math.max(0, Math.min(this.length, this.ctx.currentTime - this.startedAt));
  }
}
