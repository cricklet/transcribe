// Transcribe — keeping the marks in the source numbered the way the
// recording's bookmarks are.
//
// An `M1` in the text and the first bookmark on the strip are two ends of one
// place: alt+1 moves both. That only holds while the numbering does, and the
// bookmarks are numbered by WHERE THEY FALL — put one earlier in the song and
// everything after it counts one higher. So a bookmark added or dropped
// rewrites the M numbers to match, and dropping one takes its mark with it,
// since a mark pointing at a bookmark that no longer exists is a mark you can
// never reach.
//
// A run of bookmarks dropped together is one rewrite, not one per mark: each
// would be computed against the same text and only the last would land.
//
// The spans come from the parser, which is the only thing that knows an M1 in
// the music from an M1 in a lyric — nothing here reads the text to find them.

import { SourceMark, Span } from './types';

// One rewrite of the source: a mark's characters, and what goes in their place
// (null to take the mark out altogether).
type Edit = { span: Span; to: string | null };

// A bookmark was inserted as the nth: every mark from n on is now one later.
export function withMarkAdded(text: string, marks: SourceMark[], n: number): string {
  return apply(text, marks
    .filter(m => m.n >= n)
    .map(m => ({ span: m.span, to: `M${m.n + 1}` })));
}

// Bookmarks `from` through `to` were dropped — one of them or a run of them,
// which is the same operation with the same answer: their own marks go with
// them, and every mark after them comes back by however many went.
export function withMarksDropped(text: string, marks: SourceMark[], from: number, to: number): string {
  const gone = to - from + 1;
  return apply(text, marks
    .filter(m => m.n >= from)
    .map(m => ({ span: m.span, to: m.n <= to ? null : `M${m.n - gone}` })));
}

// Whether either of the above would actually change anything — so a bookmark
// dropped from a transcription that never marked it doesn't checkpoint the
// history and announce a renumbering that didn't happen.
export function touchesMarks(marks: SourceMark[], n: number): boolean {
  return marks.some(m => m.n >= n);
}

// The edits, applied back to front so each one lands on the offsets the parser
// actually reported.
function apply(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    if (e.to != null) { out = out.slice(0, e.span.start) + e.to + out.slice(e.span.end); continue; }
    const cut = widen(out, e.span);
    out = out.slice(0, cut.start) + out.slice(cut.end);
  }
  return out;
}

// What to take out along with a mark that's going. A word removed from the
// middle of a line has to take one of the spaces around it or it leaves a gap
// where it stood; a word that WAS the line takes the line, since a blank line
// is not nothing in this language — it ends a block.
function widen(text: string, span: Span): Span {
  const from = text.lastIndexOf('\n', Math.max(0, span.start - 1)) + 1;
  let to = text.indexOf('\n', span.end);
  if (to < 0) to = text.length;
  const rest = text.slice(from, span.start) + text.slice(span.end, to);
  // Nothing but the mark on it: the line goes, newline and all. The LAST line
  // of the file has no newline of its own, so it takes the one in front.
  if (!rest.trim()) {
    return to < text.length ? { start: from, end: to + 1 } : { start: Math.max(0, from - 1), end: to };
  }
  if (text[span.end] === ' ' || text[span.end] === '\t') return { start: span.start, end: span.end + 1 };
  if (text[span.start - 1] === ' ' || text[span.start - 1] === '\t') {
    return { start: span.start - 1, end: span.end };
  }
  return span;
}
