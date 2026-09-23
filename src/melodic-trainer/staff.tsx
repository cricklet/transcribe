// Engraved staff via abcjs (loaded from CDN by melodic-trainer.html).
// Much simpler than rhythm-trainer/staff.tsx — we don't need to map
// notehead positions back to timing slots, just engrave a static ABC
// string and recolor the strokes for our theme.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

declare global {
  interface Window {
    ABCJS?: any;
  }
}

type Props = {
  abc: string;
  // Width hint for abcjs's staffwidth setting. Larger → more horizontal
  // breathing room.
  width?: number;
  scale?: number;
  // The component re-renders the inner SVG whenever any of these change.
  // ABC text is the primary key.
};

export function Staff({ abc, width = 720, scale = 1.6 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [, setBump] = useState(0);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    if (!window.ABCJS) {
      // CDN script not loaded yet — retry shortly.
      const t = window.setTimeout(() => setBump(v => v + 1), 80);
      return () => clearTimeout(t);
    }
    host.innerHTML = '';
    window.ABCJS.renderAbc(host, abc, {
      staffwidth: width,
      scale,
      paddingtop: 0,
      paddingbottom: 0,
      paddingleft: 0,
      paddingright: 0,
    });

    // abcjs computes a tight viewBox (and sets overflow:hidden inline, so a
    // stylesheet rule can't win) which slices the treble-clef flourish and
    // any notehead riding an edge. Force overflow visible and pad the viewBox
    // outward — growing the pixel box in step so the engraving keeps its size
    // with a clear margin around it. Nothing gets clipped this way.
    const svg = host.querySelector('svg');
    if (svg) {
      svg.style.overflow = 'visible';
      const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
      if (vb.length === 4 && vb.every(n => !Number.isNaN(n))) {
        const [x, y, w, h] = vb;
        // Margins in viewBox units. EXTRA at the bottom so the treble clef's
        // tail isn't clipped, and so the box's vertical centre sits on the
        // staff (not riding high) — which keeps the label/arrow/staff row
        // aligned when the flex row centres them.
        const ml = 6, mr = 6, mt = 6, mb = 18;
        const nw = w + ml + mr, nh = h + mt + mb;
        svg.setAttribute('viewBox', `${x - ml} ${y - mt} ${nw} ${nh}`);
        const pw = parseFloat(svg.getAttribute('width') || `${w}`);
        const ph = parseFloat(svg.getAttribute('height') || `${h}`);
        if (!Number.isNaN(pw)) svg.setAttribute('width', `${pw * nw / w}`);
        if (!Number.isNaN(ph)) svg.setAttribute('height', `${ph * nh / h}`);
      }
    }

    // abcjs paints SVG paths/text in black; recolor to follow our --ink.
    // We toggle CSS classes on the wrapper rather than mutating attributes
    // so the existing pages/rhythm-trainer.css trick (.staff svg path { fill: var(--ink) })
    // can repeat here via the CSS rule we ship in melodic-trainer.css.
  }, [abc, width, scale]);

  return <div class="mt-staff" ref={ref} />;
}

// ───── ABC helpers ──────────────────────────────────────────────────

// Convert a MIDI note number to an ABC token like "_E," / "c" / "^F'".
// We choose enharmonic spelling based on the requested "preferFlat" hint
// — handy for displaying answers in the context of a flat-key chord.
//
// We always emit a key signature of Cmaj in the surrounding string so
// all accidentals are explicit and predictable.
export function midiToAbc(midi: number, preferFlat = false): string {
  // Octave indices: C4 = MIDI 60 → ABC "c" (lowercase, no commas).
  // C5 = MIDI 72 → "c'". C3 = MIDI 48 → "C,". B3 = MIDI 59 → "B,".
  // ABC's "default" octave straddles between B and c: uppercase letters
  // are below middle C, lowercase at and above middle C, then add ' for
  // each octave up, , for each octave down (only on the case-flipped side).
  const pc = ((midi % 12) + 12) % 12;
  // Naming: pick the spelling per `preferFlat`.
  // 0=C, 1=C♯/D♭, 2=D, 3=D♯/E♭, 4=E, 5=F, 6=F♯/G♭, 7=G, 8=G♯/A♭, 9=A, 10=A♯/B♭, 11=B
  const sharpNames: [string, string][] = [
    ['C',''], ['C','^'], ['D',''], ['D','^'], ['E',''], ['F',''],
    ['F','^'], ['G',''], ['G','^'], ['A',''], ['A','^'], ['B',''],
  ];
  const flatNames: [string, string][] = [
    ['C',''], ['D','_'], ['D',''], ['E','_'], ['E',''], ['F',''],
    ['G','_'], ['G',''], ['A','_'], ['A',''], ['B','_'], ['B',''],
  ];
  const [letter, acc] = (preferFlat ? flatNames : sharpNames)[pc];

  // ABC pitch octave (the *displayed* letter case + commas/apostrophes)
  // is computed from MIDI relative to middle C (MIDI 60 → "c").
  const midiC = 60;
  const semitonesFromC4 = midi - midiC;
  // Each diatonic letter has its own anchor MIDI. We computed the letter
  // from pc, but the staff-octave-of-the-letter is determined by which
  // diatonic octave contains the *pc letter*, not the chromatic semitone.
  //   B3 = MIDI 59 → letter B → octave 3 (below middle C) → "B,"
  //   C4 = MIDI 60 → letter C → octave 4 → "C" (uppercase ABC)
  // Determine the ABC octave from MIDI directly: octave = floor(midi/12) - 1.
  // C4 in ABC is "C" (no commas/apostrophes), C5 = "c", C6 = "c'", etc.
  // Edge: midi 59 (B3) — semitone-wise just below C4, but it's still in
  // octave 3 (MIDI 48..59).
  const midiOctave = Math.floor(midi / 12) - 1;

  // ABC convention from abcjs docs:
  //   Uppercase letter, no marks: notes in octave 4 (C4..B4).
  //   Lowercase letter, no marks: notes in octave 5 (C5..B5).
  // Wait — that's not right either. Actually ABC default tuning:
  //   "C" = C4 (middle C), "c" = C5 (octave above), "c'" = C6, etc.
  //   "C," = C3, "C,," = C2.
  // So: midiOctave 4 → uppercase, no marks. octave 5 → lowercase, no marks.
  // octave 6 → lowercase + one '. octave 3 → uppercase + one ,.
  let abcLetter = letter;
  let octMark = '';
  if (midiOctave >= 5) {
    abcLetter = letter.toLowerCase();
    if (midiOctave > 5) octMark = "'".repeat(midiOctave - 5);
  } else if (midiOctave < 4) {
    octMark = ','.repeat(4 - midiOctave);
  }
  return `${acc}${abcLetter}${octMark}`;
}

// ABC token for an EXPLICITLY-spelled note: a diatonic letter (by its natural
// pitch class), a signed accidental (−2…+2), and a MIDI for the octave. Lets the
// caller spell by function (e.g. B♭ vs A♯) rather than the flat/sharp heuristic.
// The octave comes from the letter's natural MIDI (midi − acc), so enharmonic
// spellings like C♭/B♯ land in the right octave.
const LETTER_BY_PC: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
export function spellToAbc(letterPc: number, acc: number, midi: number): string {
  const accStr = acc <= -2 ? '__' : acc === -1 ? '_' : acc >= 2 ? '^^' : acc === 1 ? '^' : '';
  const natMidi = midi - acc;                       // MIDI of the natural letter
  const octave = Math.floor(natMidi / 12) - 1;
  let letter = LETTER_BY_PC[((letterPc % 12) + 12) % 12] ?? 'C';
  let octMark = '';
  if (octave >= 5) { letter = letter.toLowerCase(); if (octave > 5) octMark = "'".repeat(octave - 5); }
  else if (octave < 4) octMark = ','.repeat(4 - octave);
  return `${accStr}${letter}${octMark}`;
}

// The default (heuristic) spelling of a MIDI note as a diatonic letter + signed
// accidental, choosing flats or sharps per `preferFlat`. The numeric counterpart
// to midiToAbc's internal table — used so wrong/unspelled notes can route through
// the key-signature-aware tokenizer with consistent accidental tracking.
const SHARP_SPELL: [number, number][] = [
  [0, 0], [0, 1], [2, 0], [2, 1], [4, 0], [5, 0], [5, 1], [7, 0], [7, 1], [9, 0], [9, 1], [11, 0],
];
const FLAT_SPELL: [number, number][] = [
  [0, 0], [2, -1], [2, 0], [4, -1], [4, 0], [5, 0], [7, -1], [7, 0], [9, -1], [9, 0], [11, -1], [11, 0],
];
export function defaultSpelling(midi: number, preferFlat = false): { letterPc: number; acc: number } {
  const pcv = ((midi % 12) + 12) % 12;
  const [letterPc, acc] = (preferFlat ? FLAT_SPELL : SHARP_SPELL)[pcv];
  return { letterPc, acc };
}

// ABC token for a note drawn UNDER A KEY SIGNATURE. `sigAcc` is the signature's
// accidental per natural-letter pc; `active` tracks the accidental currently in
// force for each (letter, octave) within the line (ABC carries an accidental to
// the end of its measure). We emit an explicit sharp/flat/natural only when the
// note's accidental differs from what's already sounding — exactly what an
// engraver writes — so in-key notes draw bare and out-of-key notes get their
// sign (incl. a natural to cancel the signature). `active` is mutated.
// `explicit` writes the accidental on every altered note even where the
// signature already implies it (the "on+acc" key-sig mode: the signature is
// drawn, but a C♯ in D major still reads ♯C on the staff). Naturals stay
// engraver's naturals — written only where there IS something to cancel — so
// the staff doesn't sprout a ♮ on every unaltered note.
export function spellToAbcKeyed(
  letterPc: number, acc: number, midi: number,
  sigAcc: Record<number, number>, active: Map<string, number>, explicit = false,
): string {
  const lp = ((letterPc % 12) + 12) % 12;
  const natMidi = midi - acc;
  const octave = Math.floor(natMidi / 12) - 1;
  const k = `${lp}@${octave}`;
  const sig = sigAcc[lp] ?? 0;
  const current = active.has(k) ? (active.get(k) as number) : sig;
  let accStr = '';
  if (explicit ? (acc !== 0 || current !== 0) : acc !== current) {
    accStr = acc <= -2 ? '__' : acc === -1 ? '_' : acc >= 2 ? '^^' : acc === 1 ? '^' : '=';
    active.set(k, acc);
  }
  let letter = LETTER_BY_PC[lp] ?? 'C';
  let octMark = '';
  if (octave >= 5) { letter = letter.toLowerCase(); if (octave > 5) octMark = "'".repeat(octave - 5); }
  else if (octave < 4) octMark = ','.repeat(4 - octave);
  return `${accStr}${letter}${octMark}`;
}

// Wrap a body string in a minimal ABC document. Useful default for
// chord-and-given-note prompts.
export function abcDocument(opts: {
  meter?: string;
  unit?: string;
  key?: string;
  body: string;
}): string {
  const meter = opts.meter ?? '4/4';
  const unit = opts.unit ?? '1/4';
  const key = opts.key ?? 'Cmaj';
  // %%stretchlast 0 keeps abcjs from stretching the (only) measure out to the
  // full staffwidth, which would otherwise float a lone note far to the right
  // with a big gap after the key signature. We want it packed in tight.
  return `X:1\n%%stretchlast 0\nM:${meter}\nL:${unit}\nK:${key}\n${opts.body}`;
}
