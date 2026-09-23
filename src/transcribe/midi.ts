// A MIDI keyboard plugged into the machine, heard over the transcription.
//
// The point isn't to write anything down: it's that working a line out means
// playing it, and the nearest keyboard shouldn't need a second tab open to be
// audible. So this is deliberately thin — note on, note off, the sustain
// pedal, and which device is talking. What it SOUNDS is playback.ts's business
// (a Rhodes on a bus of its own), and how far it is moved is the source's (see
// CONCERT= in parse.ts).
//
// Nothing here asks the user for anything: Web MIDI is requested once on load,
// and a browser that says no, or has nothing plugged in, simply never reports
// a device — the app looks exactly as it did before.

// Just enough of the Web MIDI API to talk to it. Declared here rather than
// leaned on from lib.dom, which has only carried these types for a few
// versions — this file is four fields deep into the API and none of them are
// going to change.
type MidiPort = {
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data?: Uint8Array | null }) => void) | null;
};
type MidiAccess = {
  inputs: { values(): Iterable<MidiPort> };
  onstatechange: (() => void) | null;
};
// Read through this local shape rather than a global declaration, which
// would clash with the lib.dom that does carry the types.
type MidiNavigator = { requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<MidiAccess> };

export type MidiEvents = {
  // A key went down, with the velocity it was struck at (1–127).
  down: (note: number, velocity: number) => void;
  // …and came up. The pedal may still be holding it; that's decided further in.
  up: (note: number) => void;
  // The sustain pedal (CC64).
  pedal: (down: boolean) => void;
  // All-notes-off / all-sound-off, and anything else that means "stop".
  panic: () => void;
  // Which device is playing, or null when none is. Called on every change, so
  // it's also how a keyboard plugged in after the page loaded is noticed.
  device: (name: string | null) => void;
};

// MIDI velocity, compressed so a light touch still speaks. A sampled Rhodes
// picked at velocity 20 is very nearly silent, and a keyboard you are checking
// a line on is not being played for dynamics — the same floor midi.html uses.
const VEL_FLOOR = 64;

function velocity(v: number): number {
  const c = Math.min(127, Math.max(1, v));
  return Math.round(VEL_FLOOR + (127 - VEL_FLOOR) * (c / 127));
}

// The sustain pedal. The other two (sostenuto, una corda) are left out on
// purpose: this is a reading tool, and a half-implemented sostenuto is worse
// than none.
const SUSTAIN_CC = 64;

export function listenMidi(h: MidiEvents): () => void {
  let access: MidiAccess | null = null;
  let dead = false;

  const onMessage = (e: { data?: Uint8Array | null }) => {
    const data = e.data;
    if (!data || data.length < 2) return;
    const cmd = data[0] & 0xf0;
    const a = data[1];
    const b = data.length > 2 ? data[2] : 0;
    if (cmd === 0x90 && b > 0) h.down(a, velocity(b));
    else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) h.up(a);
    else if (cmd === 0xb0) {
      if (a === SUSTAIN_CC) h.pedal(b >= 64);
      else if (a === 120 || a === 123) h.panic();
    }
  };

  // Every input, every time the set of them changes — a keyboard plugged in
  // later is the same case as one that was there all along.
  const attach = () => {
    if (!access || dead) return;
    const names: string[] = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = onMessage;
      if (input.state === 'connected') names.push(input.name ?? 'MIDI');
    }
    h.device(names.length ? names.join(', ') : null);
  };

  const nav = navigator as unknown as MidiNavigator;
  if (!nav.requestMIDIAccess) return () => { /* nothing to let go of */ };
  nav.requestMIDIAccess({ sysex: false }).then(
    got => {
      if (dead) return;
      access = got;
      got.onstatechange = () => { h.panic(); attach(); };
      attach();
    },
    () => { /* refused, or no MIDI here — stay quiet about it */ },
  );

  return () => {
    dead = true;
    if (!access) return;
    access.onstatechange = null;
    for (const input of access.inputs.values()) input.onmidimessage = null;
    access = null;
  };
}
