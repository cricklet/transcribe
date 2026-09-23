// The metric-tree engraving rule, shared by every app here that draws ABC.
//
// One place, because rhythm-library, rhythm-trainer, comping-library and the
// jianpu transcriber must all break a held note the same way or the same
// rhythm reads differently from page to page. See CLAUDE.md: imagine a barline
// through the CENTRE of each bar — a note crossing that midpoint is written as
// two tied notes — with the conventional single-notehead syncopations
// exempted, and rests never exempted.
//
// Everything works in abstract "steps"; the caller decides what a step is
// (rhythm-library uses grid cells, the jianpu app uses ticks of 1/128).

// A half-open [start, end) piece of a bar, in steps. One notehead, unless
// abcDurTokens has to break it further into tied note values.
export type Piece = [number, number];

// Break a step-length into clean note values (each a power of two, or a
// dotted or double-dotted value), largest first, so every ABC token maps to
// one notehead.
export function abcDurTokens(stepsLen: number): number[] {
  const out: number[] = [];
  let L = stepsLen, guard = 0;
  while (L > 0 && guard++ < 64) {
    let p = 1;
    while (p * 2 <= L) p *= 2;
    // A double-dotted value is one notehead, but only when it is EXACTLY what
    // is left — never as a greedy first bite out of some other length. The
    // point is to write a double-dotted note as the note it is; every other
    // length ties the way it always did.
    if (p >= 4 && L === p + p / 2 + p / 4) { out.push(L); L = 0; }
    else if (p >= 2 && L >= p + p / 2) { out.push(p + p / 2); L -= p + p / 2; }  // dotted
    else { out.push(p); L -= p; }
  }
  return out;
}

// Beat groupings per meter (group sizes in beats): 4/4 -> [2,2] (strong
// mid-bar), 6/8 -> [3,3] (compound), 7/8 -> [2,2,3], 3/4 -> [1,1,1], etc.
export function beatGroups(bn: number, den: number): number[] {
  if (den >= 8) {
    if (bn % 3 === 0) return Array(bn / 3).fill(3);
    // Irregular (5/8, 7/8, …): lead with a group of 3 eighths so a dotted
    // quarter is one note at the start of the bar, then groups of 2.
    const out: number[] = []; let r = bn;
    if (r % 2 === 1) { out.push(3); r -= 3; }
    while (r > 0) { out.push(2); r -= 2; }
    return out;
  }
  if (bn === 4) return [2, 2];
  if (bn === 6) return [3, 3];
  if (bn % 2 === 0 && bn > 4) return [bn / 2, bn / 2];
  return Array(bn).fill(1);
}

// Recursively split [a,b) within a metric node spanning `beats` beats
// (compound = a ternary group). A note is one notehead if it fills a node,
// or is a dotted value (node + half its sibling); otherwise it's split at
// the strongest boundary it crosses (the caller ties the pieces).
// [lo, hi, beats, compound] — one child node of the metric tree.
type Kid = [number, number, number, boolean];

export function metricPieces(
  a: number, b: number, lo: number, hi: number,
  beats: number, compound: boolean, isNote: boolean,
): Piece[] {
  if (b <= a) return [];
  if (a === lo && b === hi) return [[a, b]];
  let kids: Kid[];
  if (compound) {
    kids = []; const w = (hi - lo) / beats;
    for (let i = 0; i < beats; i++) kids.push([lo + i * w, lo + (i + 1) * w, 1, false]);
  } else if (beats >= 2) {
    if (beats % 2 === 0) { const h = (lo + hi) / 2; kids = [[lo, h, beats / 2, false], [h, hi, beats / 2, false]]; }
    else { kids = []; const w = (hi - lo) / beats; for (let i = 0; i < beats; i++) kids.push([lo + i * w, lo + (i + 1) * w, 1, false]); }
  } else {
    if (hi - lo <= 1) return [[a, b]];
    const h = (lo + hi) / 2; kids = [[lo, h, 1, false], [h, hi, 1, false]];
  }
  for (const [cl, ch, cb, cc] of kids) if (a >= cl && b <= ch) return metricPieces(a, b, cl, ch, cb, cc, isNote);
  // Single-notehead exceptions across one child boundary:
  //   forward dotted   (any level): child start .. midpoint of next child
  //                                 (= 1.5 child widths, dotted on the beat)
  //   backward dotted  (any level): midpoint of a child .. end of next child
  //                                 (e.g. dotted-quarter ending on a beat,
  //                                 also sixteenth + dotted-eighth at sub-beat)
  //   off-beat single  (any level): midpoint of one child .. midpoint of next
  //                                 (= 1 child width offset by half, e.g. a
  //                                 quarter on the AND of a beat or a half on
  //                                 beat 2)
  // All three are conventional engravings of syncopation; the user opted in
  // to them explicitly. Compound (ternary) groups stay split as before.
  // NOTES only: a rest is never engraved as a syncopated value — silence
  // must expose the metric structure, so rests split at every boundary.
  if (!compound && isNote) {
    for (let i = 0; i + 1 < kids.length; i++) {
      const cl = kids[i][0], ch = kids[i][1], nl = kids[i + 1][0], nh = kids[i + 1][1];
      if (a === cl && b === (nl + nh) / 2) return [[a, b]];
      if (a === (cl + ch) / 2 && b === nh) return [[a, b]];
      if (a === (cl + ch) / 2 && b === (nl + nh) / 2) return [[a, b]];
    }
  }
  let res: Piece[] = [];
  for (const [cl, ch, cb, cc] of kids) { const s = Math.max(a, cl), e = Math.min(b, ch); if (e > s) res = res.concat(metricPieces(s, e, cl, ch, cb, cc, isNote)); }
  return res;
}

// Split a note/rest [a,b) (bar-local steps) into single-notehead pieces by
// the bar's metric tree.
export function splitInBar(
  a: number, b: number, bn: number, den: number, spb: number, isNote: boolean,
): Piece[] {
  const groups = beatGroups(bn, den);
  const kids: Kid[] = []; let p = 0;
  for (const g of groups) { kids.push([p * spb, (p + g) * spb, g, (den >= 8 && g === 3)]); p += g; }
  const barHi = bn * spb;
  if (a === 0 && b === barHi) return [[a, b]];
  // 4/4: the ONLY metric split point is the bar's centre (between beats 2 & 3).
  // Each half-bar is a leaf, so a note is never broken between beats 1&2 or
  // 3&4 — it stays a single notehead (subject to note-value tokenisation). A
  // note crossing the centre is split there, except the dotted / off-beat
  // figures that conventionally span the centre as one notehead — notes
  // only; a rest crossing the centre always splits there.
  if (bn === 4 && den === 4) {
    const mid = barHi / 2;
    if (a >= mid || b <= mid) return [[a, b]];                  // stays in one half
    if (isNote) {
      if (a === 0 && b === mid + spb) return [[a, b]];          // dotted half on beat 1
      if (a === mid - spb && b === barHi) return [[a, b]];      // dotted half, beats 2–4
      if (a === mid - spb && b === mid + spb) return [[a, b]];  // half note on beat 2
    }
    return [[a, mid], [mid, b]];                                // else split at the centre
  }
  for (const [cl, ch, cb, cc] of kids) if (a >= cl && b <= ch) return metricPieces(a, b, cl, ch, cb, cc, isNote);
  // Same single-notehead exceptions as metricPieces, applied across the
  // bar's top-level beat groups. This catches things like a dotted half
  // starting on beat 2 in 4/4 (midpoint of group[0] .. end of group[1])
  // or a half on beat 2 (midpoint .. midpoint). Notes only, as above.
  if (isNote) {
    for (let i = 0; i + 1 < kids.length; i++) {
      const [cl, ch, , cc0] = kids[i];
      const [nl, nh, , cc1] = kids[i + 1];
      if (cc0 || cc1) continue;          // compound group: keep split
      if (a === cl && b === (nl + nh) / 2) return [[a, b]];          // forward dotted
      if (a === (cl + ch) / 2 && b === nh) return [[a, b]];          // backward dotted
      if (a === (cl + ch) / 2 && b === (nl + nh) / 2) return [[a, b]]; // off-beat single
    }
  }
  let res: Piece[] = [];
  for (const [cl, ch, cb, cc] of kids) { const s = Math.max(a, cl), e = Math.min(b, ch); if (e > s) res = res.concat(metricPieces(s, e, cl, ch, cb, cc, isNote)); }
  return res;
}
