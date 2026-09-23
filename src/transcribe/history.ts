// Checkpoints: the document as it stood at moments worth going back to.
//
// Not an undo stack. An undo stack answers "take back the last thing I did",
// which the textarea already does; this answers "what did this look like
// before I spent an hour on it", which nothing does. That difference decides
// everything below.
//
// WHAT GETS CAPTURED — moments, not keystrokes:
//   • the end of a burst of typing (a settled edit session, one checkpoint);
//   • the state just BEFORE anything bulk — a respell, an import, a syntax
//     migration, a restore — which gets a label saying so;
//   • whatever you pin by hand.
// A capture whose text matches the newest one for that document is dropped,
// so idling doesn't manufacture history.
//
// WHAT GETS KEPT — thinning, so old history costs almost nothing:
//   everything from the last hour, then one an hour for a day, one a day for
//   a month, one a month beyond that. What survives is spaced the way memory
//   is: dense near now, sparse further back.
//
// WHAT NEVER GETS THINNED — anything labelled or pinned. Those are the ones
// you actually reach for, and they're the ones an automatic rule is worst at
// judging. Restoring is the sharpest case: it captures where you were first,
// labelled, so the restore is itself undoable and the history it came from
// stays whole. Nothing here ever deletes a branch of your work to make room
// for another — a restore only ever ADDS.

import { Doc } from './types';
import { parseJianpu } from './parse';

const KEY = 'transcribe.history.v1';

// A compact description of a version, worked out once at capture time so the
// list can say what changed without re-parsing every checkpoint on every
// render.
export type Stat = {
  notes: number;
  bars: number;
  chars: number;
  key?: string;
  tempo?: number;
};

export type Checkpoint = {
  id: string;
  docId: string;
  at: number;           // epoch ms
  text: string;
  stat: Stat;
  label?: string;       // set on the ones that matter: "before respell to Eb"
  pinned?: boolean;     // kept by hand, never thinned, always synced
};

// Roughly how much of localStorage the whole history may occupy. Well under
// the usual 5 MB, because losing the LIBRARY to a quota error while saving
// its history would be a spectacular own goal.
const BYTE_CAP = 1_200_000;
// Automatic checkpoints per document, after thinning.
const PER_DOC_CAP = 40;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let seq = 0;

export function load(): Checkpoint[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return coerce(raw);
  } catch { return []; }
}

export function save(list: Checkpoint[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Out of room: drop the automatic half and try once more. Labelled and
    // pinned checkpoints are the ones worth keeping under pressure.
    try { localStorage.setItem(KEY, JSON.stringify(list.filter(keep))); } catch { /* give up */ }
  }
}

export function coerce(raw: unknown): Checkpoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(c => c && typeof (c as any).text === 'string' && typeof (c as any).docId === 'string')
    .map(c => {
      const o = c as any;
      const cp: Checkpoint = {
        id: String(o.id ?? `c${o.at}`),
        docId: String(o.docId),
        at: Number(o.at) || 0,
        text: String(o.text),
        stat: statOf(o.stat && typeof o.stat === 'object' ? o.stat : null, String(o.text)),
      };
      if (o.label) cp.label = String(o.label);
      if (o.pinned) cp.pinned = true;
      return cp;
    })
    .sort((a, b) => b.at - a.at);
}

// ── capturing ────────────────────────────────────────────────────────

export type CaptureOpts = { label?: string; pinned?: boolean; at?: number };

// Add a checkpoint and return the thinned list. Returns the list UNCHANGED
// when there's nothing new to record, so callers can skip the write.
export function capture(list: Checkpoint[], doc: Doc, opts: CaptureOpts = {}): Checkpoint[] {
  const text = doc.text;
  if (!text.trim()) return list;
  const newest = list.find(c => c.docId === doc.id);
  // Same text as last time: nothing happened. A label still counts as new
  // information about this moment, though — "before respell" on a version
  // already captured is worth keeping, so promote the existing one instead of
  // writing a duplicate.
  if (newest && newest.text === text) {
    if (!opts.label && !opts.pinned) return list;
    if (newest.label === opts.label && (!opts.pinned || newest.pinned)) return list;
    // First label wins. Both describe the same text, and the earlier one is
    // the reason this version was kept in the first place.
    return list.map(c => (c === newest
      ? { ...c, label: c.label ?? opts.label, pinned: opts.pinned || c.pinned }
      : c));
  }
  const at = opts.at ?? Date.now();
  const cp: Checkpoint = {
    id: `h${at.toString(36)}${++seq}`,
    docId: doc.id,
    at,
    text,
    stat: measure(text),
  };
  if (opts.label) cp.label = opts.label;
  if (opts.pinned) cp.pinned = true;
  return thin([cp, ...list]);
}

export function setPinned(list: Checkpoint[], id: string, pinned: boolean): Checkpoint[] {
  return thin(list.map(c => (c.id === id ? { ...c, pinned } : c)));
}

// ── thinning ─────────────────────────────────────────────────────────

function keep(c: Checkpoint): boolean {
  return !!(c.pinned || c.label);
}

// Which time bucket a checkpoint falls in, given how old it is. One survivor
// per bucket — the newest, since that's the state the session ended in.
//
// The buckets get coarser with age on purpose: an hour ago you want the
// individual attempts, last month you want "roughly how it stood".
function bucket(age: number): string {
  if (age < HOUR) return `m${Math.floor(age / MINUTE)}`;   // everything, effectively
  if (age < DAY) return `h${Math.floor(age / HOUR)}`;      // one an hour
  if (age < 30 * DAY) return `d${Math.floor(age / DAY)}`;  // one a day
  return `M${Math.floor(age / (30 * DAY))}`;               // one a month
}

export function thin(list: Checkpoint[], now = Date.now()): Checkpoint[] {
  const sorted = list.slice().sort((a, b) => b.at - a.at);
  const out: Checkpoint[] = [];
  const seen = new Map<string, number>();   // docId+bucket → count
  const perDoc = new Map<string, number>();

  for (const c of sorted) {
    if (keep(c)) { out.push(c); continue; }
    const b = `${c.docId}${bucket(Math.max(0, now - c.at))}`;
    if (seen.has(b)) continue;                    // an older twin in this bucket
    const n = perDoc.get(c.docId) ?? 0;
    if (n >= PER_DOC_CAP) continue;
    seen.set(b, 1);
    perDoc.set(c.docId, n + 1);
    out.push(c);
  }

  out.sort((a, b) => b.at - a.at);
  return capBytes(out);
}

// A last resort on total size: shed the oldest automatic checkpoints until
// the whole history fits. Labelled and pinned ones are never shed here —
// if they alone exceed the cap, that's a library worth keeping.
function capBytes(list: Checkpoint[]): Checkpoint[] {
  let size = list.reduce((n, c) => n + c.text.length + 120, 0);
  if (size <= BYTE_CAP) return list;
  const out = list.slice();
  for (let i = out.length - 1; i >= 0 && size > BYTE_CAP; i--) {
    if (keep(out[i])) continue;
    size -= out[i].text.length + 120;
    out.splice(i, 1);
  }
  return out;
}

// ── merging (two devices, or a cloud row) ────────────────────────────
export function merge(a: Checkpoint[], b: Checkpoint[]): Checkpoint[] {
  const by = new Map<string, Checkpoint>();
  for (const c of [...a, ...b]) {
    const prev = by.get(c.id);
    // A pin or a label set on one side wins — both are deliberate acts.
    by.set(c.id, prev
      ? { ...prev, label: prev.label ?? c.label, pinned: prev.pinned || c.pinned }
      : c);
  }
  return thin(Array.from(by.values()));
}

// Only the deliberate ones travel to the cloud. The automatic ones are bulky,
// device-local by nature, and the least missed.
export function worthSyncing(list: Checkpoint[]): Checkpoint[] {
  return list.filter(keep);
}

// ── describing a version ─────────────────────────────────────────────

function measure(text: string): Stat {
  const stat: Stat = { notes: 0, bars: 0, chars: text.length };
  try {
    const score = parseJianpu(text);
    for (const mv of score.movements) {
      for (const it of mv.items) {
        if (it.kind === 'note') stat.notes++;
        else if (it.mark.t === 'bar') stat.bars++;
      }
      if (mv.tempo && stat.tempo == null) stat.tempo = mv.tempo.bpm;
    }
    const first = score.movements[0];
    if (first) stat.key = first.keySig.label;
    // The last bar of a movement usually has no barline after it.
    stat.bars += score.movements.length;
  } catch { /* a stat is a nicety; never let it stop a capture */ }
  return stat;
}

function statOf(raw: any, text: string): Stat {
  if (!raw) return measure(text);
  return {
    notes: Number(raw.notes) || 0,
    bars: Number(raw.bars) || 0,
    chars: Number(raw.chars) || text.length,
    key: raw.key ? String(raw.key) : undefined,
    tempo: raw.tempo != null ? Number(raw.tempo) : undefined,
  };
}

// What changed between this checkpoint and the one before it — the line that
// makes a list of timestamps recognisable. Terse on purpose: "+6 bars" tells
// you which one you're looking for, a full diff doesn't.
export function describe(cp: Checkpoint, older: Checkpoint | undefined): string {
  if (!older) return `${cp.stat.bars} bar${cp.stat.bars === 1 ? '' : 's'}`;
  const bits: string[] = [];
  const dBars = cp.stat.bars - older.stat.bars;
  const dNotes = cp.stat.notes - older.stat.notes;
  if (dBars) bits.push(`${sign(dBars)} bar${Math.abs(dBars) === 1 ? '' : 's'}`);
  else if (dNotes) bits.push(`${sign(dNotes)} note${Math.abs(dNotes) === 1 ? '' : 's'}`);
  if (cp.stat.key && cp.stat.key !== older.stat.key) bits.push(`key → ${cp.stat.key.replace(/^1=/, '')}`);
  if (cp.stat.tempo !== older.stat.tempo && cp.stat.tempo != null) bits.push(`${cp.stat.tempo} bpm`);
  if (!bits.length) {
    const d = cp.stat.chars - older.stat.chars;
    bits.push(d ? `${sign(d)} char${Math.abs(d) === 1 ? '' : 's'}` : 'edited');
  }
  return bits.join(' · ');
}

function sign(n: number): string {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

// "just now", "18 min", "2 h", "3 d" — short enough for a narrow rail.
export function ago(at: number, now = Date.now()): string {
  const d = Math.max(0, now - at);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} d`;
  return `${Math.floor(d / (30 * DAY))} mo`;
}
