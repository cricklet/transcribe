// How a chord symbol is SET on the page — the typesetting half of drawing
// chords ourselves (staff.tsx drawChords places the result). Real Book style:
// the root big, and everything that qualifies it in one small run sitting on
// the same baseline —
//
//   root / numeral      E  B♭  ♭VII      full size
//   its accidental      B♭  ♭III         smaller and raised — a flat set as
//                                        big as the letter reads as a b
//   the rest            E 7♭13  C -7♭5   ONE small run on the baseline:
//                       B♭ M7  G 7sus4   quality, extension and alterations
//                                        together, real ♭/♯ glyphs,
//                                        parentheses dropped, and the Real
//                                        Book's symbols for the quality:
//                                        Δ major, - minor, o diminished,
//                                        ø half-diminished (C-7♭5 is Cø7)
//   slash bass          C/E              a step down, on the baseline
//   target              V7/II-           where a numeral leads: the same rules
//                                        applied to it, a size down
//
// Only the root (and its accidental) is `strong` — set at the chord face's
// weight; everything that qualifies it is set regular, so the root carries
// the symbol and the rest reads as detail on it.
//
// A bracketed run ([II-7 | V7] / VI-) is drawn as one group: a tall square
// bracket before its first chord and after its last, the target said once
// after the ]. The brackets aren't type — a [ glyph is only as tall as the
// letters — so a run here is a `bracket`: an en space holding the room, over
// which staff.tsx draws the bracket itself, taller than the symbol and
// centred on it.
//
// Sizes and rises are fractions of the symbol's own font size.

import type { ChordShow } from './abc';

// `gap` is extra space in front of the run, as a fraction of the font size.
export type Run = { text: string; size: number; rise: number; gap?: number; strong?: boolean; bracket?: 'open' | 'close' };

const ACC = { size: 0.72, rise: 0.36 };
const REST = 0.68;
const BASS = 0.8;
const TARGET = 0.66;
// Air before a target's slash, so V7/II reads as a chord and where it leads
// rather than one long word.
const TARGET_GAP = 0.2;
// …and it steps down: the slash a little below the baseline, where it leads
// a little further — so the eye reads the chord first and the target as
// hanging off it.
const SLASH_DROP = 0.1;
const TARGET_DROP = 0.3;
// The slash itself at the root's size, and a little air between it and
// where it leads.
const SLASH = 1;
const AFTER_SLASH = 0.1;

const glyph = (s: string) => s.replace(/b/g, '♭').replace(/#/g, '♯');

// A letter chord's root, or a numeral with the accidental (and Sub) in front.
const LETTER_ROOT = /^([A-G])([#b♯♭]{0,2})/;
const NUMERAL_ROOT = /^(Sub)?([#b♯♭]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/;
const QUALITY = /^(maj|Maj|MAJ|ma|Δ|∆|min|mi|m(?!aj)|-|dim|°|o|ø|aug|\+|M(?=\d|$))/;
const EXTENSION = /^(6\/9|69|13|11|9|7|6|5)/;
// One alteration or added word, with any accidental in front of its number.
const ALTERATION = /^([#b♯♭]?(?:5|9|11|13)|alt|sus[24]?|add\s?\d+|omit\s?\d+|no\s?\d+)/;

export function chordRuns(show: ChordShow): Run[] {
  const out: Run[] = [];
  if (show.open) out.push({ text: '\u2002', size: 1, rise: 0, bracket: 'open' });
  out.push(...setMain(show.main, 1, true));
  // Where it leads: a size down after a slash, set by the same rules. A
  // chain of targets (V7/II/V) keeps its slashes.
  const target = (text: string) => {
    out.push({ text: '/', size: SLASH, rise: -SLASH_DROP, gap: TARGET_GAP });
    text.split('/').forEach((part, i) => {
      if (i) out.push({ text: '/', size: SLASH, rise: -SLASH_DROP, gap: AFTER_SLASH });
      // Small but set at the face's weight throughout, so it holds its own
      // beside the chord at that size.
      setMain(part, TARGET, false).forEach((r, k) =>
        out.push({ ...r, rise: r.rise - TARGET_DROP, gap: k ? r.gap : AFTER_SLASH, strong: true }));
    });
  };
  if (show.target) target(show.target);
  if (show.close) out.push({ text: '\u2002', size: 1, rise: 0, bracket: 'close' });
  if (show.lead) target(show.lead);
  return merge(out);
}

// One symbol — letter or numeral — at `scale` of the full size.
function setMain(text: string, scale: number, strongRoot: boolean): Run[] {
  const out: Run[] = [];
  const at = (t: string, size: number, rise = 0, strong = false) => {
    if (t) out.push({ text: t, size: size * scale, rise: rise * scale, strong: strong && strongRoot });
  };

  let rest = text;
  const num = NUMERAL_ROOT.exec(rest);
  const let_ = num ? null : LETTER_ROOT.exec(rest);
  if (num) {
    at(num[1] ?? '', 0.8);                       // Sub, a touch smaller
    at(glyph(num[2]), ACC.size, ACC.rise, true);
    at(num[3], 1, 0, true);
    rest = rest.slice(num[0].length);
  } else if (let_) {
    at(let_[1], 1, 0, true);
    at(glyph(let_[2]), ACC.size, ACC.rise, true);
    rest = rest.slice(let_[0].length);
  } else {
    // Not a chord we can read (N.C., a word) — set as it is.
    at(text, 1, 0, true);
    return out;
  }

  // A slash bass belongs to a letter chord: split it off before reading the
  // quality, so C-7/Bb isn't read as an alteration.
  let bass = '';
  const cut = rest.search(/\/(?=[A-G])/);
  if (cut >= 0) { bass = rest.slice(cut + 1); rest = rest.slice(0, cut); }

  // Quality, extension and alterations: read one by one, set as one run.
  let tail = '';
  const q = QUALITY.exec(rest);
  let qual = '';
  if (q) {
    const w = q[0];
    qual = /^(maj|Maj|MAJ|ma|M|Δ|∆)$/.test(w) ? 'Δ'
      : /^(min|mi|m|-)$/.test(w) ? '-'
      : /^(dim|°|o)$/.test(w) ? 'o'
      : w;
    rest = rest.slice(w.length);
  }
  const e = EXTENSION.exec(rest);
  if (e) rest = rest.slice(e[0].length);
  // Minor seventh with a flat five is half-diminished, and says so.
  if (qual === '-' && e?.[0] === '7') {
    const b5 = /^\s*\(?\s*[b♭]5\s*\)?/.exec(rest);
    if (b5) { qual = 'ø'; rest = rest.slice(b5[0].length); }
  }
  tail = qual + (e ? e[0] : '');
  // Parentheses and commas dropped; anything unreadable kept as it was.
  while (rest) {
    const trimmed = rest.replace(/^[\s(),]+/, '');
    if (trimmed !== rest) { rest = trimmed; continue; }
    const a = ALTERATION.exec(rest);
    const word = a ? glyph(a[0].replace(/\s/g, '')) : (/^[^\s(),]+/.exec(rest)?.[0] ?? rest);
    // Two alterations side by side (♯9 ♭13) keep a hair of space between.
    if (tail && /^[♭♯]?\d/.test(word) && /\d$/.test(tail) && !e?.[0].endsWith(tail.slice(-1))) tail += '\u2009';
    tail += word;
    rest = rest.slice((a ? a[0] : word).length);
  }
  at(tail, REST);

  if (bass) {
    at('/', BASS);
    const b = LETTER_ROOT.exec(bass);
    if (b) { at(b[1], BASS); at(glyph(b[2]), ACC.size * BASS, ACC.rise * BASS); at(bass.slice(b[0].length), REST); }
    else at(bass, BASS);
  }
  return out;
}

// Neighbouring runs set the same way become one — fewer tspans, and no
// kerning break inside what reads as one word.
function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && !last.bracket && !r.bracket && last.size === r.size && last.rise === r.rise && !!last.strong === !!r.strong && !r.gap) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}
