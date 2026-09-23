// Chord-symbol parser. (Grew up in the comping trainer; transcribe's chord
// playback is what still uses it.)
//
// You type a symbol into the chart — "G7", "G-7", "Cmaj7", "Dm7b5",
// "Ab13", "F#7#9", "Csus4", "Bbm6", "Eø", "C/E" — and we turn it into the set
// of pitch classes it implies, spelled by function (so A7's third engraves as
// C♯, never D♭), plus the SHELL VOICING: the minimum you must actually play.
//
// For a seventh chord the shell is the 3rd + 7th (the tones that define the
// quality); for a plain triad it's the 3rd + 5th. Extensions and the root are
// welcome but never required — you can let your right hand and the bass imply
// the rest.
//
// Spelling reuses melodic-trainer's function-based speller so accidentals match
// the rest of the suite.

import { spellChordTones, letterName, LETTER_IDX, LETTER_PC } from '../melodic-trainer/spelling';

const mod = (n: number, m: number) => ((n % m) + m) % m;

export type ChordQuality = 'maj' | 'min' | 'dom' | 'dim' | 'halfdim' | 'aug' | 'sus';

export interface ChordTone {
  pc: number;                 // 0..11
  degree: number;             // 1,2,3,4,5,6,7,9,11,13 (canonical scale degree)
  semi: number;               // semitones above root
  role: 'root' | 'third' | 'fifth' | 'seventh' | 'sixth' | 'tension';
  letterPc: number;           // natural pc of the spelled letter
  acc: number;                // signed accidental −2..+2
  name: string;               // e.g. "C♯"
}

export interface ParsedChord {
  input: string;              // exactly what was typed (trimmed)
  rootPc: number;
  rootLetterIdx: number;      // 0..6 (C..B)
  rootAcc: number;
  rootName: string;           // e.g. "A♭"
  quality: ChordQuality;
  tones: ChordTone[];         // root, third/sus, fifth, seventh/sixth, tensions
  thirdPc: number | null;     // the 3rd (or the sus tone replacing it)
  fifthPc: number | null;
  seventhPc: number | null;   // 7th or 6th, else null (triad)
  shellPcs: number[];         // the minimum you must play
  allPcs: number[];           // every chord tone (for outside-note detection)
  bassPc: number | null;      // slash-bass pitch class, if any
  label: string;              // pretty display label
}

// Accidental count from a run of #/b (already normalized to ASCII).
function accValue(s: string): number {
  let a = 0;
  for (const c of s) a += c === '#' ? 1 : c === 'b' ? -1 : 0;
  return a;
}

// Parse a bare note token like "A", "Bb", "F#", "Ab" → { letterIdx, acc, pc }.
function parseNote(tok: string): { letterIdx: number; acc: number; pc: number } | null {
  const m = tok.match(/^([A-Ga-g])([#b]{0,2})$/);
  if (!m) return null;
  const letterIdx = LETTER_IDX[m[1].toUpperCase()];
  const acc = accValue(m[2]);
  return { letterIdx, acc, pc: mod(LETTER_PC[letterIdx] + acc, 12) };
}

// Normalize unicode/jazz glyphs to a plain ASCII grammar we can scan.
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/[♭]/g, 'b')
    .replace(/[♯]/g, '#')
    .replace(/[–—]/g, '-')
    .replace(/[Δ∆]/g, 'maj7')      // triangle = major seventh
    .replace(/[øØ]/g, 'm7b5')      // half-diminished
    .replace(/[°º]/g, 'dim');
}

export function parseChord(raw: string): ParsedChord | null {
  if (!raw || !raw.trim()) return null;
  const input = raw.trim();
  let s = normalize(input);

  // Root.
  const rm = s.match(/^([A-Ga-g])([#b]{0,2})/);
  if (!rm) return null;
  const rootLetterIdx = LETTER_IDX[rm[1].toUpperCase()];
  const rootAcc = accValue(rm[2]);
  const rootPc = mod(LETTER_PC[rootLetterIdx] + rootAcc, 12);
  let rest = s.slice(rm[0].length);

  // Slash bass at the very end.
  let bassPc: number | null = null;
  let bassNote: { letterIdx: number; acc: number; pc: number } | null = null;
  const sm = rest.match(/\/([A-Ga-g][#b]{0,2})$/);
  if (sm) {
    bassNote = parseNote(sm[1]);
    bassPc = bassNote ? bassNote.pc : null;
    rest = rest.slice(0, rest.length - sm[0].length);
  }

  // ── Quality core ────────────────────────────────────────────────────
  // third / fifth in semitones; quality label; whether a major-7th was asked
  // for; sus replacement (2 or 4); explicit seventh/sixth.
  let third = 4;            // major third by default
  let fifth = 7;
  let quality: ChordQuality = 'dom';   // a bare root + 7 is dominant; refined below
  let majSeven = false;
  let susReplace: number | null = null;   // 2 → adds 9, 4 → adds 11 (replaces 3rd)
  let isSixth = false;
  let seventh: number | null = null;      // semitone of the 7th, if any
  const tensions: { deg: number; semi: number }[] = [];
  let explicitTriad = false;              // saw a quality word with no 7 ⇒ triad

  // Half-diminished (normalized to m7b5).
  if (/^m7b5/.test(rest)) {
    third = 3; fifth = 6; seventh = 10; quality = 'halfdim';
    rest = rest.replace(/^m7b5/, '');
  } else if (/^(dim|d)/.test(rest) && !/^dom/.test(rest)) {
    third = 3; fifth = 6; quality = 'dim';
    rest = rest.replace(/^(dim|d)/, '');
    if (/^7/.test(rest)) { seventh = 9; rest = rest.replace(/^7/, ''); }   // dim7 = bb7
    else explicitTriad = true;
  } else if (/^(aug|\+)/.test(rest)) {
    fifth = 8; third = 4; quality = 'aug';
    rest = rest.replace(/^(aug|\+)/, '');
    explicitTriad = seventh === null;
  } else if (/^(maj|Maj|MAJ|ma|M)/.test(rest)) {
    // Major-quality marker (major third, and a major 7th if a 7/9/13 follows).
    majSeven = true; third = 4; quality = 'maj';
    rest = rest.replace(/^(maj|Maj|MAJ|ma|M)/, '');
  } else if (/^(min|m|-)/.test(rest)) {
    third = 3; quality = 'min';
    rest = rest.replace(/^(min|m|-)/, '');
  }

  // sus (can follow a quality, e.g. 7sus4). sus alone = sus4.
  const susM = rest.match(/sus([24])?/);
  if (susM) {
    susReplace = susM[1] === '2' ? 2 : 4;
    quality = 'sus';
    rest = rest.replace(/sus([24])?/, '');
  }

  // ── Seventh / sixth / extension number ──────────────────────────────
  // 6/9.
  if (/^6\/?9/.test(rest)) {
    isSixth = true; tensions.push({ deg: 9, semi: 2 });
    rest = rest.replace(/^6\/?9/, '');
  } else if (/^6/.test(rest)) {
    isSixth = true;
    rest = rest.replace(/^6/, '');
  } else {
    const extM = rest.match(/^(7|9|11|13)/);
    if (extM) {
      const top = parseInt(extM[1], 10);
      if (seventh === null) seventh = majSeven ? 11 : 10;
      if (top >= 9) tensions.push({ deg: 9, semi: 2 });
      if (top === 11) tensions.push({ deg: 11, semi: 5 });   // 13 omits the 11 (avoid tone)
      if (top >= 13) tensions.push({ deg: 13, semi: 9 });
      rest = rest.replace(/^(7|9|11|13)/, '');
    } else if (majSeven && !explicitTriad) {
      // "maj"/"M" with nothing after → just a major triad.
      explicitTriad = true;
    }
  }

  // ── Alterations / adds (any order, repeatable) ──────────────────────
  // Apply a named alteration to fifth/tensions.
  const applyAlt = (tok: string) => {
    switch (tok) {
      case 'b5': fifth = 6; break;
      case '#5': fifth = 8; break;
      case 'b9': dropTension(9); tensions.push({ deg: 9, semi: 1 }); break;
      case '#9': dropTension(9); tensions.push({ deg: 9, semi: 3 }); break;
      case '#11': dropTension(11); tensions.push({ deg: 11, semi: 6 }); break;
      case 'b13': dropTension(13); tensions.push({ deg: 13, semi: 8 }); break;
      case 'b6': tensions.push({ deg: 6, semi: 8 }); break;
      case 'add9': dropTension(9); tensions.push({ deg: 9, semi: 2 }); break;
      case 'add11': dropTension(11); tensions.push({ deg: 11, semi: 5 }); break;
      case 'add13': dropTension(13); tensions.push({ deg: 13, semi: 9 }); break;
      case 'alt':
        // altered dominant: ♭9 ♯9 ♯11 ♭13 over a dominant 7.
        if (seventh === null) seventh = 10;
        dropTension(9); dropTension(11); dropTension(13);
        tensions.push({ deg: 9, semi: 1 }, { deg: 9, semi: 3 }, { deg: 11, semi: 6 }, { deg: 13, semi: 8 });
        fifth = 8;
        break;
    }
  };
  function dropTension(deg: number) {
    for (let i = tensions.length - 1; i >= 0; i--) if (tensions[i].deg === deg) tensions.splice(i, 1);
  }
  const altRe = /(add9|add11|add13|b5|#5|b9|#9|#11|b13|b6|alt)/g;
  let am: RegExpExecArray | null;
  while ((am = altRe.exec(rest)) !== null) applyAlt(am[1]);

  // ── Assemble tones ──────────────────────────────────────────────────
  const tones: { deg: number; semi: number; role: ChordTone['role'] }[] = [];
  tones.push({ deg: 1, semi: 0, role: 'root' });
  if (susReplace !== null) {
    tones.push({ deg: susReplace, semi: susReplace === 2 ? 2 : 5, role: 'third' });
  } else {
    tones.push({ deg: 3, semi: third, role: 'third' });
  }
  tones.push({ deg: 5, semi: fifth, role: 'fifth' });
  if (isSixth) tones.push({ deg: 6, semi: 9, role: 'sixth' });
  else if (seventh !== null) tones.push({ deg: 7, semi: seventh, role: 'seventh' });
  for (const t of tensions) tones.push({ deg: t.deg, semi: t.semi, role: 'tension' });

  // Dedupe by pitch class — earlier (structural) tones win over later tensions,
  // so e.g. an altered dominant's ♯5 and ♭13 don't engrave as two noteheads.
  {
    const seen = new Set<number>();
    for (let i = 0; i < tones.length; i++) {
      const p = mod(rootPc + tones[i].semi, 12);
      if (seen.has(p)) { tones.splice(i, 1); i--; } else seen.add(p);
    }
  }

  // Spell every tone by its degree above the root letter.
  const tonePcs = tones.map(t => mod(rootPc + t.semi, 12));
  const degNums = tones.map(t => t.deg);
  const spellMap = spellChordTones(rootLetterIdx, degNums, tonePcs);

  const outTones: ChordTone[] = tones.map((t, i) => {
    const pc = tonePcs[i];
    const sp = spellMap[pc] ?? { letterPc: LETTER_PC[rootLetterIdx], acc: 0 };
    return {
      pc, degree: t.deg, semi: t.semi, role: t.role,
      letterPc: sp.letterPc, acc: sp.acc, name: letterName(sp.letterPc, sp.acc),
    };
  });

  // A bare triad with no seventh defaults to a plain major (a lone "C" is not a
  // dominant). Dominant only sticks when a ♭7 is actually present.
  if (seventh === null && quality === 'dom') quality = 'maj';

  const rootName = letterName(LETTER_PC[rootLetterIdx], rootAcc);
  const thirdTone = outTones.find(t => t.role === 'third');
  const fifthTone = outTones.find(t => t.role === 'fifth');
  const sevTone = outTones.find(t => t.role === 'seventh' || t.role === 'sixth');
  const thirdPc = thirdTone ? thirdTone.pc : null;
  const fifthPc = fifthTone ? fifthTone.pc : null;
  const seventhPc = sevTone ? sevTone.pc : null;

  // Shell voicing: the tones that *define* the chord. With a 7th/6th present,
  // that's 3rd + 7th. A plain triad needs 3rd + 5th. We dedupe in case the
  // chord is small (e.g. a sus with no clear third) and drop nulls.
  const shellSet = new Set<number>();
  if (thirdPc !== null) shellSet.add(thirdPc);
  if (seventhPc !== null) shellSet.add(seventhPc);
  else if (fifthPc !== null) shellSet.add(fifthPc);
  const shellPcs = [...shellSet];

  const allPcs = [...new Set(outTones.map(t => t.pc))];

  return {
    input, rootPc, rootLetterIdx, rootAcc, rootName, quality,
    tones: outTones, thirdPc, fifthPc, seventhPc, shellPcs, allPcs,
    bassPc, label: prettyLabel(input),
  };
}

// Light prettifier for display: unicode accidentals, "-" already reads fine for
// minor in jazz, leave the rest as typed.
function prettyLabel(input: string): string {
  if (!input) return input;
  // Keep the root letter as typed (a lowercase "b" there is the note B, not a
  // flat); swap accidental glyphs everywhere after it. Quality letters stay as
  // written so "Cmaj7", "G7", "Dm7" read the way the user typed them.
  return input[0] + input.slice(1).replace(/b/g, '♭').replace(/#/g, '♯');
}

// Role → semantic label, handy for staff/legend coloring.
export function roleOf(chord: ParsedChord, pc: number): ChordTone['role'] | 'outside' {
  const t = chord.tones.find(x => x.pc === mod(pc, 12));
  return t ? t.role : 'outside';
}

// ── Chord RECOGNITION (the inverse: notes → symbol) ───────────────────
//
// Used for MIDI chord entry. Given the pitch classes you played, find the most
// chord-like interpretation and emit a symbol that parseChord round-trips. When
// you also sound a note in the bottom 2.5 octaves, that note FORCES the root, so
// any inversion or rootless voicing up top still resolves to the chord you mean.

// Bottom 2.5 octaves of an 88-key (A0=21 … E♭3=51). A note here = "this is the root".
export const ROOT_ZONE_MAX = 51;

const ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

interface Described { sym: string; score: number }

// Interpret a set of intervals (relative to `root`) as a chord; return the
// symbol plus a score for how well it hangs together (more structure = higher).
function describe(root: number, iv: Set<number>): Described {
  const has = (i: number) => iv.has(i);
  const third: 'maj' | 'min' | 'sus4' | 'sus2' | null =
    has(4) ? 'maj' : has(3) ? 'min' : has(5) ? 'sus4' : has(2) ? 'sus2' : null;
  const hasP5 = has(7), hasB5 = has(6), hasS5 = has(8);
  const fifthTok = hasP5 ? '' : hasB5 ? 'b5' : hasS5 ? '#5' : '';
  const sev: 'maj7' | 'b7' | '6' | 'dim7' | null =
    has(11) ? 'maj7' : has(10) ? 'b7'
      : has(9) ? ((third === 'min' && hasB5 && !hasP5) ? 'dim7' : '6') : null;

  // Track which intervals are "explained" by the core; the rest are tensions.
  const used = new Set<number>([0]);
  let score = 0;
  if (third) { score += 3; used.add(third === 'maj' ? 4 : third === 'min' ? 3 : third === 'sus4' ? 5 : 2); }
  if (hasP5) { score += 1; used.add(7); } else if (hasB5) used.add(6); else if (hasS5) used.add(8);
  if (sev === 'maj7') { score += 2; used.add(11); }
  else if (sev === 'b7') { score += 2; used.add(10); }
  else if (sev === '6') { score += 1.5; used.add(9); }
  else if (sev === 'dim7') { score += 2; used.add(9); used.add(6); }

  const tens = new Set([...iv].filter(i => !used.has(i)));
  score -= 0.25 * tens.size;

  const name = ROOT_NAMES[root];
  const has9 = tens.has(2);
  const has13 = tens.has(9) && (sev === 'maj7' || sev === 'b7');
  const alt: string[] = [];
  if (tens.has(1)) alt.push('b9');
  if (tens.has(3) && third !== 'min') alt.push('#9');
  if (tens.has(6) && fifthTok !== 'b5') alt.push('#11');
  if (tens.has(8) && fifthTok !== '#5') alt.push('b13');
  const ext = has13 ? '13' : has9 ? '9' : '7';

  let qual = '';
  if (sev === 'dim7') qual = 'dim7';
  else if (third === 'min' && sev === 'b7' && fifthTok === 'b5') qual = 'm7b5';
  else if (third === 'maj' && sev === 'maj7') qual = 'maj' + ext;
  else if (third === 'maj' && sev === 'b7') qual = ext + (fifthTok ? fifthTok : '');
  else if (third === 'min' && sev === 'b7') qual = 'm' + ext;
  else if (third === 'min' && sev === 'maj7') qual = 'mMaj7';
  else if (sev === '6') qual = (third === 'min' ? 'm' : '') + (has9 ? '6/9' : '6');
  else if (!sev) {
    // Triad (or sus / add9).
    if (third === 'sus4') qual = 'sus4';
    else if (third === 'sus2') qual = 'sus2';
    else if (third === 'min' && fifthTok === 'b5') qual = 'dim';
    else if (third === 'maj' && fifthTok === '#5') qual = 'aug';
    else if (third === 'min') qual = 'm' + (has9 ? 'add9' : '');
    else if (third === 'maj') qual = has9 ? 'add9' : '';
    else { qual = ''; score -= 2; }       // no third — weak guess
  }

  // Append alterations the quality string didn't already encode.
  const sym = name + qual + alt.join('');
  return { sym, score };
}

// Notes (pitch classes) → best chord symbol. `forcedRoot` pins the root.
export function recognizeChord(pcsIn: number[], forcedRoot?: number): string | null {
  const pcs = [...new Set(pcsIn.map(p => mod(p, 12)))];
  if (pcs.length === 0) return null;
  const roots = forcedRoot != null ? [mod(forcedRoot, 12)] : pcs.slice();
  let best: Described & { root: number } | null = null;
  for (const root of roots) {
    const iv = new Set(pcs.map(p => mod(p - root, 12)));
    const d = describe(root, iv);
    // Unforced: gently prefer a lower root pc as a tie-breaker (closer to bass).
    const adj = d.score - (forcedRoot != null ? 0 : root * 0.001);
    if (!best || adj > best.score) best = { ...d, score: adj, root };
  }
  return best ? best.sym : null;
}

// MIDI notes → symbol, applying the low-note root rule.
export function recognizeFromMidi(midis: number[]): string | null {
  if (!midis.length) return null;
  const low = midis.filter(m => m <= ROOT_ZONE_MAX);
  const forcedRoot = low.length ? mod(Math.min(...low), 12) : undefined;
  const pcs = [...new Set(midis.map(m => mod(m, 12)))];
  // Need enough information: ≥3 notes for a free guess, or ≥2 with a forced root.
  if (forcedRoot == null && pcs.length < 3) return null;
  if (forcedRoot != null && pcs.length < 2) return null;
  return recognizeChord(pcs, forcedRoot);
}
