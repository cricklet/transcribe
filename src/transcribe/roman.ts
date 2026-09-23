// Chord symbols as roman numerals, measured from the key centre.
//
// Written against the ORIGIN key of the movement, not whatever 1= is in force
// where the chord sits. A modulation moves the numbers on the page; it doesn't
// move the tune's home. Numbering everything from home is what makes "the
// bridge is a bVI" readable at a glance — and it keeps the chords in the same
// coordinate system as the degree numbers under them.
//
// Degree 1 is do, always — including in a piece written 6=. That's the same
// "1" the noteheads show, so a IV chord really does sit over the 4s. It's
// relative-major numbering for a minor tune, which is the trade for having one
// coordinate system instead of two.

import { KeySig } from './types';

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];          // C D E F G A B
const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Where a written root sits in the key: which degree, and how far it is from
// that degree's natural place.
function degreeOf(letter: string, accs: string, key: KeySig): { degree: number; alter: number } | null {
  const li = LETTER_IDX[letter.toUpperCase()];
  if (li == null) return null;
  const alterIn = (accs.match(/#/g)?.length ?? 0) - (accs.match(/b/g)?.length ?? 0);
  const tonicIdx = LETTER_PC.indexOf(key.tonicLetterPc);
  if (tonicIdx < 0) return null;

  const degree = ((li - tonicIdx) % 7 + 7) % 7;                    // 0-based
  const pc = (LETTER_PC[li] + alterIn + 12) % 12;
  let diff = (pc - ((key.tonicPc + MAJOR_STEPS[degree]) % 12) + 12) % 12;
  if (diff > 6) diff -= 12;
  return { degree: degree + 1, alter: diff };
}

function alterMark(n: number): string {
  return n > 0 ? '♯'.repeat(n) : n < 0 ? '♭'.repeat(-n) : '';
}

// Split a symbol into root, quality and bass. Anything that doesn't start with
// a note name (N.C., a stray word) isn't a chord and comes back untouched.
const CHORD_RE = /^([A-Ga-g])([#b♯♭]*)([^/]*)(?:\/([A-Ga-g])([#b♯♭]*))?$/;

export function toRoman(sym: string, key: KeySig): string {
  const m = CHORD_RE.exec(sym.trim());
  if (!m) return sym;
  const norm = (s: string) => s.replace(/♯/g, '#').replace(/♭/g, 'b');
  const root = degreeOf(m[1], norm(m[2]), key);
  if (!root) return sym;

  const { numeral, tail } = spell(m[3] ?? '', root.degree);
  let out = alterMark(root.alter) + numeral + tail;

  // A slash bass reads as the degree it lands on — the same number the
  // noteheads use, so "IV/6" says the bass is on la without a second alphabet.
  if (m[4]) {
    const bass = degreeOf(m[4], norm(m[5] ?? ''), key);
    out += '/' + (bass ? alterMark(bass.alter) + bass.degree : m[4] + (m[5] ?? ''));
  }
  return out;
}

// Berklee style: the numeral is always upper case, and the quality is written
// after it the way it is after a letter — II-7, V7, IM7, VII-7(♭5), VIIo7.
function spell(quality: string, degree: number): { numeral: string; tail: string } {
  let q = quality.trim();
  let minor = '';

  // -7 and m7 are the same chord; maj7 only LOOKS like it starts with minor.
  //
  // CASE MATTERS on the bare letter: `m7` is minor, `M7` is a major seventh,
  // and this app writes major sevenths that way everywhere. Spelt out, either
  // case will do — `min` and `Min` are both minor — but `mi` has to be
  // followed by something that isn't a letter, or `maj` walks straight into it.
  const min = /^(-|[Mm]in|[Mm]i(?![a-z])|m(?!aj))/.exec(q);
  if (min) { minor = '-'; q = q.slice(min[0].length); }

  // Half-diminished, however it was written, is -7(♭5); diminished is o.
  if (/^ø/.test(q)) q = '-7(♭5)' + q.slice(1).replace(/^7/, '');
  else if (minor && /^7[b♭]5/.test(q)) q = '-7(♭5)' + q.slice(4);
  else {
    const dim = /^(dim|°|o(?![m]))/i.exec(q);
    if (dim) q = 'o' + q.slice(dim[0].length);
    else q = minor + q;
  }

  const aug = /^(aug|\+)/i.exec(q);
  if (aug) q = '+' + q.slice(aug[0].length);
  const maj = /^(maj|Maj|MAJ|ma|M)(?=\d|$)/.exec(q);
  if (maj) q = 'M' + q.slice(maj[0].length);

  return { numeral: NUMERALS[degree - 1] ?? String(degree), tail: q };
}

// ── roman numerals written into the source ─────────────────────────────
// A chord can be WRITTEN as its function — II-7, V7/II-, bIII-7, SubV7/II —
// and it's read into the letter chord it names in the key in force where it
// sits, so everything that plays or voices a chord never sees a numeral.
// Berklee conventions: the numeral is upper case and the quality follows it
// (a lower-case numeral is read as minor too, as a courtesy). After a slash:
// another numeral is the chord it leads to (V7/II- is the dominant of II-, and
// they chain: V7/V/V); a number is the bass as a degree (I/3); a letter is
// the bass as a note (I/E). Sub in front is the tritone substitute.

// What may follow a numeral: the end, a non-letter, an upper-case quality
// (Maj), or one of the lower-case quality words — so an ordinary word that
// happens to start with i or v (a "vamp", an "intro") isn't read as one.
const NUMERAL_RE = /^(sub|Sub|SUB)?([b#♭♯]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(?=$|[^a-z]|maj|min|m|o|sus|add|aug|dim|alt)/;

type Root = { letter: number; pc: number };

const mod = (n: number, m: number) => ((n % m) + m) % m;

function accOf(s: string): number {
  return s === '#' || s === '♯' ? 1 : s === 'b' || s === '♭' ? -1 : 0;
}

// The root a numeral names, measured from `frame` (the key's tonic, or the
// chord a secondary leads to).
function rootIn(frame: Root, deg: number, alter: number, sub: boolean): Root {
  let letter = mod(frame.letter + deg - 1, 7);
  let pc = mod(frame.pc + MAJOR_STEPS[deg - 1] + alter, 12);
  // A tritone away, spelt as a diminished fifth: SubV of C is D♭, not C♯.
  if (sub) { letter = mod(letter + 4, 7); pc = mod(pc + 6, 12); }
  return { letter, pc };
}

// Spelt by the letter the degree lands on, EXCEPT where that gives a name nobody reads a
// chart in: F♭, C♭, E♯, B♯ or a double sharp/flat. Those take the everyday
// name for the same pitch (SubV7/♭VI in G is E7, not F♭7), leaning to the
// flat side for a black key the way the rest of a jazz chart does.
const PLAIN = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
function nameOf(r: Root): string {
  let acc = mod(r.pc - LETTER_PC[r.letter], 12);
  if (acc > 6) acc -= 12;
  const letter = 'CDEFGAB'[r.letter];
  const odd = Math.abs(acc) > 1
    || (acc === -1 && (letter === 'F' || letter === 'C'))
    || (acc === 1 && (letter === 'E' || letter === 'B'));
  if (odd) return PLAIN[r.pc];
  return letter + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc));
}

// Where a numeral chain (II-, V/V, bVI) lands, as a root — its quality is
// what it would be as a chord and doesn't move where the chord leading to it
// sits.
function targetOf(text: string, home: Root): Root | null {
  const cut = text.indexOf('/');
  const head = cut < 0 ? text : text.slice(0, cut);
  const frame = cut < 0 ? home : targetOf(text.slice(cut + 1), home);
  if (!frame) return null;
  const m = NUMERAL_RE.exec(head);
  if (!m) return null;
  return rootIn(frame, NUMERALS.indexOf(m[3].toUpperCase()) + 1, accOf(m[2]), !!m[1]);
}

// Whether a word is written as a roman numeral at all.
export function isRoman(sym: string): boolean {
  return NUMERAL_RE.test(sym.trim());
}

// The letter chord a roman numeral names in `key`, or null if the word isn't
// one (or can't be read as one).
export function fromRoman(sym: string, key: KeySig): string | null {
  const text = sym.trim();
  const m = NUMERAL_RE.exec(text);
  if (!m) return null;
  const home: Root = { letter: LETTER_PC.indexOf(key.tonicLetterPc), pc: key.tonicPc };
  if (home.letter < 0) return null;

  let rest = text.slice(m[0].length);
  const cut = rest.indexOf('/');
  const after = cut < 0 ? '' : rest.slice(cut + 1);
  if (cut >= 0) rest = rest.slice(0, cut);

  // After the slash: a numeral is where the chord leads, a number or a letter
  // is its bass.
  let frame = home;
  let bass = '';
  if (after) {
    const deg = /^([b#♭♯]?)([1-7])$/.exec(after);
    if (deg) bass = '/' + nameOf(rootIn(home, Number(deg[2]), accOf(deg[1]), false));
    else if (/^[A-G][#b♯♭]?$/.test(after)) bass = '/' + after.replace('♯', '#').replace('♭', 'b');
    else {
      const t = targetOf(after, home);
      if (!t) return null;
      frame = t;
    }
  }

  const root = rootIn(frame, NUMERALS.indexOf(m[3].toUpperCase()) + 1, accOf(m[2]), !!m[1]);
  // A lower-case numeral is minor unless the quality already says otherwise;
  // o is diminished, which the chord reader spells dim.
  let q = rest;
  const lower = m[3] === m[3].toLowerCase();
  if (lower && !/^(-|m(?!aj)|min|ø|o|°|dim)/i.test(q)) q = '-' + q;
  q = q.replace(/^(o|°)/, 'dim');
  return nameOf(root) + q + bass;
}

// A chart's letter chords rewritten as plain numerals for the SOURCE: the
// same analysis toRoman draws, in characters you'd type (bIII-7, -7(b5)).
// Null for a word that isn't a chord it can read (N.C., a stray word).
// A slash bass stays a letter (V7/A): a number there would read as one more
// function in a chain of them.
export function romanWord(sym: string, key: KeySig): string | null {
  const cut = sym.indexOf('/');
  const head = cut < 0 ? sym : sym.slice(0, cut);
  const out = toRoman(head, key);
  if (out === head) return null;
  return out.replace(/♭/g, 'b').replace(/♯/g, '#') + (cut < 0 ? '' : sym.slice(cut));
}

// A written numeral as it should be drawn: flats and sharps as the real signs.
export function prettyRoman(sym: string): string {
  return sym
    .replace(/(^|\/|sub)b(?=[IViv])/gi, '$1♭').replace(/(^|\/|sub)#(?=[IViv])/gi, '$1♯')
    .replace(/^sub/i, 'Sub')
    .replace(/\(([^)]*)\)/g, p => p.replace(/b/g, '♭').replace(/#/g, '♯'));
}
