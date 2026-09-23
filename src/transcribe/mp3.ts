// Playing the song a transcription was made from.
//
// The recipe is the loop player's, because it's the one that works: run the
// buffer source FAST OR SLOW (`playbackRate`) and put the pitch back where it
// belongs with a RubberBand stretcher. Doing it the other way round — asking
// the stretcher to change tempo — costs a lot more CPU and drifts; this way
// the browser resamples and RubberBand only ever transposes.
//
// Each stem is a source of its own with its own stretcher and its own gain, so
// a stem can be dropped out of the mix without disturbing the rest. What keeps
// them together is `offset`: stems come back from a separation service
// re-encoded, and the browser trims their encoder padding differently from the
// original's, so a stem's audio sits a few tens of a millisecond away from the
// main track's. The loop player measures that once and stores it; this reads
// the number rather than measuring it again.
//
// Deliberately NOT here: looping. The loop player loops; this is a reading
// head for a transcription — one playhead, playing forward.

import { createRubberBandNode, RubberBandNode } from 'rubberband-web';
// @ts-ignore — esbuild inlines this as a string via --loader:.txt=text
import processorSrc from '../../.build/rubberband-processor.txt';

// One decoded track: the song itself, or one of its stems.
type Voice = {
  id: string;
  buffer: AudioBuffer;
  // Seconds this voice's audio sits later than the main track's.
  offset: number;
  on: boolean;
  // How loud this track sits in the mix, 0–1. Separate from `on`, so muting a
  // stem and bringing it back doesn't cost the level you set for it.
  level: number;
  gain: GainNode | null;
  rb: RubberBandNode | null;
  src: AudioBufferSourceNode | null;
};

export type LoadPart = { id: string; bytes: ArrayBuffer; offset?: number };

// The main mix's id inside the player. It's a real voice like any stem — the
// mix is just the track that isn't a stem — so muting it to hear the stems on
// their own needs no special case.
export const MIX = '__mix__';

// How many buckets the waveform is reduced to. Enough for a full-width strip
// on a large display zoomed well in, cheap enough to compute on every open.
const PEAKS = 16000;

let processorUrl: string | null = null;
function rubberbandUrl(): string {
  if (!processorUrl) {
    processorUrl = URL.createObjectURL(new Blob([processorSrc as string], { type: 'application/javascript' }));
  }
  return processorUrl;
}

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

export class Mp3Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private volume = 0.9;
  // Playback speed as a multiple of the recording's own tempo.
  private rate = 1;
  // Semitones the recording is moved by, on top of that. Free, in the sense
  // that the stretcher is already in the chain putting back the pitch the
  // resampling took — this only asks it for a different number.
  private shift = 0;
  // Where the playhead was when we last stopped, and the audio-clock instant
  // the current run began at — together these give the live position without
  // polling anything.
  private pausedAt = 0;
  private startedPos = 0;
  private startedWall = 0;
  // Bumped by every load and every stop, so a decode or a worklet that lands
  // late can tell it has been overtaken.
  private generation = 0;

  playing = false;
  duration = 0;
  // The main mix reduced to one peak per bucket, for the waveform strip.
  peaks: Float32Array = new Float32Array(0);
  // Called when the song reaches its end on its own.
  onEnd: (() => void) | null = null;

  // ── loading ────────────────────────────────────────────────────────

  // Decode a song and its stems. Everything already loaded is thrown away
  // first, stretchers included: a RubberBand engine is not stateless — a fresh
  // one carries about 120ms of startup latency and a reused one still holds
  // the audio it was fed — so a mix of new and reused engines would sit at
  // different latencies and the stems would flam. One song, one set of
  // engines, all the same age.
  async load(main: LoadPart, stems: LoadPart[]): Promise<void> {
    const gen = ++this.generation;
    this.teardown();
    const ctx = this.audio();
    const parts = [{ ...main, id: MIX }, ...stems];
    const decoded = await Promise.all(parts.map(async p => {
      try {
        // decodeAudioData detaches what it's given, and the caller may want
        // its bytes again — decode a copy.
        return await ctx.decodeAudioData(p.bytes.slice(0));
      } catch { return null; }
    }));
    if (gen !== this.generation) return;

    this.voices = [];
    for (let i = 0; i < parts.length; i++) {
      const buffer = decoded[i];
      if (!buffer) continue;
      this.voices.push({
        id: parts[i].id, buffer, offset: parts[i].offset ?? 0,
        on: true, level: 1, gain: null, rb: null, src: null,
      });
    }
    const mix = this.voices.find(v => v.id === MIX);
    this.duration = mix?.buffer.duration ?? Math.max(0, ...this.voices.map(v => v.buffer.duration));
    this.peaks = mix ? peaksOf(mix.buffer) : new Float32Array(0);
    this.pausedAt = 0;
  }

  get loaded(): boolean { return this.voices.length > 0; }

  // Which tracks are in the mix, in load order — the song first, then its
  // stems as the library listed them.
  tracks(): { id: string; on: boolean; level: number }[] {
    return this.voices.map(v => ({ id: v.id, on: v.on, level: v.level }));
  }

  // ── the transport ──────────────────────────────────────────────────

  // Where the playhead is now, in the recording's own seconds. It's
  // extrapolated from the audio clock rather than read from anywhere: the
  // sources run at `rate`, so every wall-clock second is `rate` seconds of
  // recording.
  pos(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    const at = this.startedPos + (this.ctx.currentTime - this.startedWall) * this.rate;
    return Math.min(at, this.duration);
  }

  seek(secs: number): void {
    const at = clamp(secs, 0, Math.max(0, this.duration - 0.01));
    if (this.playing) { this.stop(); this.pausedAt = at; return; }
    this.pausedAt = at;
  }

  async play(from?: number): Promise<void> {
    if (!this.voices.length) return;
    const ctx = this.audio();
    if (ctx.state === 'suspended') await ctx.resume();
    const gen = this.generation;
    await this.wire();
    if (gen !== this.generation) return;
    this.stopSources();

    const at = clamp(from ?? this.pausedAt, 0, Math.max(0, this.duration - 0.01));
    for (const v of this.voices) {
      v.rb?.setTempo(1);
      v.rb?.setPitch(this.pitch());
    }
    // One lead-in for every voice, so they all begin at the same instant on
    // the audio clock rather than each one whenever its turn came round.
    const when = ctx.currentTime + 0.03;
    for (const v of this.voices) {
      if (!v.rb) continue;
      const src = ctx.createBufferSource();
      src.buffer = v.buffer;
      src.playbackRate.value = this.rate;
      src.connect(v.rb);
      src.start(when, clamp(at + v.offset, 0, Math.max(0, v.buffer.duration - 0.005)));
      v.src = src;
    }
    this.playing = true;
    this.startedPos = at;
    this.startedWall = when;

    // The mix decides when the song is over; a stem that was encoded a hair
    // shorter shouldn't end it early.
    const mix = this.voices.find(v => v.id === MIX) ?? this.voices[0];
    if (mix?.src) {
      const src = mix.src;
      src.onended = () => {
        if (mix.src !== src) return;      // superseded by a later play
        this.stop();
        this.pausedAt = 0;
        this.onEnd?.();
      };
    }
  }

  stop(): void {
    if (!this.voices.length) return;
    const at = this.pos();
    this.stopSources();
    this.playing = false;
    this.pausedAt = at;
    this.generation++;
  }

  // ── the knobs ──────────────────────────────────────────────────────

  // Playback speed as a multiple of the recording's own tempo. Changing it
  // mid-flight re-bases the position first, so the playhead doesn't jump.
  setRate(rate: number): void {
    const next = clamp(rate, 0.25, 2);
    if (this.playing && this.ctx) {
      this.startedPos = this.pos();
      this.startedWall = this.ctx.currentTime;
    }
    this.rate = next;
    for (const v of this.voices) {
      if (v.src) v.src.playbackRate.value = next;
      v.rb?.setPitch(this.pitch());
    }
  }

  getRate(): number { return this.rate; }

  // How far to move the recording, in semitones. Takes effect on the sound
  // already going — nothing is re-wired and no source is restarted, so the
  // playhead doesn't move and neither does the tempo.
  setShift(semitones: number): void {
    const next = clamp(Math.round(semitones), -12, 12);
    if (next === this.shift) return;
    this.shift = next;
    for (const v of this.voices) v.rb?.setPitch(this.pitch());
  }

  getShift(): number { return this.shift; }

  // What the stretcher is asked for: undo the resampling the speed knob did
  // (1 / rate), and then move the result by however many semitones.
  private pitch(): number {
    return Math.pow(2, this.shift / 12) / this.rate;
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  // Turn one track on or off. It's a gain change, not a rewiring, so it takes
  // effect on the note that's already sounding — and the tracks stay locked to
  // each other, because nothing about their sources changed.
  setTrackOn(id: string, on: boolean): void {
    const v = this.voices.find(x => x.id === id);
    if (!v) return;
    v.on = on;
    this.apply(v);
  }

  // How loud one track sits, 0–1. The same gain node the switch works, for the
  // same reason: it lands on the audio already sounding, and it can't put a
  // stem out of step with the rest.
  setTrackLevel(id: string, level: number): void {
    const v = this.voices.find(x => x.id === id);
    if (!v) return;
    v.level = clamp(level, 0, 1);
    this.apply(v);
  }

  // A switched-off track is silent whatever its level says; a switched-on one
  // is as loud as its level. One place says so, so the two can't disagree.
  private apply(v: Voice): void {
    if (v.gain) v.gain.gain.value = v.on ? v.level : 0;
  }

  // ── the graph ──────────────────────────────────────────────────────

  private audio(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext!;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const master = this.ctx.createGain();
      master.gain.value = this.volume;
      master.connect(this.ctx.destination);
      this.master = master;
    }
    return this.ctx;
  }

  // source → stretcher → track gain → master. Built once per song load; the
  // stretchers are async, which is the only reason play() awaits anything.
  private async wire(): Promise<void> {
    const ctx = this.audio();
    for (const v of this.voices) {
      if (!v.gain) {
        const g = ctx.createGain();
        g.gain.value = v.on ? v.level : 0;
        g.connect(this.master!);
        v.gain = g;
      }
      if (!v.rb) {
        const rb = await createRubberBandNode(ctx, rubberbandUrl());
        rb.setHighQuality(true);
        rb.connect(v.gain);
        v.rb = rb;
      }
    }
  }

  private stopSources(): void {
    for (const v of this.voices) {
      if (!v.src) continue;
      v.src.onended = null;
      try { v.src.stop(); } catch { /* already finished */ }
      v.src.disconnect();
      v.src = null;
    }
  }

  private teardown(): void {
    this.stopSources();
    for (const v of this.voices) {
      if (v.rb) {
        try { v.rb.close(); } catch { /* already closed */ }
        try { v.rb.disconnect(); } catch { /* already detached */ }
      }
      v.gain?.disconnect();
    }
    this.voices = [];
    this.playing = false;
    this.duration = 0;
    this.peaks = new Float32Array(0);
  }

  // Let go of the song without letting go of the AudioContext — opening
  // another transcription shouldn't cost a context, and browsers only allow a
  // few.
  unload(): void {
    this.generation++;
    this.teardown();
    this.pausedAt = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// The loudest sample in each bucket, mono. A max rather than an average
// because a waveform is read for its transients — where the hits are — and
// averaging is exactly what flattens those out.
function peaksOf(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(PEAKS);
  const chans = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  if (!len) return out;
  const per = len / PEAKS;
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < PEAKS; i++) {
      const from = Math.floor(i * per);
      const to = Math.min(len, Math.floor((i + 1) * per));
      let peak = 0;
      // Every sample of a long song is more work than the picture is worth;
      // a stride keeps a five-minute file under a few hundred thousand reads
      // and can't miss a transient by more than a handful of samples.
      const step = Math.max(1, Math.floor((to - from) / 256));
      for (let j = from; j < to; j += step) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      if (peak > out[i]) out[i] = peak;
    }
  }
  return out;
}
