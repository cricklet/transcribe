// Engraved notation via abcjs (loaded from CDN by jianpu.html) — the same
// renderer the melodic trainer, comping library and rhythm trainer use.
//
// Unlike melodic-trainer/staff.tsx this one engraves a whole multi-line score
// that has to reflow with the pane, so it measures its container and re-renders
// on resize rather than taking a fixed staffwidth.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ChordMark, UnderStaff, splitSystems, systemBars, voiceStarts } from './abc';
import { chordRuns } from './chord-type';
import { Span } from './types';

declare global {
  interface Window {
    ABCJS?: any;
  }
}

type Props = {
  abc: string;
  scale?: number;
  // Let abcjs re-flow the score. Turn it OFF when the source sets its own
  // line breaks — `wrap` ignores newlines in the ABC body entirely.
  wrap?: boolean;
  // How many bars a re-flowed system aims for. Four reads well at pane width;
  // a phone wants two, so the noteheads don't shrink to nothing.
  perLine?: number;
  // Whether a system too wide for the pane may be broken in half and stepped —
  // see the STEP block below. On everywhere there's width to give; off on a
  // phone, where there's none to spare.
  mayStep?: boolean;
  // Where each engraved notehead came from in the source, in abcjs's own
  // element order (see BuildResult.noteSpans). Given these, the staff becomes
  // a map back into the text: hover reports the span under the pointer, click
  // asks for the caret to go there.
  spans?: (Span | null)[];
  // Numbers view: draw the jianpu degree in place of each notehead, and let
  // the CSS take the staff lines, clef and key signature away. One entry per
  // engraved note, same order as `spans`; a chord carries one number per
  // notehead, low to high.
  numbers?: boolean;
  labels?: (string[] | null)[];
  // The same map back to the source for each staff written UNDER the music,
  // in engraved order. Each is a separate VOICE and so comes back from abcjs
  // interleaved with the music's own elements; `from` is the character in the
  // ABC where that voice starts, and every element carries the offset it was
  // written at, so the offsets in order tell the staves apart. Empty when the
  // score is one staff.
  unders?: UnderStaff[];
  // The chord symbols the engraving draws, in abcjs's own order (see
  // BuildResult.chordMarks). Given these, the symbols become live too: the one
  // under the pointer reports itself, and a click sounds the harmony.
  chordMarks?: ChordMark[];
  // The bookmark numbers to write over the music, by the source offset of the
  // note each one belongs to (see markCues in abc.ts). They are DRAWN rather
  // than engraved — nothing about them is in the ABC — so that a marked score
  // lays out exactly like an unmarked one.
  cues?: Map<number, number[]>;
  // The run of source the CARET is in — the note it's on, or the one it just
  // came after. Lit on the staff, so writing in the source says where you are
  // in the music without looking up. Null when the caret is nowhere near a
  // note, or when this score isn't the one holding it.
  caret?: Span | null;
  onHover?: (span: Span | null) => void;
  onPick?: (span: Span) => void;
  // Click on a chord symbol rather than on a notehead.
  onChord?: (mark: ChordMark) => void;
  // Double-click: play from the note that was hit.
  onPlayFrom?: (span: Span) => void;
};

// A notehead's box, in coordinates relative to the host element, so the cache
// survives scrolling the pane. `el` is the group abcjs drew it as — kept so the
// caret can light one up, which is a class on the ink rather than a rectangle.
type Hit = { l: number; t: number; r: number; b: number; span: Span; el: SVGGraphicsElement };

// The same for a chord symbol, which carries a harmony rather than a note.
type ChordHit = { l: number; t: number; r: number; b: number; mark: ChordMark };

// How far outside a chord symbol's own box the pointer still counts as being
// on it. A symbol is small text with air around it, so a little slack makes it
// clickable without swallowing the staff underneath: unlike a notehead, this
// one is CONTAINMENT rather than nearest-wins, so anywhere else on the score
// still finds the note it's over.
const CHORD_SLOP = 4;

function inChord(hits: ChordHit[], x: number, y: number): ChordHit | null {
  for (const h of hits) {
    if (x >= h.l - CHORD_SLOP && x <= h.r + CHORD_SLOP
      && y >= h.t - CHORD_SLOP && y <= h.b + CHORD_SLOP) return h;
  }
  return null;
}

// How far off a notehead the pointer may be and still count as being on it.
// Vertical distance is weighted heavily so a click between two systems doesn't
// grab the wrong line — horizontally, the nearest note in the bar is almost
// always the one meant.
const HIT_V_WEIGHT = 2.6;
const HIT_LIMIT = 90;

function nearest(hits: Hit[], x: number, y: number): Hit | null {
  let best: Hit | null = null;
  let bestScore = Infinity;
  for (const h of hits) {
    const dx = Math.max(0, h.l - x, x - h.r);
    const dy = Math.max(0, h.t - y, y - h.b);
    const score = dx + dy * HIT_V_WEIGHT;
    if (score < bestScore) { bestScore = score; best = h; }
  }
  return bestScore <= HIT_LIMIT ? best : null;
}

// How close a chord's baseline may sit to the top staff line, and how much
// clearance to leave under it if a notehead or ledger line is in the way.
const CHORD_GAP = 13;
const CHORD_PAD = 10;
// How far to either side of a symbol its own column reaches. Ink outside every
// column doesn't hold the row up: a high note in bar 3 has nothing to do with
// where the symbol over bar 1 sits.
const CHORD_COL = 5;

// The numbers view wants more air under a chord: a digit is taller than the
// notehead it replaced and reads as text, so a symbol sitting the engraver's
// distance above it looks stuck to it.
//
// The row is SET to where it belongs rather than merely tightened towards it —
// it may move up as well as down. abcjs parks the row clear of the tallest
// thing in the system, which for one ledger-line note leaves every symbol on
// the line floating; the row wants to be exactly as far up as its own columns
// make it, and no further. What that costs in room over the row, spaceSystems
// below pays back.
export type ChordFit = { gap?: number; pad?: number };

// Bar numbers: only where a system starts — abcjs also numbers the first bar
// after every line break in the ABC, which lands mid-system (into the chord
// row) whenever the layout has joined two source lines — and lifted a little
// clear of the clef. Drawn by us, like the chords: abcjs's own is hidden and
// a plain text of ours takes its place, so its face and weight are the
// stylesheet's and nothing abcjs writes onto its text can thicken it.
function placeBarNumbers(svg: SVGSVGElement) {
  const nums = Array.from(svg.querySelectorAll<SVGTextElement>('text.abcjs-bar-number'));
  if (!nums.length) return;
  const starts = Array.from(svg.querySelectorAll('.abcjs-staff-wrapper'))
    .map(w => safeBox(w)?.x)
    .filter((x): x is number => x != null);
  const left = starts.length ? Math.min(...starts) : 0;
  for (const n of nums) {
    const x = parseFloat(n.getAttribute('x') || '');
    if (Number.isNaN(x) || x > left + 40) { n.setAttribute('visibility', 'hidden'); continue; }
    const y = parseFloat(n.getAttribute('y') || '');
    n.setAttribute('visibility', 'hidden');
    if (Number.isNaN(y)) continue;
    const mine = document.createElementNS(SVG_NS, 'text');
    mine.setAttribute('class', 'jp-barnum');
    mine.setAttribute('x', String(x));
    mine.setAttribute('y', String(y - 10));
    mine.setAttribute('text-anchor', n.getAttribute('text-anchor') || 'middle');
    mine.textContent = n.textContent;
    n.after(mine);
  }
}

// How far a bracketed run's chords sit above the rest of the chord row, as a
// fraction of the chord size.
const RUN_LIFT = 0.5;

// ── the chord symbols, drawn by us ─────────────────────────────────────
// abcjs is handed each symbol as plain text, and that's all its text is for:
// it spaces the bars so the symbols fit and leaves room over the staff. The
// text itself is hidden (not removed — everything that measures the chord
// row still finds it where it was) and each symbol is drawn over it from its
// ChordShow, so how a chord LOOKS is ours: the function at full size, where
// it leads a step smaller after a slash.
function drawChords(host: HTMLElement, marks: ChordMark[]): SVGTextElement[] | null {
  const texts = Array.from(host.querySelectorAll<SVGTextElement>('text.abcjs-chord'));
  if (texts.length !== marks.length) return null;
  const out: SVGTextElement[] = [];
  texts.forEach((t, i) => {
    const show = marks[i].show;
    const mine = t.cloneNode(true) as SVGTextElement;
    mine.setAttribute('class', 'jp-chord');
    mine.removeAttribute('font-family');
    mine.removeAttribute('font-weight');
    // A symbol split over lines keeps its tspans; the words go in the last.
    const lines = mine.querySelectorAll('tspan');
    const leaf: Element = lines.length ? lines[lines.length - 1] : mine;
    leaf.textContent = '';
    t.setAttribute('visibility', 'hidden');
    t.after(mine);
    // Set run by run (chord-type.ts). Sizes are absolute, from the symbol's
    // own size, so a raised run's offset means the same thing whatever size
    // the run itself is set at; each run's dy is the change from the last.
    const base = parseFloat(getComputedStyle(t).fontSize) || 12;
    let rise = 0;
    const brackets: { span: SVGTSpanElement; side: 'open' | 'close' }[] = [];
    for (const run of chordRuns(show)) {
      const span = document.createElementNS(SVG_NS, 'tspan');
      span.setAttribute('font-size', `${(run.size * base).toFixed(2)}px`);
      if (run.rise !== rise) span.setAttribute('dy', `${((rise - run.rise) * base).toFixed(2)}`);
      if (run.gap) span.setAttribute('dx', `${(run.gap * base).toFixed(2)}`);
      // The root takes the face's weight from the stylesheet; the rest is
      // set regular (chord-type.ts).
      if (!run.strong) span.setAttribute('font-weight', '400');
      rise = run.rise;
      span.textContent = run.text;
      leaf.appendChild(span);
      if (run.bracket) brackets.push({ span, side: run.bracket });
    }
    // A bracketed run's chords sit above the row, brackets and all.
    const lift = show.lifted ? RUN_LIFT * base : 0;
    if (lift) {
      const was = mine.getAttribute('transform');
      mine.setAttribute('transform', `translate(0 ${-lift})${was ? ' ' + was : ''}`);
    }
    // The brackets of a bracketed run, over the room their runs held: taller
    // than the symbol by the same amount above and below, so the chords sit
    // centred between them.
    // Measured off the baseline rather than the symbol's box, which a
    // lowered target stretches: every bracket the same height, centred on
    // the letters (baseline to cap height, about 0.72 of the size).
    if (brackets.length) {
      const foot = 0.24 * base;
      for (const b of brackets) {
        const p0 = b.span.getStartPositionOfChar(0);
        const mid = p0.y - 0.36 * base;
        const top = mid - 0.9 * base;
        const bottom = mid + 0.9 * base;
        const at = p0.x;
        const w = b.span.getComputedTextLength();
        const x = b.side === 'open' ? at + w * 0.3 : at + w * 0.7;
        const f = b.side === 'open' ? foot : -foot;
        const line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('class', 'jp-chord-bracket');
        line.setAttribute('points', `${x + f},${top - lift} ${x},${top - lift} ${x},${bottom - lift} ${x + f},${bottom - lift}`);
        mine.after(line);
      }
    }
    out.push(mine);
  });
  return out;
}

export function tightenChords(svg: SVGSVGElement, fit: ChordFit = {}) {
  const gap = fit.gap ?? CHORD_GAP;
  const pad = fit.pad ?? CHORD_PAD;
  const chords = Array.from(svg.querySelectorAll<SVGTextElement>('text.abcjs-chord'));
  if (!chords.length) return;
  const topLines = Array.from(svg.querySelectorAll('.abcjs-top-line'))
    .map(e => safeBox(e)?.y)
    .filter((y): y is number => y != null);
  if (!topLines.length) return;

  // Chords on one system share a baseline, so the baseline groups them.
  const rows = new Map<number, SVGTextElement[]>();
  for (const c of chords) {
    const y = parseFloat(c.getAttribute('y') || '');
    if (Number.isNaN(y)) continue;
    const k = Math.round(y);
    rows.set(k, [...(rows.get(k) ?? []), c]);
  }

  // Measured on the LEAVES — every notehead, stem, ledger line, accidental and
  // annotation — and never on the <g> that holds them. abcjs draws a note and
  // everything hanging off it as one group, its own chord symbol included (see
  // drawAbsolute in abcjs), so that group's box reaches from the top of the
  // symbol right down to the end of the stem. Measure the row against that and
  // the row is standing on itself: it lifts by its own height, every time, and
  // clean off the top of the page on the first system. Staff lines and
  // barlines land in here too and cost nothing — they start at the staff,
  // which is as far down as the row was ever going.
  const colliders = Array.from(svg.querySelectorAll('path, text, use, rect'))
    .filter(e => !e.classList.contains('abcjs-chord'))
    .map(e => safeBox(e))
    .filter((b): b is DOMRect => !!b);

  for (const [y0, row] of rows) {
    // The staff this row belongs to is the next top line below it.
    const below = topLines.filter(t => t > y0);
    if (!below.length) continue;
    const staffY = Math.min(...below);

    // What limits the move is the ink IN A SYMBOL'S OWN COLUMN, between the
    // row and that staff. Two things the older reckoning got wrong:
    //
    //  · it measured every collider by its TOP, so a note three ledger lines
    //    up — taller than the gap abcjs left, its top above the chord baseline
    //    — read as another system's ink, constrained nothing, and the row came
    //    down straight through the notehead. What counts is whether the ink
    //    overlaps the band at all: under the top of the row, over the staff.
    //
    //  · it looked across the whole system, so one high note anywhere held the
    //    whole row up in the air. A row is one baseline, but it only has to
    //    clear what a symbol is actually standing over.
    const boxes = row.map(c => safeBox(c)).filter((b): b is DOMRect => !!b);
    if (!boxes.length) continue;
    const rowTop = Math.min(...boxes.map(b => b.y));
    const cols = boxes.map(b => [b.x - CHORD_COL, b.x + b.width + CHORD_COL] as const);
    let ink = staffY;
    for (const b of colliders) {
      if (b.y >= staffY) continue;                // in or under the staff
      if (b.y + b.height <= rowTop) continue;     // wholly above — not in the way
      if (!cols.some(([a, z]) => b.x < z && b.x + b.width > a)) continue;  // another column
      ink = Math.min(ink, b.y);
    }

    const target = Math.min(staffY - gap, ink - pad);
    const dy = target - y0;
    if (Math.abs(dy) > 0.5) for (const c of row) c.setAttribute('y', String(y0 + dy));
  }
}

// How much more room a chord row wants over it than under it before it reads
// as belonging to the staff below rather than to the one above …
const SEAT_RATIO = 1.3;
const SEAT_LEAD = 6;
// … how far a row has to sit off its own staff before the question is even
// worth asking (a tightened row sits about a notehead above the staff and is
// in no doubt whose it is; only a row held up by something in its own column —
// a note on ledger lines — ever gets here) …
const SEAT_FLOOR = 13;
// … and the limits. No margin opens more than this past the widest one the
// engraving came out with, and the page can't grow by more than this in total.
const SEAT_MAX = 40;
const SEAT_MAX_ALL = 120;

// Give every system the same margin over it — the largest any of them turns
// out to need.
//
// abcjs separates systems by a constant measured between their ink, and a row
// of chord symbols IS the top of its system's ink. So the room over a row is
// the same everywhere while the room under it grows with the music — a note up
// on ledger lines, a row of numbers — and past a point the symbols are nearer
// the staff above than their own. A chord read over the wrong line is the
// wrong changes over the wrong bar.
//
// The fix is a margin, and a margin that varies system by system is its own
// kind of wrong: the page reads as though the gaps mean something. So every
// system is measured, the widest requirement wins, and that one margin is set
// everywhere. Systems only ever move DOWN — the winning margin is at least as
// wide as the widest the engraving already had — so nothing gets tighter than
// abcjs drew it.
//
// (Between SYSTEMS. The staves within one — an X: or B: line under the tune —
// are spaced by abcjs, and a whole system moves as a piece.)
export function spaceSystems(svg: SVGSVGElement) {
  const lines = Array.from(svg.querySelectorAll<SVGGElement>('g.abcjs-staff-wrapper'));
  if (lines.length < 2) return;
  const boxes = lines.map(l => safeBox(l));
  if (boxes.some(b => !b || b.height <= 0)) return;
  const box = boxes as DOMRect[];

  // What each system came out with over it, and what it actually wants. The
  // page's own top edge stands in for the system before the first one, which
  // has no staff to be confused with but does have an edge to be cut off by.
  // That edge is 0: abcjs draws in plain pixels from the top-left down, with no
  // viewBox to offset them (see fitPage), so where the first system's ink
  // starts IS the room it was already given.
  const pageTop = 0;
  const had: number[] = [];
  const want: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const above = i ? box[i - 1].y + box[i - 1].height : pageTop;
    had.push(box[i].y - above);
    want.push(chordRoom(lines[i], box[i]));
  }

  // One margin for the lot: the usual one the engraving came out with, or the
  // widest anything on it needs, whichever is more — and never wildly past the
  // usual one, in case a measurement has gone strange.
  //
  // The USUAL one, not the widest. A blank line in the source is engraved as a
  // %%vskip and comes out as a deliberately wide join; measuring off the widest
  // would open every other join to match it and lose the very distinction the
  // blank line was drawn for. The median is the join this score actually uses,
  // and since nothing here ever closes a gap, the wide one stays wide.
  const base = median(had.slice(1));
  let gap = Math.min(base + SEAT_MAX, Math.max(base, ...want.slice(1)));
  // …and no more of the page than SEAT_MAX_ALL, spread over the joins there
  // are to open.
  const joins = lines.length - 1;
  const spare = (SEAT_MAX_ALL + had.slice(1).reduce((a, b) => a + b, 0)) / joins;
  gap = Math.min(gap, spare);

  // The first system answers to the page top: it can't be given a margin by
  // anything above it, so it takes only what it needs not to be clipped.
  let shift = Math.max(0, want[0] - had[0]);
  for (let i = 0; i < lines.length; i++) {
    if (i) shift += Math.max(0, gap - had[i]);
    if (shift <= 0.5) continue;
    // Prepended, so a step applied later reads as "…and then move it across".
    const was = lines[i].getAttribute('transform');
    lines[i].setAttribute('transform', `translate(0 ${shift.toFixed(2)})${was ? ` ${was}` : ''}`);
  }
  // Nothing grows the page here. Moving systems is only half of what happens
  // to this engraving — the stepped layout and the jianpu numbers come after —
  // so the page is measured off its ink once at the end instead, by fitPage.
}

// The room one system wants over it, measured from the top of its own ink: how
// far its chord row has to be from whatever is above so that it plainly
// belongs to the staff under it. Nothing, for a system with no chords or one
// whose row already sits close to its staff.
function chordRoom(line: SVGGElement, box: DOMRect): number {
  const chords = Array.from(line.querySelectorAll<SVGTextElement>('text.abcjs-chord'))
    .map(c => safeBox(c))
    .filter((b): b is DOMRect => !!b);
  const staff = safeBox(line.querySelector('.abcjs-top-line') ?? line);
  if (!chords.length || !staff) return 0;
  const rowTop = Math.min(...chords.map(b => b.y));
  const rowBottom = Math.max(...chords.map(b => b.y + b.height));
  const under = staff.y - rowBottom;
  if (under <= SEAT_FLOOR) return 0;
  // Wanted over the ROW; asked for over the system, which is the same thing
  // unless something on the line pokes up past the symbols.
  return Math.max(under * SEAT_RATIO, under + SEAT_LEAD) - (rowTop - box.y);
}

// ── the stepped layout ───────────────────────────────────────────────
// A system whose notes came out crowded is cut into rows — as few as the
// crowding actually calls for, never fewer than MIN_STEP_BARS bars each — and
// they're stepped across the page:
//
//   |𝄞===|====|
//     |====|====|
//
// The step is a tab the width of the clef the continuation ISN'T repeating —
// enough to say "this is the same line carrying on", and no more. Only the
// START moves: both halves finish at the same right edge, so the page keeps
// one straight margin and the step reads as an indent rather than a drift.
//
// "Came out crowded" is measured, not guessed: the score is engraved once as
// written, the gaps between its noteheads are read off the SVG, and only then
// is anything cut. That's the one honest way to ask the question — a bar count
// can't tell four bars of whole notes from four of semiquavers, and even a
// note count can't tell how the engraver chose to spread them.

// Fewest bars a cut row may hold. A row with a single bar in it reads as a
// fragment rather than as the line carrying on, so it's the floor on cutting
// however tight a system came out — what cutting can't fix, width does.
const MIN_STEP_BARS = 2;

// A system is crowded when its TYPICAL note-to-note gap is under this many
// noteheads wide. Measured in noteheads rather than pixels so it means the
// same thing at any scale, and typical (the median) rather than tightest, so
// one tight triplet doesn't condemn an otherwise airy line.
//
// This is the dial on how eager the whole thing is: everything below only
// decides what to DO about a crowded line, and this decides how many lines are
// called crowded in the first place. Set low deliberately — a line has to be
// genuinely packed before the layout starts rearranging what you wrote, and a
// merely brisk one is left as one line.
const CROWD_GAP = 2;

// Fewest note-to-note gaps a system needs before "crowded" means anything.
const MIN_GAPS = 4;

// Fallback tab, for the score with no head-of-line furniture to measure.
const STEP_TAB = 36;

// Furthest the engraving may be drawn past the pane for a line that's still
// crowded after everything else — a phone, or a hand-broken system of a dozen
// bars. Past this the sideways scroll costs more than the room is worth.
const MAX_WIDEN = 2;

// What the first engraving says about itself. `tight` is one number per
// system: how many times too close its notes came out, so 1 is exactly at the
// limit and 2 is half the room it wanted. `tab` is where the music starts on
// the opening system — past the clef, the key signature and the metre — which
// is the line a stepped system is indented to.
type Look = { tight: number[]; tab: number };

function measure(host: HTMLElement): Look {
  const tight: number[] = [];
  let tab = 0;
  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    for (const line of Array.from(svg.querySelectorAll<SVGGElement>('g.abcjs-staff-wrapper'))) {
      if (!tab) tab = musicStarts(svg, line);
      // Grace notes are drawn tight against their note by design — counting
      // them would report every ornament as a crowded line.
      const heads = Array.from(line.querySelectorAll<SVGGraphicsElement>('.abcjs-notehead'))
        .filter(h => !h.closest('.abcjs-grace'));
      // Each STAFF of the system is measured on its own, and the worst of them
      // speaks for the line: a system is crowded when any one of its staves
      // is, and reading a melody and the rhythm under it as one row of
      // noteheads would be a mush of both their spacings rather than either's.
      const byVoice = new Map<string, Box[]>();
      for (const h of heads) {
        const b = boxIn(svg, h);
        if (!b || b.w <= 0) continue;
        const v = voiceOf(h);
        const got = byVoice.get(v);
        if (got) got.push(b); else byVoice.set(v, [b]);
      }
      let worst = 1;
      for (const boxes of Array.from(byVoice.values())) {
        // A chord's heads share one x, so the column is what counts, not the head.
        const xs = Array.from(new Set(boxes.map(b => Math.round(b.cx)))).sort((a, b) => a - b);
        const gaps: number[] = [];
        for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
        const head = median(boxes.map(b => b.w));
        const gap = median(gaps);
        // Under a handful of notes there's nothing a staff can be crowded
        // WITH, whatever the arithmetic says about one or two gaps.
        if (gaps.length < MIN_GAPS || head <= 0 || gap <= 0) continue;
        worst = Math.max(worst, CROWD_GAP * head / gap);
      }
      tight.push(worst);
    }
  }
  return { tight, tab: tab || STEP_TAB };
}

// Which voice drew this element, read off the abcjs-vN class abcjs stamps on
// everything a voice puts down. '' for a score that never says, which puts the
// lot in one bucket — exactly what a single-staff score wants.
function voiceOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const m = /(?:^|\s)abcjs-v(\d+)(?:\s|$)/.exec(e.getAttribute('class') ?? '');
    if (m) return m[1];
  }
  return '';
}

// How far into a system its music begins: the far edge of everything abcjs
// puts at the head of the line — clef, key signature, metre — measured from
// where the staff itself starts. Read off the OPENING system, so the metre is
// part of it; that's the line the eye already reads down to, and a step that
// lands on it looks placed rather than nudged.
function musicStarts(svg: SVGSVGElement, line: SVGGElement): number {
  const extras = Array.from(line.querySelectorAll<SVGGraphicsElement>('.abcjs-staff-extra'))
    .map(e => boxIn(svg, e))
    .filter((b): b is Box => !!b && b.w > 0);
  if (!extras.length) return 0;
  const staff = boxIn(svg, (line.querySelector('.abcjs-top-line') ?? line) as SVGGraphicsElement);
  if (!staff) return 0;
  const left = staff.cx - staff.w / 2;
  const right = Math.max(...extras.map(b => b.cx + b.w / 2));
  const tab = Math.round(right - left);
  // Something has gone strange if it's a third of the system: don't step by it.
  return tab > 1 && tab < staff.w / 3 ? tab : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = ns.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// abcjs wraps each system in <g class="abcjs-staff-wrapper abcjs-lN"> when
// add_classes is on, so a whole line — staff, notes, chords, lyrics — moves as
// one. `stepped` is one flag per system, in engraved order. Nothing happens if
// that group ever goes away.
//
// Every system is engraved to the same width, so a stepped one is pushed in by
// the tab AND pulled in by it: translate then squeeze, which lands its start at
// the tab and its end exactly where every other system ends. The squeeze is
// horizontal only and it is tiny — a tab against a system is a couple of per
// cent — so noteheads keep their shape.
function stepAcross(host: HTMLElement, stepped: boolean[], tab: number, width: number): void {
  const sx = width > tab * 2 ? (width - tab) / width : 1;
  let n = 0;
  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    for (const line of Array.from(svg.querySelectorAll<SVGGElement>('g.abcjs-staff-wrapper'))) {
      if (stepped[n++]) {
        const had = line.getAttribute('transform');
        line.setAttribute('transform', `translate(${tab} 0) scale(${sx.toFixed(5)} 1)${had ? ` ${had}` : ''}`);
        // A step is the SAME line carrying on, so it doesn't re-announce the
        // clef and key signature the half above it already stated — that's
        // what makes the pair read as one line rather than two. The class does
        // the hiding, in transcribe.css beside the numbers view's own.
        line.classList.add('jp-stepped');
      }
    }
  }
}

// ── keeping the reader's place ───────────────────────────────────────
// Re-engraving empties the host and fills it again, and the new engraving is
// rarely the same height: a stepped system is two rows where it was one, and a
// resized pane re-flows the lot. Left alone, both dump the reader somewhere
// else in the score — usually right back at the top, because the browser
// clamps scrollTop against the momentarily EMPTY host the moment anything
// forces layout (measure() does, on every pass).
//
// So the place is taken before the host is touched and put back after. It's
// anchored to this host rather than to a pixel, because a scroller holds one
// host per block: anything ABOVE this host hasn't moved, so scroll above it is
// left exactly as it was; anything below it shifts by the height this one
// gained or lost; and a scroll position INSIDE it keeps the same fraction of
// the way down. That last one is the nearest thing to "the same music" that
// survives a re-flow, where the system under the top edge may not exist after.
//
// Inside the host it does better than a fraction when it can: the note nearest
// the top edge is remembered, and if that same note is still engraved after,
// the scroller is put where it sits under the pointer's old sightline exactly.
// Stepping doubles the height of the CROWDED systems only, so a fraction of
// the whole would drift by a system or two down a long chart; the note can't.
type Place = {
  el: HTMLElement;
  top: number; left: number;
  hostTop: number;        // the host's start, in the scroller's own coordinates
  hostH: number;
  scrollW: number;
  // The note that was at the top edge, and how far below that edge it sat.
  anchor: { span: Span; dy: number } | null;
};

// The nearest ancestor that actually scrolls, or the page itself. Takes any
// element, SVG ink included — revealCue asks it about a number on the staff.
function scrollerOf(host: Element): HTMLElement | null {
  for (let el = host.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/auto|scroll|overlay/.test(`${s.overflowY} ${s.overflowX}`)) return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

// Where the scroller's own top edge sits in viewport coordinates. The page
// scroller has no useful box of its own — its content top IS the viewport.
function frameTop(el: HTMLElement): number {
  return el === document.scrollingElement ? 0 : el.getBoundingClientRect().top + el.clientTop;
}

// …and its left edge, for the same reason.
function frameLeft(el: HTMLElement): number {
  return el === document.scrollingElement ? 0 : el.getBoundingClientRect().left + el.clientLeft;
}

// Where the host starts, in the scroller's own scrolled coordinates.
function hostTopIn(el: HTMLElement, host: HTMLElement): number {
  return el.scrollTop + host.getBoundingClientRect().top - frameTop(el);
}

function takePlace(host: HTMLElement, hits: Hit[]): Place | null {
  const el = scrollerOf(host);
  if (!el) return null;
  const r = host.getBoundingClientRect();
  const hostTop = el.scrollTop + r.top - frameTop(el);
  // Only worth an anchor when the top edge is inside this host's engraving —
  // outside it, the rules below are exact anyway.
  const edge = el.scrollTop - hostTop;
  let anchor: Place['anchor'] = null;
  if (edge > 0 && edge < r.height) {
    let best: Hit | null = null;
    for (const h of hits) if (!best || Math.abs(h.t - edge) < Math.abs(best.t - edge)) best = h;
    if (best) anchor = { span: best.span, dy: best.t - edge };
  }
  return {
    el,
    top: el.scrollTop,
    left: el.scrollLeft,
    hostTop,
    hostH: r.height,
    scrollW: el.scrollWidth,
    anchor,
  };
}

function putPlace(p: Place | null, host: HTMLElement, hits: Hit[]): void {
  if (!p || p.hostH <= 0) return;
  const h = host.getBoundingClientRect().height;
  const below = p.hostTop + p.hostH;
  // The same note, if it survived the re-engrave: put the edge back the same
  // distance above it.
  const kept = p.anchor && hits.find(x => x.span.start === p.anchor!.span.start && x.span.end === p.anchor!.span.end);
  const top =
    p.top <= p.hostTop ? p.top                                          // above: nothing moved
    : p.top >= below ? p.top + (h - p.hostH)                            // below: shifted by the delta
    : kept ? hostTopIn(p.el, host) + kept.t - p.anchor!.dy              // inside: on the note it was on
    : p.hostTop + (p.top - p.hostTop) * (h / p.hostH);                  // …or the same fraction down
  p.el.scrollTop = top;
  // Sideways the engraving is redrawn at whatever width the renderer chose for
  // it, so hold the same fraction of that width rather than the same pixel.
  const w = p.el.scrollWidth;
  p.el.scrollLeft = p.left && p.scrollW && w !== p.scrollW ? p.left * w / p.scrollW : p.left;
}

// ── the page box ──────────────────────────────────────────────────────
// abcjs sizes an engraving in a way that has to be undone here, and it is not
// the way its docs suggest. Without `responsive` it gives the <svg> no viewBox
// at all: it draws in plain pixels, writes width/height on the svg, and then
// crops the result by putting `overflow:hidden` and a FIXED height on the
// svg's parent — which is our own host div (setPaperSize, abcjs 6.4).
//
// That height is what abcjs measured before anything here touched the page, so
// every pixel tightenChords and spaceSystems opened up is a pixel of music
// hanging outside a box that hides it — and, worse, outside what the scroll
// container thinks there is to scroll. On a long chart that's the last system
// or two, sliced off by the pane's bottom edge with no way to reach them.
//
// So the box is set from the ink instead, once, after everything that moves
// the engraving has moved it. The crop goes with it: it's also what was
// quietly swallowing the widened engraving the sideways scroll exists for, and
// the treble clef's flourish where it reaches past the left edge.
const PAGE_FOOT = 12;   // air under the last system, in CSS pixels

function fitPage(host: HTMLElement): void {
  // Out of abcjs's crop — from here the host is as tall as what's inside it.
  host.style.overflow = 'visible';
  host.style.height = '';
  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    svg.style.overflow = 'visible';
    const ink = safeBox(svg);
    if (!ink || ink.height <= 0) continue;   // unmeasurable: leave abcjs's own size
    const px = Math.ceil((ink.y + ink.height) * paintScale(svg)) + PAGE_FOOT;
    svg.setAttribute('height', String(px));
  }
}

// How many CSS pixels one of the engraving's own units comes out as. At any
// scale but 1, abcjs leaves the drawing in unscaled units and blows the whole
// <svg> up with a CSS transform — which paints big but lays out small, so the
// factor has to be read back off the transform and applied by hand.
function paintScale(svg: SVGSVGElement): number {
  const t = getComputedStyle(svg).transform;
  if (!t || t === 'none') return 1;
  try {
    const d = new DOMMatrixReadOnly(t).d;
    return d > 0 ? d : 1;
  } catch { return 1; }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Put the jianpu numbers where the noteheads are, and hide the heads.
//
// The heads are found through the element abcjs itself hands back for the
// note, not by walking the SVG, so a chord's several heads stay attached to
// the one note they belong to. They're sorted DOWN the page and zipped against
// the labels, which arrive low to high — that way a chord's numbers can't come
// out upside down even if abcjs draws its heads in some other order.
//
// The heads are hidden with `visibility`, never `display`, because everything
// else here is positioned by measuring boxes and a display:none element has
// none.
// A bookmark's number, drawn INTO the chord row rather than written into the
// ABC as an annotation.
//
// The annotation was honest but expensive: abcjs stacks what sits over a note,
// so a marked bar opened a whole row above its chords and every system on the
// page moved down to make space for it. A mark is a reference into a
// recording — it has no business changing where the music sits. Drawn here, it
// is added after every measurement is done and after the engraver, tightenChords
// and spaceSystems have all had their say, so it costs the layout nothing at
// all: the page with the marks on it is the same page, to the pixel, as the
// page without them.
//
// It goes where the chords are because that is the row the eye is already
// reading over the bar: on a note that carries a symbol it sits just in front
// of it (3 Am), on one that doesn't it sits on the same baseline over its own
// notehead, and on a system with no chords at all it sits where the chord row
// would have been.
const CUE_GAP = 3;        // between the number and the symbol it stands in front of
const CUE_OVER = 7;       // how far over the top staff line, with no chords to join

function drawCue(el: SVGGraphicsElement, label: string, taken: Map<Element, number>): void {
  const svg = el.ownerSVGElement;
  if (!svg) return;
  const line = el.closest<SVGGElement>('g.abcjs-staff-wrapper');
  const home: SVGElement = line && !line.getAttribute('transform') ? line : svg;

  // The chord this very note carries, if it carries one — abcjs draws a note
  // and everything hanging off it as one group, the symbol included — and the
  // row all of this system's chords are standing on, which is the line to sit
  // level with whether or not this note has a symbol of its own.
  const mine = el.querySelector<SVGTextElement>('text.abcjs-chord');
  const own = mine ? boxIn(svg, mine) : null;
  const row = own ?? rowOf(svg, line);
  const head = el.querySelector<SVGGraphicsElement>('.abcjs-notehead');
  const at = boxIn(svg, head ?? el);
  if (!at) return;

  const size = Math.max(5, row ? row.h * 0.62 : at.h * 1.3);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('class', 'jp-cue');
  t.setAttribute('font-weight', '400');
  // The numbers it stands for, so revealCue can find this one in the page. A
  // note can carry more than one (two bookmarks a beat apart land on the same
  // notehead), and the label is already the space-separated list — which is
  // exactly what an `[data-cue~="20"]` selector reads.
  t.setAttribute('data-cue', label);
  t.setAttribute('font-size', String(size));
  t.setAttribute('y', String(row ? row.cy + row.h / 2 : topOf(svg, line, at) - CUE_OVER));

  // In the system's FIRST bar the number goes out to the head of the line,
  // over the clef, where a rehearsal mark would be — a mark says "the line
  // starts here", and hanging it off the first chord says it about the chord
  // instead. Anywhere else it stands just in front of the symbol it shares a
  // note with, or over its own notehead when there is no symbol.
  const opening = line ? lineHead(svg, line, at) : null;
  if (opening != null) {
    const x = Math.max(opening, taken.get(line as Element) ?? -Infinity);
    t.setAttribute('x', String(x));
    t.setAttribute('text-anchor', 'start');
    // A second mark in the same opening bar starts where the first one ended.
    taken.set(line as Element, x + size * (label.length + 0.6));
  } else if (own) {
    t.setAttribute('x', String(own.cx - own.w / 2 - CUE_GAP));
    t.setAttribute('text-anchor', 'end');
  } else {
    t.setAttribute('x', String(at.cx));
    t.setAttribute('text-anchor', 'middle');
  }
  t.textContent = label;
  home.appendChild(t);
}

// ── showing a mark ────────────────────────────────────────────────────
// Landing on a bookmark — alt+20, a click on the strip — selects its M20 in
// the source; the engraving has to come along, or the passage you are about
// to hear is off the top of the notation pane.
//
// The cue knows its own number (drawCue writes it into data-cue), so the one
// to show is found in the page rather than held on to here: every re-engrave
// throws the elements away, and a remembered one would only ever be a dead
// one. It is moved ONLY when the mark isn't comfortably in view already — a
// mark you can already see is a pane that shouldn't lurch under you, and
// walking a run of marks along one system should sit still.
const REVEAL_PAD = 48;   // how near an edge still counts as out of view

export function revealCue(n: number): boolean {
  const cue = document.querySelector<SVGGraphicsElement>(`.jp-score text.jp-cue[data-cue~="${n}"]`);
  const el = cue && scrollerOf(cue);
  if (!cue || !el) return false;
  const r = cue.getBoundingClientRect();
  if (!r.width && !r.height) return false;

  const viewH = el === document.scrollingElement ? window.innerHeight : el.clientHeight;
  const padV = Math.min(REVEAL_PAD, viewH / 4);
  const top = r.top - frameTop(el);
  if (top < padV || top + r.height > viewH - padV) {
    el.scrollTop = Math.max(0, el.scrollTop + top - (viewH - r.height) / 2);
  }

  // Sideways it is only brought IN, never centred: a system wider than the
  // pane is read left to right, and swinging it half a page over to put a
  // number in the middle loses the bar you were looking at.
  const viewW = el === document.scrollingElement ? window.innerWidth : el.clientWidth;
  const padH = Math.min(REVEAL_PAD, viewW / 4);
  const left = r.left - frameLeft(el);
  if (left < padH) el.scrollLeft = Math.max(0, el.scrollLeft + left - padH);
  else if (left + r.width > viewW - padH) el.scrollLeft += left + r.width - viewW + padH;
  return true;
}

// Where a system's ink begins — its own left edge — but only for something
// standing in its FIRST bar; null says this note is further along the line and
// wants to be marked where it actually is. The first bar is everything before
// the first barline PAST the clef and key signature (the leading one, where
// abcjs draws it at all, is the head of the line rather than the end of a bar).
function lineHead(svg: SVGSVGElement, line: SVGGElement, at: Box): number | null {
  const staff = boxIn(svg, (line.querySelector('.abcjs-top-line') ?? line) as SVGGraphicsElement);
  if (!staff) return null;
  const left = staff.cx - staff.w / 2;
  const start = left + musicStarts(svg, line);
  const bars = Array.from(line.querySelectorAll<SVGGraphicsElement>('.abcjs-bar'))
    .map(b => boxIn(svg, b))
    .filter((b): b is Box => !!b)
    .map(b => b.cx)
    .filter(x => x > start + 1);
  return at.cx < (bars.length ? Math.min(...bars) : Infinity) ? left : null;
}

// The chord row of a system, as a box to sit level with: they share a baseline
// (tightenChords put them there), so the first one answers for all of them.
function rowOf(svg: SVGSVGElement, line: SVGGElement | null): Box | null {
  const c = (line ?? svg).querySelector<SVGTextElement>('text.abcjs-chord');
  return c ? boxIn(svg, c) : null;
}

// …and the top staff line above a note, for a system with no chords on it.
function topOf(svg: SVGSVGElement, line: SVGGElement | null, at: Box): number {
  const tops = Array.from((line ?? svg).querySelectorAll('.abcjs-top-line'))
    .map(e => boxIn(svg, e as SVGGraphicsElement))
    .filter((b): b is Box => !!b)
    .map(b => b.cy)
    .filter(y => y < at.cy + at.h);
  return tops.length ? Math.min(...tops) : at.cy - at.h;
}

function drawDegrees(el: SVGGraphicsElement, labels: string[]): void {
  const svg = el.ownerSVGElement;
  if (!svg) return;
  // Only ever noteheads. Anything else abcjs drew for this element — a rest
  // above all — is left exactly as engraved.
  const targets = Array.from(el.querySelectorAll<SVGGraphicsElement>('.abcjs-notehead'));
  if (!targets.length) return;
  const line = el.closest<SVGGElement>('g.abcjs-staff-wrapper');
  const home: SVGElement = line && !line.getAttribute('transform') ? line : svg;
  const boxes = targets.map(t => boxIn(svg, t));
  const order = targets.map((_, i) => i).sort((a, b) => (boxes[b]?.cy ?? 0) - (boxes[a]?.cy ?? 0));

  for (let j = 0; j < order.length; j++) {
    const box = boxes[order[j]];
    if (!box) continue;
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'jp-degree');
    t.setAttribute('x', String(box.cx));
    t.setAttribute('y', String(box.cy));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    // Sized off the notehead it replaces, so it tracks whatever scale the
    // score was engraved at.
    t.setAttribute('font-size', String(Math.max(6, box.h * 1.7)));
    t.textContent = labels[Math.min(j, labels.length - 1)];
    // Into the system's own group when there is one — the stepped layout
    // then moves the number with the line it belongs to. The box above is in
    // the SVG's coordinates, so only a group that adds no transform of its own
    // will do; the root is the fallback either way.
    home.appendChild(t);
    targets[order[j]].style.visibility = 'hidden';
    hideAccidental(svg, el, box);
  }
  shortenStem(el, boxes.filter(Boolean) as Box[]);
}

// Pull the stem back off the number.
//
// A stem is drawn from the middle of the notehead it belongs to, which was
// fine when a notehead was an ellipse the stem could touch the side of — but a
// digit is taller than the head it replaced, so the stem runs straight through
// it. Trimming the head END (never the far end, where the beam or flag lives)
// leaves the rhythm intact and the number clear.
//
// Done as a transform rather than by rewriting the path, so it works whatever
// shape abcjs drew and can't corrupt the geometry: a vertical squash pinned to
// the far end, which pulls the near end away from the head.
const STEM_TRIM = 0.75;    // of a notehead's height
const STEM_KEEP = 0.62;    // never take more than this much off a short stem

function shortenStem(el: SVGGraphicsElement, heads: Box[]): void {
  if (!heads.length) return;
  const stem = el.querySelector<SVGGraphicsElement>('.abcjs-stem');
  if (!stem) return;
  const b = safeBox(stem);
  if (!b || b.height <= 0) return;

  const headMid = heads.reduce((n, h) => n + h.cy, 0) / heads.length;
  const headH = heads.reduce((n, h) => Math.max(n, h.h), 0);
  // The stem hangs above the heads (stem up) or below them (stem down); the
  // end to trim is the one on the heads' side.
  const up = b.y + b.height / 2 < headMid;

  const trim = Math.min(headH * STEM_TRIM, b.height * (1 - STEM_KEEP));
  if (trim <= 0.2) return;
  const k = 1 - trim / b.height;
  const anchor = up ? b.y : b.y + b.height;    // the beam/flag end stays put
  const squash = `translate(0 ${anchor * (1 - k)}) scale(1 ${k})`;
  // Any transform already on the element maps its user space into the parent,
  // and the box above is in that user space — so the squash has to happen
  // first, which means it goes LAST in the list.
  const had = stem.getAttribute('transform');
  stem.setAttribute('transform', had ? `${had} ${squash}` : squash);
}

// The accidental abcjs engraved is saying the same thing as the b or # in
// front of the number, so it goes.
//
// It has no class of its own — abcjs only labels noteheads — so it's found by
// where it sits: an unclassed glyph immediately LEFT of the head, at the head's
// own height. A flag is on the far side and well above or below the head, and
// stems and beams carry classes, so none of those can be caught by mistake.
function hideAccidental(svg: SVGSVGElement, el: SVGGraphicsElement, head: Box): void {
  for (const p of Array.from(el.querySelectorAll<SVGGraphicsElement>('path'))) {
    if (p.classList.contains('abcjs-notehead') || p.classList.contains('abcjs-stem')) continue;
    const b = boxIn(svg, p);
    if (!b) continue;
    if (b.cx < head.cx - head.w * 0.4 && Math.abs(b.cy - head.cy) < head.h * 1.6) {
      p.style.visibility = 'hidden';
    }
  }
}

// An element's box in the SVG's own coordinates — its bbox carried through
// whatever transforms sit between it and the root.
function boxIn(svg: SVGSVGElement, el: SVGGraphicsElement): Box | null {
  const b = safeBox(el);
  if (!b) return null;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const m = el.getCTM();
  if (!m) return { cx, cy, w: b.width, h: b.height };
  const scale = Math.hypot(m.a, m.b) || 1;
  return {
    cx: m.a * cx + m.c * cy + m.e,
    cy: m.b * cx + m.d * cy + m.f,
    w: b.width * scale,
    h: b.height * scale,
  };
}

type Box = { cx: number; cy: number; w: number; h: number };

// getBBox throws on elements that aren't rendered yet in some engines.
function safeBox(el: Element): DOMRect | null {
  try { return (el as SVGGraphicsElement).getBBox(); } catch { return null; }
}

export function Score({ abc, scale = 1, wrap = true, perLine = 4, mayStep = false, spans, numbers, labels, unders, chordMarks, cues, caret, onHover, onPick, onChord, onPlayFrom }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [, setBump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Rebuilt after every engrave; empty when the score carries no mapping.
  const hitsRef = useRef<Hit[]>([]);
  const chordHitsRef = useRef<ChordHit[]>([]);
  const hoveredRef = useRef<Span | null>(null);
  // What the caret is lighting up, and the elements currently wearing the
  // class. The engraving is rebuilt from scratch by every re-engrave, so the
  // list is only ever used to take the class OFF things that are still there.
  const litRef = useRef<SVGGraphicsElement[]>([]);
  const caretRef = useRef<Span | null | undefined>(caret);
  caretRef.current = caret;

  // Light the note the caret is in. Every hit with that exact span, so a note
  // the engraver split across the bar's middle lights at both its noteheads —
  // they are one note in the writing, which is what the caret is in.
  const light = useCallback((span: Span | null | undefined) => {
    for (const el of litRef.current) el.classList.remove('jp-lit');
    litRef.current = [];
    if (!span) return;
    for (const h of hitsRef.current) {
      if (h.span.start !== span.start || h.span.end !== span.end) continue;
      h.el.classList.add('jp-lit');
      litRef.current.push(h.el);
    }
  }, []);

  useEffect(() => { light(caret); }, [light, caret?.start, caret?.end, caret == null]);

  // Track the pane's width so the engraving reflows when the panes are resized
  // or the window changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0].contentRect.width);
      setWidth(prev => (Math.abs(prev - w) > 2 ? w : prev));
    });
    ro.observe(host);
    setWidth(Math.floor(host.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !width) return;
    if (!window.ABCJS) {
      // The CDN script hasn't landed yet — try again shortly.
      const t = window.setTimeout(() => setBump(v => v + 1), 80);
      return () => clearTimeout(t);
    }
    const full = Math.max(220, width - 12);

    const engrave = (src: string, staffwidth: number, reflow: boolean) => {
      host.innerHTML = '';
      return window.ABCJS.renderAbc(host, src, {
        add_classes: true,          // needed to find .abcjs-chord below
        staffwidth,
        ...(reflow ? { wrap: { minSpacing: 1.6, maxSpacing: 2.8, preferredMeasuresPerLine: perLine } } : {}),
        scale,
        paddingtop: 6,
        paddingbottom: 12,
        paddingleft: 0,
        paddingright: 0,
      });
    };

    // The re-flow is the fragile half of abcjs — it walks its own line-break
    // table and throws on shapes it didn't expect. Losing the line breaks is a
    // far better outcome than losing the music, so fall back to no re-flow
    // before reporting anything.
    const run = (src: string, staffwidth: number, reflow: boolean): any[] | null => {
      try {
        const t = engrave(src, staffwidth, reflow);
        setError(null);
        return t;
      } catch (e) {
        if (!reflow) { setError(e instanceof Error ? e.message : String(e)); return null; }
        return run(src, staffwidth, false);
      }
    };

    // Taken before the first engrave empties the host, and off the hits the
    // LAST one left behind — see takePlace.
    const spot = takePlace(host, hitsRef.current);
    hitsRef.current = [];
    chordHitsRef.current = [];

    // ── pass one: the score as written ─────────────────────────────────
    // Engraved at the pane's width, and then READ: how much room did each
    // system's notes actually get, and how wide is the clef? A score that
    // reads comfortably stops here — this is the only pass there is.
    let tunes = run(abc, full, wrap);
    if (!tunes) { putPlace(spot, host, hitsRef.current); return; }

    const look = measure(host);
    const bars = systemBars(abc);
    // `tight` is per ENGRAVED system, and a re-flow can put the breaks
    // somewhere other than the body did. Same number of systems means the two
    // agree; anything else and there's no honest way to say WHICH line was
    // crowded, so the score is left alone.
    const aligned = look.tight.length === bars.length;
    const crowded = (i: number) => aligned && look.tight[i] > 1;

    // ── pass two: room for the lines that didn't get any ───────────────
    // Cutting a crowded system into rows is the first answer: its notes get
    // the width over fewer bars. HOW MANY rows is arithmetic rather than a
    // rule: a line that came out 1.2× too tight is fixed by two rows, and only
    // one 3× too tight needs three — so an eight-bar system that's barely
    // crowded comes out as two full rows, not a flight of two-bar steps. The
    // tab a continuation is indented by is width the notes don't get, so it's
    // part of the sum. Where cutting isn't on the table — a phone, or a system
    // too short to cut — the score is engraved wider than the pane instead and
    // the scroller carries it.
    const rowsFor = (i: number) => (
      crowded(i) ? Math.ceil(look.tight[i] * full / Math.max(1, full - look.tab)) : 1
    );
    const plan = mayStep && bars.some((_, i) => crowded(i))
      ? splitSystems(abc, rowsFor, MIN_STEP_BARS)
      : null;
    const stepped = plan && plan.stepped.some(Boolean) ? plan : null;
    const indent = stepped ? look.tab : 0;
    // What each system's tightness will be once the cutting has done what it
    // can: a cut system keeps its notes but is drawn over its FULLEST row's
    // worth of bars instead of all of them, in a width the tab has come out
    // of. Whatever is still crowded after that is what the extra width is for.
    const after = look.tight.map((t, i) => {
      const rows = stepped ? stepped.used[i] ?? 1 : 1;
      if (rows < 2) return t;
      return t * Math.ceil(bars[i] / rows) / bars[i] * (full / (full - indent));
    });
    const widen = clamp(Math.max(1, ...after), 1, MAX_WIDEN);
    // Every system is engraved to the whole width; the tab is taken out of the
    // stepped ones afterwards, by stepAcross, so that they end where the rest
    // of them end.
    const staffwidth = Math.round(full * widen);

    if (stepped || widen > 1) {
      // A stepped score sets its own line breaks, so abcjs's re-flow has to go
      // — `wrap` ignores newlines in the body entirely.
      tunes = run(stepped ? stepped.abc : abc, staffwidth, stepped ? false : wrap);
      if (!tunes) { putPlace(spot, host, hitsRef.current); return; }
    }

    // abcjs parks chord symbols on one baseline clear of the tallest thing in
    // the system, which reads as floating away from the music — and, when one
    // note is up on ledger lines, as belonging to the staff above. Set each row
    // where its own columns say it belongs, then give the system whatever room
    // that needs over it, so the symbols read as the property of the staff
    // under them.
    for (const svg of Array.from(host.querySelectorAll('svg'))) {
      tightenChords(svg, numbers ? { gap: 18, pad: 16 } : {});
      spaceSystems(svg);
      placeBarNumbers(svg);
    }

    // Everything abcjs drew, split back into the voice that asked for it. The
    // voices are written down the ABC in the order they're engraved, so where
    // an element sits in it says which staff drew it: the last voice that
    // starts at or before the element is the one it belongs to.
    // The offset an under-staff carries points into the ABC as BUILT. A
    // stepped score is a rewrite of that text — every line past the first cut
    // has moved — so the offsets are read back off whatever was engraved.
    const staves = ((us: UnderStaff[]) => {
      if (!stepped || !us.length) return us;
      const starts = voiceStarts(stepped.abc).slice(-us.length);
      return starts.length === us.length ? us.map((u, i) => ({ ...u, from: starts[i] })) : us;
    })(unders ?? []);
    const selectables = (): { music: any[]; unders: any[][] } => {
      const all: any[] = tunes!.flatMap(t => (t?.getSelectableArray?.() ?? []));
      const out = staves.map(() => [] as any[]);
      if (!staves.length) return { music: all, unders: out };
      const music: any[] = [];
      for (const s of all) {
        const at = s?.absEl?.abcelem?.startChar;
        const where = typeof at === 'number' ? at : -1;
        let mine = -1;
        for (let i = 0; i < staves.length; i++) if (where >= staves[i].from) mine = i;
        if (mine < 0) music.push(s); else out[mine].push(s);
      }
      return { music, unders: out };
    };

    // ── numbers instead of noteheads ───────────────────────────────────
    // Every pitched staff underneath gets the same treatment: with the staff
    // lines and clef hidden, a row of noteheads down there would be floating
    // in space.
    if (numbers) {
      const sel = selectables();
      const label = (els: any[], src?: (string[] | null)[]) => {
        if (!src || !src.length || els.length !== src.length) return;
        for (let i = 0; i < els.length; i++) {
          const el = els[i]?.svgEl as SVGGraphicsElement | undefined;
          const l = src[i];
          if (!el || !l || !l.length) continue;
          drawDegrees(el, l);
        }
      };
      label(sel.music, labels);
      for (let i = 0; i < staves.length; i++) label(sel.unders[i], staves[i].labels);
    }

    // ── the marks ──────────────────────────────────────────────────────
    // Same zip as the map back to the source below, and for the same reason:
    // abcjs hands its selectables back in the order buildAbc wrote them, so
    // the Nth engraved note is the Nth span. A note the engraver split across
    // the bar's middle appears twice under one span; the mark goes on the
    // first of them, which is the one the note begins at.
    if (cues && cues.size && spans && spans.length) {
      const els = selectables().music;
      if (els.length === spans.length) {
        const done = new Set<number>();
        // Where the last mark at the head of each system ended, so a second
        // one in the same opening bar doesn't land on top of it.
        const taken = new Map<Element, number>();
        for (let i = 0; i < els.length; i++) {
          const span = spans[i];
          const el = els[i]?.svgEl as SVGGraphicsElement | undefined;
          if (!span || !el || done.has(span.start)) continue;
          const mine = cues.get(span.start);
          if (!mine) continue;
          done.add(span.start);
          drawCue(el, mine.join(' '), taken);
        }
      }
    }

    // ── the stepped layout ─────────────────────────────────────────────
    // Last of the things that MOVE the engraving: the degrees above went into
    // their own system's group, so they ride along with it.
    if (stepped) stepAcross(host, stepped.stepped, indent, staffwidth);

    // …and now that nothing else will move, the page is sized to what's on it.
    fitPage(host);

    // ── the map back to the source ─────────────────────────────────────
    // abcjs's selectable array is one entry per engraved note, in the order
    // they were written, which is exactly the order buildAbc recorded its
    // spans in. Zip the two and measure each one's box now — LAST of all, after
    // the viewBox surgery and the stepping, or every rectangle would be off by
    // whatever moved afterwards.
    if (spans && spans.length) {
      const sel = selectables();
      const box = host.getBoundingClientRect();
      const hits: Hit[] = [];
      // A mismatch means the two lists have drifted apart and every lookup
      // after the first difference would point at the wrong character. Better
      // no mapping at all than a confidently wrong one — and the two staves
      // are judged separately, so a stab line that didn't line up doesn't cost
      // the music its own map.
      const zip = (els: any[], src: (Span | null)[]) => {
        if (els.length !== src.length) return;
        for (let i = 0; i < els.length; i++) {
          const span = src[i];
          const el = els[i]?.svgEl as SVGGraphicsElement | undefined;
          if (!span || !el) continue;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          hits.push({ l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top, span, el });
        }
      };
      zip(sel.music, spans);
      for (let i = 0; i < staves.length; i++) {
        if (staves[i].spans.length) zip(sel.unders[i], staves[i].spans);
      }
      hitsRef.current = hits;
    }

    // ── the same, for the chord symbols ────────────────────────────────
    // abcjs hangs a symbol off the note it was written on, so the text
    // elements come out in the order the ABC put them in — which is the order
    // buildAbc recorded them in. Zipped and measured exactly like the
    // noteheads, and dropped whole on a mismatch for the same reason: a
    // symbol that sounds the chord next to it is worse than one that does
    // nothing at all.
    if (chordMarks && chordMarks.length) {
      const texts = drawChords(host, chordMarks);
      if (texts) {
        const box = host.getBoundingClientRect();
        const hits: ChordHit[] = [];
        for (let i = 0; i < texts.length; i++) {
          const r = texts[i].getBoundingClientRect();
          if (!r.width && !r.height) continue;
          hits.push({
            l: r.left - box.left, t: r.top - box.top,
            r: r.right - box.left, b: r.bottom - box.top,
            mark: chordMarks[i],
          });
        }
        chordHitsRef.current = hits;
      }
    }

    // The caret was lighting a note before the re-engrave and the elements it
    // was lighting have just been thrown away — put it back on the new ones.
    light(caretRef.current);

    // ── back to where the reader was ───────────────────────────────────
    // Last of all: everything above has finished moving the engraving about,
    // and the height it ended up at is what the place is put back against.
    putPlace(spot, host, hitsRef.current);

  }, [abc, width, scale, wrap, perLine, mayStep, spans, numbers, labels, unders, chordMarks, cues]);

  // Hover and click both ask the same question — which notehead is the pointer
  // nearest? — so they share one hit test.
  const at = (e: MouseEvent): Hit | null => {
    const host = hostRef.current;
    if (!host || !hitsRef.current.length) return null;
    const box = host.getBoundingClientRect();
    return nearest(hitsRef.current, e.clientX - box.left, e.clientY - box.top);
  };

  // …and the chord symbols, asked first: a symbol is a small target sitting
  // over the staff, so the pointer has to be ON one for it to win. Everywhere
  // else the nearest notehead answers, exactly as before.
  const chordAt = (e: MouseEvent): ChordHit | null => {
    const host = hostRef.current;
    if (!host || !chordHitsRef.current.length) return null;
    const box = host.getBoundingClientRect();
    return inChord(chordHitsRef.current, e.clientX - box.left, e.clientY - box.top);
  };

  const onMove = (e: MouseEvent) => {
    const chord = chordAt(e);
    if (chord) {
      hostRef.current?.classList.add('is-pickable');
      const span = chord.mark.src;
      const was = hoveredRef.current;
      if (was?.start === span?.start && was?.end === span?.end) return;
      hoveredRef.current = span;
      onHover?.(span);
      return;
    }
    const hit = at(e);
    const span = hit?.span ?? null;
    hostRef.current?.classList.toggle('is-pickable', !!span);
    // Only report a CHANGE — a mousemove fires on every pixel, and each report
    // re-renders the source pane.
    const was = hoveredRef.current;
    if (was?.start === span?.start && was?.end === span?.end) return;
    hoveredRef.current = span;
    onHover?.(span);
  };

  const onLeave = () => {
    hostRef.current?.classList.remove('is-pickable');
    if (!hoveredRef.current) return;
    hoveredRef.current = null;
    onHover?.(null);
  };

  // Let go of the highlight when the score is re-engraved under the pointer.
  useEffect(() => () => { if (hoveredRef.current) onHover?.(null); }, []);

  return (
    <div class="jp-score">
      <div
        class={`jp-score-host${numbers ? ' is-numbers' : ''}`}
        ref={hostRef}
        onMouseMove={onMove as any}
        onMouseLeave={onLeave}
        onClick={(e: MouseEvent) => {
          // A chord symbol answers for itself — the caret goes to the symbol
          // rather than to whatever notehead happens to be under it, and the
          // harmony is what sounds.
          const c = chordAt(e);
          if (c) { onChord?.(c.mark); return; }
          const h = at(e);
          if (h) onPick?.(h.span);
        }}
        onDblClick={(e: MouseEvent) => {
          // The second mousedown has usually selected a "word" of the
          // engraving's own text (a chord symbol, a title) before this runs,
          // so preventing the default isn't enough on its own — drop whatever
          // range it made as well.
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
          const h = at(e);
          if (h) onPlayFrom?.(h.span);
        }}
      />
      {error && <div class="jp-score-err">abcjs couldn't engrave this: {error}</div>}
    </div>
  );
}
