// Function-based note/chord spelling — the single source of truth for how we
// choose enharmonic letters across the trainer.
//
// The idea: spell a pitch class by its DIATONIC FUNCTION (which scale degree of
// which key it is), not by a blanket flat/sharp guess. A half-diminished chord
// on pitch class 8 is the iiø of F♯ minor, so it spells G♯m7♭5 — never A♭m7♭5.
//
// Everything is grounded on the app's existing, already-idiomatic key-tonic
// spellings (MAJOR_SPELL / MINOR_SPELL below): once we know the implied key's
// tonic letter, walking the diatonic letters by the degree number fixes every
// other letter. Used by keys.ts (pentatonic), chords.ts (grouping grid) and
// iivi.ts (ii–V–I).

import { KeySig, PitchClass, Quality } from './types';

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Diatonic letter ↔ natural pitch class.
export const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
export const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];   // natural pc of C D E F G A B
const LETTER_BY_PC: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };

// Conventional tonic spellings for the 12 major and 12 minor keys — flat-leaning
// majors (D♭/E♭/G♭/A♭/B♭) and sharp-leaning minors (C♯/F♯/G♯), matching how
// these keys are notated. These are the anchor for every derived spelling.
export const MAJOR_SPELL = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const MINOR_SPELL = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

// Signed accidental (semitones) turning a letter's natural pc into the target
// pc, in [−2, +2] (double-flat … double-sharp).
export function signedAcc(targetPc: PitchClass, letterPc: PitchClass): number {
  const acc = ((targetPc - letterPc + 18) % 12) - 6;   // [-6, 5]
  return Math.max(-2, Math.min(2, acc));
}

// Accidental glyphs (Unicode ♭/♯, doubled for ±2). ChordText/ChordSymbol later
// fold ♭→b and ♯→# for the handwritten-chart look.
function accGlyph(acc: number): string {
  if (acc <= -2) return '♭♭';
  if (acc === -1) return '♭';
  if (acc >= 2) return '♯♯';
  if (acc === 1) return '♯';
  return '';
}

// Display name for a letter pitch class + accidental, e.g. (7, +1) → "G♯".
export function letterName(letterPc: PitchClass, acc: number): string {
  return (LETTER_BY_PC[mod(letterPc, 12)] ?? 'C') + accGlyph(acc);
}

export interface DegreeSpelling {
  letterPc: PitchClass;
  letterIdx: number;   // 0..6 (C..B), so callers can spell tones above it
  acc: number;
  name: string;        // Unicode display, e.g. "G♯"
}

// Spell `targetPc` as the `degreeNum`-th diatonic degree of (tonicPc, quality).
// The key's tonic LETTER comes from the conventional tables above; advancing it
// by the degree fixes the target's letter, and the accidental falls out.
export function spellDegree(
  tonicPc: PitchClass, quality: Quality, degreeNum: number, targetPc: PitchClass,
): DegreeSpelling {
  const tonicName = (quality === 'major' ? MAJOR_SPELL : MINOR_SPELL)[mod(tonicPc, 12)];
  const letterIdx = (LETTER_IDX[tonicName[0]] + (degreeNum - 1)) % 7;
  const letterPc = LETTER_PC[letterIdx];
  const acc = signedAcc(targetPc, letterPc);
  return { letterPc, letterIdx, acc, name: letterName(letterPc, acc) };
}

// The key signature of (tonicPc, quality), derived from music theory: spell the
// key's diatonic scale (major, or natural minor for minor keys — natural minor's
// signature IS its relative major's) and read the accidental on each of the
// seven letters. That accidental map drives minimal on-staff accidentals; the
// abcKey token (e.g. "D", "F#m", "Gb") sets abcjs's drawn signature. Grounded on
// the conventional tonic spellings (MAJOR_SPELL / MINOR_SPELL), so e.g. the iiø
// of pc-6 minor implies F♯ minor (3 sharps), never G♭ minor.
export function keySignature(tonicPc: PitchClass, quality: Quality): KeySig {
  const tonicName = (quality === 'major' ? MAJOR_SPELL : MINOR_SPELL)[mod(tonicPc, 12)];
  const tonicLetterIdx = LETTER_IDX[tonicName[0]];
  const steps = quality === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const acc: Record<number, number> = {};
  for (let i = 0; i < 7; i++) {
    const letterPc = LETTER_PC[(tonicLetterIdx + i) % 7];
    acc[letterPc] = signedAcc(mod(tonicPc + steps[i], 12), letterPc);
  }
  const abcKey = tonicName.replace('♭', 'b').replace('♯', '#') + (quality === 'minor' ? 'm' : '');
  return { abcKey, acc };
}

// Spell each tone of a chord by its interval letter above the root: tone i takes
// the letter `degNums[i]` steps above the root letter (1=root, 3=third, …).
// Returns a pc → { letterPc, acc } map ready for spellToAbc on the staff.
export function spellChordTones(
  rootLetterIdx: number, degNums: number[], tonePcs: PitchClass[],
): Record<number, { letterPc: PitchClass; acc: number }> {
  const out: Record<number, { letterPc: PitchClass; acc: number }> = {};
  for (let i = 0; i < tonePcs.length; i++) {
    const letterPc = LETTER_PC[(rootLetterIdx + (degNums[i] - 1)) % 7];
    out[mod(tonePcs[i], 12)] = { letterPc, acc: signedAcc(tonePcs[i], letterPc) };
  }
  return out;
}
