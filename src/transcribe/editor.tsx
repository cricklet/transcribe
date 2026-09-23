// The source input pane.
//
// It's a real <textarea> (so selection, undo, IME and autoscroll all behave)
// laid over a "mirror" <pre> that holds the same text broken into one <span>
// per parser Annotation. The textarea paints its own text transparent, so what
// you actually see is the mirror — which gives us syntax colour for free and,
// more importantly, a real DOM box per meaningful character run.
//
// That's what makes the hover hints possible and correctly positioned: on
// mousemove we hit-test the cached span rects, then park the bubble against
// the exact glyph box. Because the annotations come from the parser rather
// than a static character table, the hint knows the character's meaning IN
// CONTEXT — the 3 in "q3'" reads "mi · degree 3", and its ' reads "degree 3 up
// an octave".

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RespellResult } from './retune';
import { Annotation, Span } from './types';

// A parser/engraver complaint, drawn as a squiggle under the characters it is
// about. Hovering one says what's wrong — which is the whole report: nothing
// is listed under the pane, so a problem is always read where it happened.
export type Flaw = { span: Span; msg: string; kind: 'err' | 'warn' };

// What the selection menu needs from the app: which centres this document
// already uses, which one is running at a given character, and how to plan the
// edit. The parsing all stays on the app's side; this file only has to know
// where the selection is on screen.
export type Respell = {
  choices: { spec: string; name: string }[];
  // Whether a range holds any note worth respelling — the menu stays away
  // from a selection that's all comment, title or barlines.
  usable: (start: number, end: number) => boolean;
  currentAt: (offset: number) => string;
  plan: (start: number, end: number, spec: string) => RespellResult;
  // The menu's second line: the same passage MOVED, by however many semitones.
  // Same shape of answer as a respelling, so the same code applies it — select
  // the lot and it's the whole chart that goes up a step.
  transpose: (start: number, end: number, semitones: number) => RespellResult;
  // The chord bar's other button: a chart's letter chords rewritten as roman
  // numerals — or, when it's numerals already, back into letters. `toRoman`
  // says which way a press would go, for the button's label.
  romanize: (start: number, end: number) => RespellResult;
  toRoman: (start: number, end: number) => boolean;
};

type Props = {
  text: string;
  annotations: Annotation[];
  // Errors and warnings to squiggle. Hover-explained whether or not the
  // `explain` hints are on — a problem isn't an optional detail.
  flaws: Flaw[];
  explain: boolean;
  onChange: (text: string) => void;
  respell?: Respell;
  // Every chord chart in the source, as the range of characters it occupies.
  // Hovering one washes it in and floats a bar that moves the whole chart by a
  // semitone — the fix for a form pasted in from the wrong key, which is a
  // thing you notice by ear long before you'd want to select it and think
  // about key centres.
  charts?: Span[];
  // The run of source the pointer is over in the NOTATION pane, washed in so
  // you can see which characters wrote the note under the cursor.
  focus?: Span | null;
  // alt+[ / alt+] — walk one note back or forward from the caret, sounding it,
  // or one chord when the caret is in a chord chart. The app decides which and
  // sends the caret back through `jump`; all this end knows is which way and
  // where from.
  onStep?: (dir: 1 | -1, caret: number) => void;
  // Where the caret is now, reported on every move of it. The app turns the
  // character offset into the note it's in — or the one before it — and lights
  // that note on the staff, so the two panes always agree about where you are.
  onCaret?: (at: number) => void;
  // alt+\ — play the score from the caret, and stop it if it's already going.
  // Same deal: the app owns the transport, this end just says where from.
  onPlayFromCaret?: (caret: number) => void;
  // A request from the notation to put the caret on a span. Carries a nonce so
  // clicking the same note twice still jumps (the span alone wouldn't change).
  // `quiet` parks the caret without selecting the token or holding focus —
  // what a double-click wants, since that gesture is about playback.
  jump?: { span: Span; n: number; quiet?: boolean } | null;
  // Where this transcription was left: the caret's offset and the scroll it
  // sat at. Applied whenever the nonce changes — a document opening, or this
  // pane coming back up beside the notation — and never focusing, because
  // being handed a document is not the same as asking to type in it.
  restore?: { caret: number; top: number; n: number } | null;
  // How far the source is scrolled, out to the app, which is what remembers
  // it. Fires on every scroll, so it does no work of its own.
  onScroll?: (top: number) => void;
};

type Piece = { text: string; ann: Annotation | null; ai: number; start: number; hot?: boolean; di?: number; dk?: Flaw['kind'] };

// The chord charts' on-screen boxes, measured once and thrown away whenever a
// glyph could have moved. A chart occupies whole LINES, so what's kept is the
// band of them: the pointer is on the chart whenever it's between those two
// heights, which is also what lets it travel out to the bar at the pane's
// right edge without falling off the chart on the way.
type ChartRects = { i: number; top: number; bottom: number }[];

type Hint = { label: string; detail?: string; kind?: Flaw['kind']; left: number; top: number; below: boolean };

// A first guess at the selection menu's box, used for the frame before it has
// been on screen to measure. Two rows of chips; the real numbers depend on how
// long the key names are, so the menu is measured once it's up.
const MENU_H = 52;
const MENU_W = 320;
// What the sheet insets the menu from the pane's right edge by, and the air it
// keeps from the selection when it has to step off the line.
const MENU_EDGE = 6;
const MENU_GAP = 4;
// …and the chord bar, which is one row of the same chips.
const BAR_H = 24;

export function Editor({ text, annotations, flaws, explain, onChange, respell, charts, focus, jump, restore, onStep, onPlayFromCaret, onCaret, onScroll }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLPreElement | null>(null);
  // The text inside the mirror, which is what actually moves — see syncScroll.
  const inkRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  // Held in a ref so syncScroll — which half the pane depends on by identity —
  // doesn't get a new one every render.
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const [hotIdx, setHotIdx] = useState(-1);
  // The live selection, and where to park the respell menu over it.
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ top: number } | null>(null);
  // What was refused, and which of the two lines asked for it — a menu that
  // says no should say it where the decision was made.
  const [problem, setProblem] = useState<{ msg: string; row: 'key' | 'semis' } | null>(null);
  const [spec, setSpec] = useState('');
  const [semis, setSemis] = useState('');
  // Bumped on scroll/resize so the menu re-measures where the selection went.
  const [nudge, setNudge] = useState(0);

  // Cached client rects of every annotated span, and of every squiggle.
  // Invalidated whenever the text, the annotations, the scroll offset or the
  // box size changes — anything that could move a glyph.
  const rectsRef = useRef<{ rect: DOMRect; ann: Annotation; ai: number }[] | null>(null);
  const flawRectsRef = useRef<{ rect: DOMRect; di: number }[] | null>(null);
  const chartRectsRef = useRef<ChartRects | null>(null);
  const invalidate = useCallback(() => {
    rectsRef.current = null; flawRectsRef.current = null; chartRectsRef.current = null;
  }, []);

  // Which chord chart the pointer is on, by index into `charts` rather than by
  // span: moving one rewrites it, and the index is what survives that. Plus
  // whatever the last move was refused for, said on the bar itself.
  const [chartHot, setChartHot] = useState<{ i: number; top: number } | null>(null);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const hotChart = chartHot && charts ? charts[chartHot.i] : null;

  // Same flaws, with a span that's actually drawable: clamped to the text, and
  // a placeholder span (the engraver has nothing to point at for some) opened
  // out to the whole line it landed on.
  const marks = useMemo(() => flaws.map(f => ({ ...f, span: drawable(f.span, text) })), [flaws, text]);

  const pieces = useMemo(
    () => markFlaws(markFocus(buildPieces(text, annotations), focus), marks),
    [text, annotations, marks, focus?.start, focus?.end],
  );

  useLayoutEffect(invalidate, [pieces]);

  // The notation asked for a spot: select it, and scroll the line into view.
  // The textarea's own caret-into-view only runs on some paths, and the line
  // is more useful centred than merely on-screen.
  useEffect(() => {
    const ta = areaRef.current;
    if (!ta || !jump) return;
    const { start, end } = jump.span;
    const from = Math.min(start, text.length);
    if (jump.quiet) {
      // Leave nothing selected and nothing focused — a double-click on the
      // engraving asked to HEAR something, and answering it by parking a
      // cursor in the source is answering a different question.
      if (document.activeElement === ta) ta.blur();
      ta.setSelectionRange(from, from);
    } else {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(from, Math.min(end, text.length));
    }
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    if (!Number.isNaN(lh) && lh > 0) {
      let line = 0;
      for (let i = 0; i < start && i < text.length; i++) if (text[i] === '\n') line++;
      const want = line * lh - (ta.clientHeight - lh) / 2;
      ta.scrollTop = Math.max(0, Math.min(want, ta.scrollHeight - ta.clientHeight));
    }
    syncScroll();
  }, [jump?.n]);

  // Back to where this document was left. Runs on mount as well as on the
  // nonce, so rotating the source pane back into view lands on the same line
  // it was showing rather than at the top of the transcription.
  useLayoutEffect(() => {
    const ta = areaRef.current;
    if (!ta || !restore) return;
    const at = Math.min(restore.caret, text.length);
    ta.setSelectionRange(at, at);
    ta.scrollTop = Math.max(0, Math.min(restore.top, ta.scrollHeight - ta.clientHeight));
    syncScroll();
  }, [restore?.n]);

  // Keep the coloured text exactly under the textarea's own.
  //
  // It is MOVED rather than scrolled. Two scroll boxes only stay in step while
  // they can scroll the same distance, and these two never quite can: the
  // textarea reserves a gutter for its scrollbars and the mirror (overflow:
  // hidden) reserves none, so the mirror runs out of scroll before the
  // textarea does. Assigning scrollTop past that point silently clamps —
  // which is a drift you only meet at the bottom of a long transcription, the
  // text sitting a fraction of a line off the selection under it and the caret
  // apparently in the wrong place. A transform can't clamp.
  const syncScroll = useCallback(() => {
    const ta = areaRef.current, ink = inkRef.current;
    if (!ta || !ink) return;
    ink.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    invalidate();
    setHint(null);
    setChartHot(null);
    setNudge(n => n + 1);
    onScrollRef.current?.(ta.scrollTop);
  }, [invalidate]);

  // Where the caret is, out to the app — see Props.onCaret. selectionchange is
  // the one event that catches every way it can move: clicking, typing, the
  // arrow keys, and the setSelectionRange the notation's own click does. Only
  // while the textarea is the focused element, but NOT cleared when it blurs:
  // the lit note is where you are in the writing, and reaching for the score
  // to look at it shouldn't put it out.
  useEffect(() => {
    if (!onCaret) return;
    const read = () => {
      const ta = areaRef.current;
      if (!ta || document.activeElement !== ta) return;
      const at = ta.selectionStart;
      if (at != null) onCaret(at);
    };
    read();
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [onCaret]);

  // ── the respell menu ───────────────────────────────────────────────
  // Watch the textarea's selection. Only while it's the focused element, so
  // clicking into the menu itself doesn't read as "selection gone" — the
  // textarea keeps its range while blurred, and we put it back before editing.
  useEffect(() => {
    if (!respell) return;
    const read = () => {
      const ta = areaRef.current;
      if (!ta || document.activeElement !== ta) return;
      const { selectionStart: a, selectionEnd: b } = ta;
      const live = a != null && b != null && b > a && respell.usable(a, b);
      setSel(live ? { start: a as number, end: b as number } : null);
      setProblem(null);
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [respell]);

  // The menu's real box. Its WIDTH decides whether a given line of the
  // selection runs under it, and that depends on how long the key names in the
  // chips are — so measure rather than guess. Runs after every render and only
  // writes when the size actually moved, so it settles in one pass.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuBox, setMenuBox] = useState({ w: MENU_W, h: MENU_H });
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    if (Math.abs(b.width - menuBox.w) > 1 || Math.abs(b.height - menuBox.h) > 1) {
      setMenuBox({ w: b.width, h: b.height });
    }
  });

  // Park it beside the selection, pinned to the pane's right edge rather than
  // floating over the line: the source is the thing being read while the menu
  // is open, and a bubble sitting on top of it hides the very characters the
  // decision is about. The mirror holds the same characters as the textarea and
  // moves with it, so a Range across the mirror says exactly where the
  // selection is — something a textarea won't say.
  //
  // Level with the selection's first line is where the menu belongs, and on a
  // short line nothing is hidden by it. But a long line runs right under it,
  // and so does any selection of more than a line or two — so the line it sits
  // level with is chosen rather than assumed: level first, then clear above the
  // selection, then clear below it, and if the selection is big enough to leave
  // nowhere clear (a whole visible pane of it), whichever of the three hides
  // the least of it.
  useLayoutEffect(() => {
    const wrap = wrapRef.current, mi = mirrorRef.current;
    if (!sel || !wrap || !mi) { setMenu(null); return; }
    const rects = rangeRects(mi, sel.start, sel.end);
    if (!rects.length) { setMenu(null); return; }
    const box = wrap.getBoundingClientRect();
    // One rect per line of the selection (per run within a line, really — the
    // mirror is spans), in the pane's own coordinates.
    const lines = rects.map(r => ({
      top: r.top - box.top, bottom: r.bottom - box.top,
      left: r.left - box.left, right: r.right - box.left,
    }));
    const selTop = Math.min(...lines.map(l => l.top));
    const selBot = Math.max(...lines.map(l => l.bottom));
    // Out of view after a scroll — no point drawing a menu pointing off-screen.
    if (selBot < 0 || selTop > box.height) { setMenu(null); return; }

    const { w, h } = menuBox;
    const right = box.width - MENU_EDGE, left = right - w;
    const fit = (t: number) => Math.max(2, Math.min(t, box.height - h - 2));
    // How much of the selection a menu at this top would sit on top of.
    const hides = (t: number) => lines.reduce((sum, l) => {
      const dy = Math.min(l.bottom, t + h) - Math.max(l.top, t);
      const dx = Math.min(l.right, right) - Math.max(l.left, left);
      return sum + (dy > 0 && dx > 0 ? dy * dx : 0);
    }, 0);

    const tops = [fit(selTop), fit(selTop - h - MENU_GAP), fit(selBot + MENU_GAP)];
    let top = tops[0], least = hides(tops[0]);
    for (let i = 1; i < tops.length && least > 0; i++) {
      const cost = hides(tops[i]);
      // Ties go to the earlier candidate, so a menu that hides nothing where it
      // is stays level with the line instead of drifting off it.
      if (cost < least) { top = tops[i]; least = cost; }
    }
    setMenu({ top });
  }, [sel, pieces, nudge, text, menuBox]);

  // Rewrite the selection, through the textarea so ⌘Z undoes it in one step and
  // re-selecting the result leaves it ready for another go. Both lines of the
  // menu come through here: a respelling and a transposition differ in what
  // they work out, not in how the answer is applied.
  const applyPlan = useCallback((plan: RespellResult, row: 'key' | 'semis') => {
    const ta = areaRef.current;
    if (!ta) return;
    if ('error' in plan) { setProblem({ msg: plan.error, row }); return; }
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(plan.from, plan.to);
    typeInto(ta, plan.replacement, () => {
      const next = text.slice(0, plan.from) + plan.replacement + text.slice(plan.to);
      ta.value = next;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    ta.setSelectionRange(plan.selection.start, plan.selection.end);
    setSel({ ...plan.selection });
    setProblem(null);
    setSpec('');
    setSemis('');
  }, [text]);

  const applyRespell = useCallback((target: string) => {
    if (!sel || !respell) return;
    applyPlan(respell.plan(sel.start, sel.end, target), 'key');
  }, [sel, respell, applyPlan]);

  const applyTranspose = useCallback((by: number) => {
    if (!sel || !respell) return;
    applyPlan(respell.transpose(sel.start, sel.end, by), 'semis');
  }, [sel, respell, applyPlan]);

  // Move a whole chord chart, leaving nothing selected behind. The bar is a
  // hover control: popping the selection menu open on top of the very chart
  // you're squinting at is not what a nudge asked for. Otherwise it's the same
  // edit as the menu's — through the textarea, so ⌘Z takes it back in one step
  // and a second nudge is one more click away.
  const shiftChart = useCallback((by: number | 'roman') => {
    const ta = areaRef.current;
    if (!ta || !hotChart || !respell) return;
    const plan = by === 'roman'
      ? respell.romanize(hotChart.start, hotChart.end)
      : respell.transpose(hotChart.start, hotChart.end, by);
    if ('error' in plan) { setChartErr(plan.error); return; }
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(plan.from, plan.to);
    typeInto(ta, plan.replacement, () => {
      const next = text.slice(0, plan.from) + plan.replacement + text.slice(plan.to);
      ta.value = next;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    ta.setSelectionRange(plan.selection.start, plan.selection.start);
    setChartErr(null);
    invalidate();
  }, [hotChart, respell, text, invalidate]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => { invalidate(); setHint(null); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [invalidate]);

  const onMove = useCallback((e: MouseEvent) => {
    const wrap = wrapRef.current, mirror = mirrorRef.current;
    if (!wrap || !mirror) return;
    const box = wrap.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;

    // A squiggle answers first: it's the more urgent thing under the pointer,
    // and unlike the character hints it doesn't wait for explain mode.
    if (marks.length) {
      if (!flawRectsRef.current) {
        flawRectsRef.current = Array.from(mirror.querySelectorAll<HTMLElement>('span[data-di]'))
          .map(s => ({ rect: s.getBoundingClientRect(), di: Number(s.dataset.di) }))
          .filter(r => marks[r.di]);
      }
      // Squiggles sit just under the glyphs, so the wavy line itself is inside
      // the box; a couple of px of slack makes it easy to land on all the same.
      const hit = flawRectsRef.current.find(r =>
        x >= r.rect.left && x <= r.rect.right && y >= r.rect.top - 2 && y <= r.rect.bottom + 2);
      if (hit) {
        const m = marks[hit.di];
        const below = hit.rect.top - box.top < 34;
        setHotIdx(-1);
        setHint({
          label: m.msg,
          kind: m.kind,
          left: hit.rect.left + hit.rect.width / 2 - box.left,
          top: below ? hit.rect.bottom - box.top + 6 : hit.rect.top - box.top - 6,
          below,
        });
        return;
      }
    }

    // ── the chord-chart bar ──────────────────────────────────────────
    // Before the explain gate, deliberately: a chart in the wrong key is wrong
    // whether or not you're reading the hover hints. The bar itself counts as
    // "still on the chart", so the pointer can travel out to it.
    if (charts?.length && !(e.target as HTMLElement).closest?.('.jp-chords')) {
      if (!chartRectsRef.current) {
        const of = new Map<number, number>();      // annotation index → chart
        annotations.forEach((a, ai) => {
          if (a.cls !== 'chordsym') return;
          const i = charts.findIndex(c => a.start >= c.start && a.end <= c.end);
          if (i >= 0) of.set(ai, i);
        });
        const band = new Map<number, { i: number; top: number; bottom: number }>();
        for (const el of Array.from(mirror.querySelectorAll<HTMLElement>('span[data-ai]'))) {
          const i = of.get(Number(el.dataset.ai));
          if (i == null) continue;
          const r = el.getBoundingClientRect();
          const had = band.get(i);
          if (!had) band.set(i, { i, top: r.top, bottom: r.bottom });
          else { had.top = Math.min(had.top, r.top); had.bottom = Math.max(had.bottom, r.bottom); }
        }
        chartRectsRef.current = Array.from(band.values());
      }
      const on = chartRectsRef.current.find(c => y >= c.top && y <= c.bottom);
      if (!on) { setChartHot(null); setChartErr(null); }
      else if (on.i !== chartHot?.i) {
        // Level with the chart's first line, clamped inside the pane — a long
        // form can start above the top of the view.
        setChartHot({ i: on.i, top: Math.max(2, Math.min(on.top - box.top, box.height - BAR_H - 2)) });
        setChartErr(null);
      }
    }

    if (!explain) { setHint(null); setHotIdx(-1); return; }

    if (!rectsRef.current) {
      const spans = Array.from(mirror.querySelectorAll<HTMLElement>('span[data-ai]'));
      rectsRef.current = spans.map(s => {
        const ai = Number(s.dataset.ai);
        return { rect: s.getBoundingClientRect(), ann: annotations[ai], ai };
      }).filter(r => r.ann);
    }

    const found = rectsRef.current.find(r =>
      x >= r.rect.left && x <= r.rect.right && y >= r.rect.top && y <= r.rect.bottom);

    if (!found) { setHint(null); setHotIdx(-1); return; }
    setHotIdx(found.ai);

    // Park the bubble above the glyph, centred on it — flipping below when
    // it's the top line and there's no room.
    const below = found.rect.top - box.top < 34;
    setHint({
      label: found.ann.label,
      detail: found.ann.detail,
      left: found.rect.left + found.rect.width / 2 - box.left,
      top: below ? found.rect.bottom - box.top + 6 : found.rect.top - box.top - 6,
      below,
    });
  }, [explain, annotations, marks, charts, chartHot?.i]);

  useEffect(() => { if (!explain) { setHint(null); setHotIdx(-1); } }, [explain]);

  // Keep the bubble inside the editor box. It's centred on the glyph, so near
  // either edge half of it would hang outside — and .jp-ed clips its overflow,
  // so "outside" means invisible. Measured after render, because the width
  // depends on the text.
  useLayoutEffect(() => {
    const el = hintRef.current, wrap = wrapRef.current;
    if (!el || !wrap || !hint) return;
    const boxW = wrap.clientWidth, boxH = wrap.clientHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    const half = w / 2;
    // Wider than the pane: give up on centring and pin it to the left.
    const left = w >= boxW - 8 ? half + 4 : Math.min(Math.max(hint.left, half + 4), boxW - half - 4);
    el.style.left = `${left}px`;
    // And flip/clamp vertically if the chosen side has no room.
    let top = hint.top;
    if (!hint.below && top - h < 2) top = hint.top + h + 12;        // no room above → below
    else if (hint.below && top + h > boxH - 2) top = Math.max(h + 2, hint.top - 12);
    el.style.top = `${top}px`;
  }, [hint]);

  return (
    <div
      class={`jp-ed${explain ? ' explain' : ''}`}
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => { setHint(null); setHotIdx(-1); setChartHot(null); setChartErr(null); }}
    >
      <pre class="jp-ed-layer jp-ed-mirror" ref={mirrorRef} aria-hidden="true">
        <div class="jp-ed-ink" ref={inkRef}>
        {pieces.map((p, i) => {
          const cls = [
            p.ann ? `jp-t jp-t-${p.ann.cls}` : '',
            p.ann && p.ai === hotIdx ? 'is-hot' : '',
            p.hot ? 'is-picked' : '',
            // Only the chart's own characters, so the wash draws the shape of
            // the thing the bar is about to move rather than a block of lines.
            hotChart && p.ann?.cls === 'chordsym'
              && p.start >= hotChart.start && p.start < hotChart.end ? 'is-chart' : '',
            p.di != null ? `jp-flaw jp-flaw-${p.dk}` : '',
          ].filter(Boolean).join(' ');
          return (
            <span key={i} class={cls || undefined} data-ai={p.ann ? p.ai : undefined} data-di={p.di}>
              {p.text}
            </span>
          );
        })}
        </div>
      </pre>
      <textarea
        class="jp-ed-layer jp-ed-area"
        ref={areaRef}
        value={text}
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        wrap="off"
        aria-label="Transcription source"
        placeholder={'1=C 4/4\n1 2 3 4 5 6 7 1&apos;'}
        onInput={e => { onChange((e.target as HTMLTextAreaElement).value); invalidate(); }}
        onScroll={syncScroll}
        onKeyDown={(e: KeyboardEvent) => {
          // alt+[ and alt+] step through the notes — or through the chords,
          // in a chord chart — sounding each one. They're the audition: hear
          // it, move past it, hear the next.
          //
          // Matched on the physical key, because e.key isn't a bracket by the
          // time it gets here: on a Mac, alt+[ and alt+] are the typographic
          // quote marks “ and ‘, and the same is true of every other alt
          // shortcut in the app.
          const bracket = e.code === 'BracketLeft' ? -1 : e.code === 'BracketRight' ? 1 : 0;
          if (bracket && e.altKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            const ta = areaRef.current;
            if (ta && onStep) onStep(bracket > 0 ? 1 : -1, ta.selectionStart ?? 0);
            return;
          }
          // alt+← and alt+→ walk the caret a token at a time. They're the
          // word keys, taken over because Chrome's word-LEFT won't leave the
          // line it started on — press it at the head of a line and the caret
          // just sits there, while word-right crosses into the next line
          // happily. Both cross here, so the pair is symmetric.
          //
          // A "token" is a run of non-space, which is the unit this source is
          // actually written in: 1' and 3=[ step as one thing rather than
          // stranding the caret inside a note. Shift extends the selection the
          // way it does for every other caret key.
          const arrow = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0;
          if (arrow && e.altKey && !e.metaKey && !e.ctrlKey) {
            const ta = areaRef.current;
            if (ta) {
              e.preventDefault();
              const back = ta.selectionDirection === 'backward';
              const anchor = (back ? ta.selectionEnd : ta.selectionStart) ?? 0;
              const head = e.shiftKey
                ? (back ? ta.selectionStart : ta.selectionEnd) ?? 0
                : (arrow < 0 ? ta.selectionStart : ta.selectionEnd) ?? 0;
              const to = tokenStep(text, head, arrow > 0 ? 1 : -1);
              if (e.shiftKey && to !== anchor) {
                ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
              } else {
                ta.setSelectionRange(to, to);
              }
              caretIntoView(ta, text, to);
              syncScroll();
              return;
            }
          }
          // alt+\ plays on from the caret — the brackets audition one note,
          // this one lets the passage run. Next to them on the keyboard for
          // the same reason they're next to each other in the head.
          if (e.code === 'Backslash' && e.altKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            const ta = areaRef.current;
            if (ta && onPlayFromCaret) onPlayFromCaret(ta.selectionStart ?? 0);
            return;
          }
          onEditorKeyDown(e);
        }}
      />
      {hint && (
        <div
          class={`jp-ed-hint${hint.below ? ' below' : ''}${hint.kind ? ` flaw ${hint.kind}` : ''}`}
          ref={hintRef}
          style={`left:${hint.left}px; top:${hint.top}px`}
          role="tooltip"
        >
          <b>{hint.label}</b>
          {hint.detail && <i>{hint.detail}</i>}
        </div>
      )}
      {/* One row, pinned to the same right edge as the selection menu — and
          out of the way when that one is open, since they'd sit on top of each
          other and the selection is the more deliberate of the two. */}
      {respell && hotChart && !menu && (
        <div
          class="jp-chords"
          style={`top:${chartHot?.top ?? 2}px`}
          onMouseDown={(e: MouseEvent) => e.preventDefault()}
        >
          <span class={`jp-respell-label${chartErr ? ' bad' : ''}`}>{chartErr ?? 'chords'}</span>
          <button
            type="button"
            class="jp-key-chip"
            data-hint="down a ½ step"
            aria-label="Move this chord chart down a semitone"
            onClick={() => shiftChart(-1)}
          >−1</button>
          <button
            type="button"
            class="jp-key-chip"
            data-hint="up a ½ step"
            aria-label="Move this chord chart up a semitone"
            onClick={() => shiftChart(1)}
          >+1</button>
          {(() => {
            const toRoman = respell.toRoman(hotChart.start, hotChart.end);
            return (
              <button
                type="button"
                class="jp-key-chip"
                data-hint={toRoman ? 'as numerals' : 'as letters'}
                aria-label={toRoman ? 'Rewrite this chart as roman numerals' : 'Rewrite this chart as letter chords'}
                onClick={() => shiftChart('roman')}
              >{toRoman ? 'II V' : 'C G'}</button>
            );
          })()}
        </div>
      )}
      {respell && sel && menu && (
        <div
          class="jp-respell"
          ref={menuRef as any}
          style={`top:${menu.top}px`}
          // Keep the caret where it is when a chip is pressed; the input is
          // the one child that genuinely wants the focus.
          onMouseDown={(e: MouseEvent) => {
            if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
          }}
        >
          {/* Two lines, two different trades. The first keeps every pitch and
              renumbers it; the second keeps every number and moves the pitch.
              Whatever goes wrong is said in place of whichever label asked for
              it, so a refusal is read where the decision was made. */}
          <div class="jp-respell-row">
            <span class={`jp-respell-label${problem?.row === 'key' ? ' bad' : ''}`}>
              {problem?.row === 'key' ? problem.msg : 'respell in'}
            </span>
            {respell.choices.map(c => {
              const cur = respell.currentAt(sel.start) === c.spec;
              return (
                <button
                  key={c.spec}
                  type="button"
                  class={`jp-key-chip${cur ? ' is-cur' : ''}`}
                  data-hint={cur ? 'already this key' : `same notes, numbered from ${c.name}`}
                  aria-label={`Respell the selection in ${c.name}`}
                  disabled={cur}
                  onClick={() => applyRespell(c.spec)}
                >{c.name}</button>
              );
            })}
            <input
              class="jp-respell-in"
              value={spec}
              placeholder="key"
              spellcheck={false}
              autocomplete="off"
              size={4}
              aria-label="Another key centre, e.g. Eb or F#m"
              data-hint="any key — Eb, F#m"
              onInput={(e: Event) => setSpec((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') { e.preventDefault(); applyRespell(spec); }
                else if (e.key === 'Escape') { e.preventDefault(); setSel(null); areaRef.current?.focus(); }
              }}
            />
          </div>
          <div class="jp-respell-row">
            <span class={`jp-respell-label${problem?.row === 'semis' ? ' bad' : ''}`}>
              {problem?.row === 'semis' ? problem.msg : 'transpose'}
            </span>
            <button
              type="button"
              class="jp-key-chip"
              data-hint="down a ½ step"
              aria-label="Transpose the selection down a semitone"
              onClick={() => applyTranspose(-1)}
            >−1</button>
            <button
              type="button"
              class="jp-key-chip"
              data-hint="up a ½ step"
              aria-label="Transpose the selection up a semitone"
              onClick={() => applyTranspose(1)}
            >+1</button>
            <input
              class="jp-respell-in"
              value={semis}
              placeholder="±"
              spellcheck={false}
              autocomplete="off"
              size={3}
              inputMode="numeric"
              aria-label="Semitones to transpose the selection by"
              data-hint="semitones — 2, -5"
              onInput={(e: Event) => setSemis((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') { e.preventDefault(); applyTranspose(parseInt(semis, 10)); }
                else if (e.key === 'Escape') { e.preventDefault(); setSel(null); areaRef.current?.focus(); }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Write into the textarea through the browser's OWN editing pipeline, so the
// edit lands on the native undo stack and ⌘Z steps back over it normally.
//
// Assigning to textarea.value instead — which is what a plain onChange +
// re-render does — silently clears that element's undo history, so the next
// ⌘Z jumps past everything typed before the insert (or does nothing at all).
// execCommand is deprecated but it remains the only way to make a programmatic
// edit undoable, and every current browser still implements insertText.
// It fires a real `input` event, so the controlled value updates itself and
// the fallback only runs where the command genuinely isn't available.
function typeInto(ta: HTMLTextAreaElement, payload: string, fallback: () => void) {
  let ok = false;
  try { ok = document.execCommand('insertText', false, payload); } catch { ok = false; }
  if (ok) return;
  fallback();
}

// ⌘/ (ctrl+/) comments the selected lines out, or brings them back if they're
// already commented — the editor reflex, on jianpu-ly's own % comment.
//
// The whole block is rewritten in one insertText so ⌘Z takes it back in a
// single step, and blank lines are left as they are: a % on nothing is noise,
// and skipping them means an indented passage keeps its shape.
const COMMENT_RE = /^(\s*)%[ \t]?/;

function toggleComment(ta: HTMLTextAreaElement) {
  const { value, selectionStart: s, selectionEnd: t } = ta;
  const from = value.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
  // A selection that stops exactly at a line start hasn't touched that line.
  const lastCh = t > s && value[t - 1] === '\n' ? t - 1 : t;
  let to = value.indexOf('\n', lastCh);
  if (to < 0) to = value.length;

  const lines = value.slice(from, to).split('\n');
  const live = lines.filter(l => l.trim());
  if (!live.length) return;

  let out: string;
  if (live.every(l => COMMENT_RE.test(l))) {
    out = lines.map(l => l.replace(COMMENT_RE, '$1')).join('\n');
  } else {
    // Comment at the shallowest indent in the block, so the % marks line up.
    const indent = Math.min(...live.map(l => (/^\s*/.exec(l) as RegExpExecArray)[0].length));
    out = lines.map(l => (l.trim() ? l.slice(0, indent) + '% ' + l.slice(indent) : l)).join('\n');
  }

  const first = lines[0];
  const firstOut = out.slice(0, out.indexOf('\n') < 0 ? out.length : out.indexOf('\n'));
  const shift = firstOut.length - first.length;

  ta.setSelectionRange(from, to);
  typeInto(ta, out, () => {
    ta.value = value.slice(0, from) + out + value.slice(to);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // A selection keeps the same lines selected; a bare caret stays put on its
  // own line, riding the % that just went in or came out.
  if (t > s) ta.setSelectionRange(from, from + out.length);
  else ta.setSelectionRange(Math.max(from, s + shift), Math.max(from, s + shift));
}

// Tab indents instead of leaving the field — this is a code-ish editor and the
// pane order is already reachable with the browser's own focus ring elsewhere.
function onEditorKeyDown(e: KeyboardEvent) {
  if (e.key === '/' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    toggleComment(e.target as HTMLTextAreaElement);
    return;
  }
  if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  const ta = e.target as HTMLTextAreaElement;
  const { selectionStart: s, selectionEnd: t, value } = ta;
  typeInto(ta, '  ', () => {
    ta.value = value.slice(0, s) + '  ' + value.slice(t);
    ta.selectionStart = ta.selectionEnd = s + 2;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// The on-screen boxes of a character range, measured on the mirror. A textarea
// won't tell you where its selection is, but the mirror holds the same text in
// the same font at the same scroll offset — so a DOM Range over it answers the
// question exactly. One box per line the range covers (per run within a line,
// since the mirror is spans), which is what says whether something laid over
// the pane would land on any of it.
function rangeRects(mirror: HTMLElement, from: number, to: number): DOMRect[] {
  const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let started = false;
  let ended = false;
  for (let n = walker.nextNode(); n && !ended; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (!started && pos + len >= from) { r.setStart(n, from - pos); started = true; }
    if (started && pos + len >= to) { r.setEnd(n, to - pos); ended = true; }
    pos += len;
  }
  if (!started) return [];
  if (!ended) r.setEndAfter(mirror);
  return Array.from(r.getClientRects());
}

// Slice the source into alternating annotated / plain runs. The trailing
// newline keeps the mirror's last line the same height as the textarea's, so
// the two never drift apart at the bottom.
function buildPieces(text: string, annotations: Annotation[]): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i];
    if (a.start < pos) continue;                  // defensive: parser dedupes
    if (a.start > pos) out.push({ text: text.slice(pos, a.start), ann: null, ai: -1, start: pos });
    out.push({ text: text.slice(a.start, a.end), ann: a, ai: i, start: a.start });
    pos = a.end;
  }
  out.push({ text: text.slice(pos) + '\n', ann: null, ai: -1, start: pos });
  return out;
}

// Cut the runs again at a span's edges, tagging the pieces that fall inside it.
// The spans coming in are whole tokens, so in practice this splits at most two
// pieces — but it has to be exact, since the mark is what tells you which
// characters the wash or the squiggle is about.
function cut(pieces: Piece[], span: Span, tag: (p: Piece) => Piece): Piece[] {
  if (span.end <= span.start) return pieces;
  const out: Piece[] = [];
  for (const p of pieces) {
    const end = p.start + p.text.length;
    if (end <= span.start || p.start >= span.end) { out.push(p); continue; }
    const cuts = [p.start, Math.max(p.start, span.start), Math.min(end, span.end), end];
    for (let i = 0; i < 3; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      if (b <= a) continue;
      const piece = { ...p, start: a, text: p.text.slice(a - p.start, b - p.start) };
      out.push(i === 1 ? tag(piece) : piece);
    }
  }
  return out;
}

function markFocus(pieces: Piece[], focus?: Span | null): Piece[] {
  if (!focus) return pieces;
  return cut(pieces, focus, p => ({ ...p, hot: true }));
}

// One pass per flaw. They rarely overlap, and where two do the later one's
// squiggle simply wins the shared characters — its message is the one that
// hover reports there.
function markFlaws(pieces: Piece[], marks: Flaw[]): Piece[] {
  let out = pieces;
  marks.forEach((m, di) => { out = cut(out, m.span, p => ({ ...p, di, dk: m.kind })); });
  return out;
}

// One token's worth of caret motion, in the direction given: over any space
// first, then over the run of non-space that follows it. Newlines are space
// like any other, which is the whole point — stepping back off the head of a
// line lands on the last token of the line above.
function tokenStep(text: string, at: number, dir: 1 | -1): number {
  const space = (i: number) => /\s/.test(text.charAt(i));
  let i = Math.max(0, Math.min(at, text.length));
  if (dir > 0) {
    while (i < text.length && space(i)) i++;
    while (i < text.length && !space(i)) i++;
  } else {
    while (i > 0 && space(i - 1)) i--;
    while (i > 0 && !space(i - 1)) i--;
  }
  return i;
}

// Keep the caret on screen after a jump we made ourselves. The textarea only
// scrolls for motion IT performed, so a step that crossed a line boundary can
// leave the caret just off the top or bottom. Scroll by the least that brings
// its line back — stepping through the source shouldn't heave the view around
// the way a jump from the notation deliberately does.
function caretIntoView(ta: HTMLTextAreaElement, text: string, at: number) {
  const lh = parseFloat(getComputedStyle(ta).lineHeight);
  if (Number.isNaN(lh) || lh <= 0) return;
  let line = 0;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === '\n') line++;
  const top = line * lh;
  if (top < ta.scrollTop) ta.scrollTop = top;
  else if (top + lh > ta.scrollTop + ta.clientHeight) ta.scrollTop = top + lh - ta.clientHeight;
}

// The span to actually draw a squiggle over. Diagnostics are clamped to the
// text they're about to be measured against, and one with nothing to point at
// (an empty span — the engraver's "this chord never landed anywhere") opens
// out to the line it fell on, minus its indent.
function drawable(span: Span, text: string): Span {
  const start = Math.max(0, Math.min(span.start, text.length));
  const end = Math.max(start, Math.min(span.end, text.length));
  if (end > start) return { start, end };
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let to = text.indexOf('\n', from);
  if (to < 0) to = text.length;
  const lead = /^[ \t]*/.exec(text.slice(from, to)) as RegExpExecArray;
  return { start: from + lead[0].length, end: to };
}
