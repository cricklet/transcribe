// Persistence for the transcription library. Everything lives in this
// browser's localStorage — there is no server. Back up with ⌘S (one document)
// or "export" (everything, songs included) and import by dropping the file on
// the page. The audio itself is in IndexedDB; see songs.ts.

import { ChordFont, ChordView, Doc, DocSort, Side, VOICES, VoiceMix } from './types';
import * as H from './history';
import { migrateDoc, SYNTAX_VERSION } from './migrate';

const DOCS_KEY = 'transcribe.docs.v1';
const CURRENT_KEY = 'transcribe.current.v1';
const EXPLAIN_KEY = 'transcribe.explain.v1';
const PANE_W_KEY = 'transcribe.paneWidth.v1';
const PANE_H_KEY = 'transcribe.paneHeight.v1';
const RAIL_W_KEY = 'transcribe.railWidth.v1';
const RAIL_H_KEY = 'transcribe.railHeight.v1';
const SONG_H_KEY = 'transcribe.songStripHeight.v1';
const SIDE_KEY = 'transcribe.side.v1';
const SONG_KEY = 'transcribe.songOpen.v1';
const CLICK_PLAY_KEY = 'transcribe.clickPlay.v1';
const TOMBS_KEY = 'transcribe.tombs.v1';
const NUMBERS_KEY = 'transcribe.numbers.v1';
const ROMAN_KEY = 'transcribe.romanChords.v1';
const SORT_KEY = 'transcribe.docSort.v1';
const MIDI_KEY = 'transcribe.midiOn.v1';
// One remembered face per VIEW: a staff of engraved notes and a page of
// numbers want different things, and switching between them shouldn't cost
// you the choice you made in the other.
const CHORD_FONT_KEY: Record<ChordView, string> = {
  staff: 'transcribe.chordFont.staff.v1',
  numbers: 'transcribe.chordFont.numbers.v1',
};
// What the single setting was called before it split in two. It seeds both,
// so whichever face was on screen stays on screen.
const CHORD_FONT_WAS = 'transcribe.chordFont.v1';

// These keys used to be jianpu.*. Copy anything still under the old names
// across once, so renaming the app doesn't orphan a saved library.
const RENAMED: [string, string][] = [
  [DOCS_KEY, 'jianpu.docs.v1'],
  [CURRENT_KEY, 'jianpu.current.v1'],
  [EXPLAIN_KEY, 'jianpu.explain.v1'],
  [PANE_W_KEY, 'jianpu.paneWidth.v1'],
  [PANE_H_KEY, 'jianpu.paneHeight.v1'],
];
try {
  for (const [now, before] of RENAMED) {
    if (localStorage.getItem(now) == null) {
      const v = localStorage.getItem(before);
      if (v != null) localStorage.setItem(now, v);
    }
  }
} catch { /* ignore */ }

export function loadDocs(): Doc[] {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    if (!raw) return [];
    return coerceDocs(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

export function saveDocs(docs: Doc[]): void {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs));
  } catch { /* ignore */ }
}

// Folders are gone; so are the local keys they left behind.
try {
  localStorage.removeItem('transcribe.folders.v1');
  localStorage.removeItem('transcribe.expanded.v1');
} catch { /* ignore */ }

export function loadCurrentId(): string | null {
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
}

export function saveCurrentId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch { /* ignore */ }
}

// The editor pane's size, kept per layout: side-by-side panes remember a
// WIDTH, the stacked narrow layout remembers a HEIGHT. Two keys, because
// dragging one shouldn't disturb the other when you resize the window back.
// Every dragged-out size in the app, one key each: the source pane and the
// transcriptions rail (a width side by side, a height stacked), and the song
// strip's height. Local — it's about this screen, not the library.
export type PaneSize = 'w' | 'h' | 'railW' | 'railH' | 'song';
const SIZE_KEY: Record<PaneSize, string> = {
  w: PANE_W_KEY, h: PANE_H_KEY, railW: RAIL_W_KEY, railH: RAIL_H_KEY, song: SONG_H_KEY,
};
export function loadPaneSize(axis: PaneSize): number | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY[axis]);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
export function savePaneSize(axis: PaneSize, px: number): void {
  try { localStorage.setItem(SIZE_KEY[axis], String(Math.round(px))); } catch { /* ignore */ }
}

// Which side pane was up beside the notation last time. Three panes used to
// carry an expanded/folded flag each, which could say things the layout
// couldn't mean; this is the one stop the ` rotation is on. Starts on the
// library, which is the only place a first transcription can be made from.
export function loadSide(): Side {
  try {
    const v = localStorage.getItem(SIDE_KEY);
    return v === 'docs' || v === 'source' || v === 'none' ? v : 'docs';
  } catch { return 'docs'; }
}
export function saveSide(side: Side): void {
  try { localStorage.setItem(SIDE_KEY, side); } catch { /* ignore */ }
}

// Whether a plugged-in MIDI keyboard is heard over the page. Local, like the
// rest of these: which keyboard is on this desk, and whether you want it
// sounding while you work, is a fact about the room you're in — the same
// transcription opened on the laptop shouldn't inherit it. On by default, so
// plugging a keyboard in and playing it just works the first time.
export function loadMidiOn(): boolean {
  try { return localStorage.getItem(MIDI_KEY) !== '0'; } catch { return true; }
}
export function saveMidiOn(on: boolean): void {
  try { localStorage.setItem(MIDI_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// The explain-on-hover mode is a local preference — not worth a cloud row.
// The song strip starts folded: it's for the transcriptions that have a
// recording attached, and most don't.
export function loadSongOpen(): boolean {
  return localStorage.getItem(SONG_KEY) === '1';
}

export function saveSongOpen(open: boolean): void {
  try { localStorage.setItem(SONG_KEY, open ? '1' : '0'); } catch { /* ignore */ }
}

export function loadExplain(): boolean {
  try { return localStorage.getItem(EXPLAIN_KEY) === '1'; } catch { return false; }
}
export function saveExplain(on: boolean): void {
  try { localStorage.setItem(EXPLAIN_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// Whether a single click on the staff sounds the note it landed on. On by
// default — the click already means "this note", and hearing it is the point
// of having the samples loaded.
export function loadClickPlay(): boolean {
  try { return localStorage.getItem(CLICK_PLAY_KEY) !== '0'; } catch { return true; }
}
export function saveClickPlay(on: boolean): void {
  try { localStorage.setItem(CLICK_PLAY_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// The numbers view — degrees instead of noteheads, no staff. A way of LOOKING
// at the score rather than anything about the score, so it's a local
// preference like the others, not part of the document.
export function loadNumbers(): boolean {
  try { return localStorage.getItem(NUMBERS_KEY) === '1'; } catch { return false; }
}
export function saveNumbers(on: boolean): void {
  try { localStorage.setItem(NUMBERS_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// Chords as roman numerals (ii V I) instead of letter names — separate from
// the numbers view. Until it's been set, it follows that view, which is what
// used to decide it.
export function loadRoman(): boolean {
  try {
    const v = localStorage.getItem(ROMAN_KEY);
    return v == null ? loadNumbers() : v === '1';
  } catch { return false; }
}
export function saveRoman(on: boolean): void {
  try { localStorage.setItem(ROMAN_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// How the rail orders the library: which column, and which way round. Local:
// it's how you happen to be looking for something on THIS device, not part of
// the library.
const SORT_DEFAULT: DocSort = { by: 'edited', desc: true };
export function loadDocSort(): DocSort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    // The one-button cycle it replaced stored a bare word.
    if (raw === 'recent') return SORT_DEFAULT;
    if (raw === 'oldest') return { by: 'edited', desc: false };
    if (raw === 'name') return { by: 'name', desc: false };
    const o = JSON.parse(raw || 'null');
    if (o && (o.by === 'name' || o.by === 'edited' || o.by === 'bars')) return { by: o.by, desc: !!o.desc };
  } catch { /* ignore */ }
  return SORT_DEFAULT;
}
export function saveDocSort(sort: DocSort): void {
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* ignore */ }
}

// Which face chord symbols are set in. A way of looking, like the rest of
// these — not something about the document.
export function loadChordFont(view: ChordView, fallback: ChordFont): ChordFont {
  try {
    return face(localStorage.getItem(CHORD_FONT_KEY[view]))
      ?? face(localStorage.getItem(CHORD_FONT_WAS))
      ?? fallback;
  } catch { return fallback; }
}
export function saveChordFont(view: ChordView, f: ChordFont): void {
  try { localStorage.setItem(CHORD_FONT_KEY[view], f); } catch { /* ignore */ }
}
function face(v: string | null): ChordFont | null {
  // 'mono' was a third face, retired — chords are set in a proportional face.
  return v === 'jazz' || v === 'plain' ? v : v === 'mono' ? 'plain' : null;
}

// ── where you were ───────────────────────────────────────────────────
//
// A transcription is somewhere you come back to, and the top of it is the
// wrong place to come back to: the caret was part-way through bar 40, the
// notation was scrolled to the system being worked on, and the recording's
// head was parked on the lick you're trying to hear. All four are remembered
// per document — and locally, like the open folders and the pane sizes: where
// you got to on the laptop is not where the phone should open.
export type Place = {
  caret?: number;   // the caret's character offset in the source
  src?: number;     // how far the source pane was scrolled
  score?: number;   // …and the notation
  head?: number;    // seconds into the attached recording
};
const PLACE_KEY = 'transcribe.place.v1';
// Enough to cover everything you're actually working through, bounded so the
// key can't grow for ever. The least recently left place drops off the front.
const PLACE_MAX = 80;

export function loadPlace(id: string): Place | null {
  if (!id) return null;
  try {
    const all = JSON.parse(localStorage.getItem(PLACE_KEY) || '{}');
    const p = all && typeof all === 'object' ? (all as any)[id] : null;
    return p && typeof p === 'object' ? p as Place : null;
  } catch { return null; }
}

export function savePlace(id: string, place: Place): void {
  if (!id) return;
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) || '{}');
    const all: Record<string, Place> = raw && typeof raw === 'object' ? raw : {};
    // Deleting before writing re-inserts the id at the END of the object, so
    // the keys are in the order the documents were last left — which is what
    // makes the trim below drop the one you're least likely to want.
    delete all[id];
    all[id] = place;
    const ids = Object.keys(all);
    for (const stale of ids.slice(0, Math.max(0, ids.length - PLACE_MAX))) delete all[stale];
    localStorage.setItem(PLACE_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

// Read whatever an exported file holds: the "export" backup ({ transcriptions,
// songs }), a bare array, or a single document as ⌘S writes it. Anything unreadable comes back empty rather than
// throwing — an import is a recovery, and it should never be able to make
// things worse than they already are.
//
// Imported documents go through the same coercion and migration as stored
// ones, so a backup taken before a syntax change comes back readable.
export function docsFromJson(raw: unknown): Doc[] {
  // A full backup wraps the list, with the songs beside it.
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).transcriptions)) raw = (raw as any).transcriptions;
  const list = Array.isArray(raw) ? raw : [raw];
  return coerceDocs(list) ?? [];
}

// Pre-images from migrations run during this page load, waiting to be turned
// into checkpoints. Collected here because coercion is the only choke point
// that sees the old text; drained once by the app.
const migrated: { doc: Doc; before: string }[] = [];
export function takeMigrationBackups(): { doc: Doc; before: string }[] {
  return migrated.splice(0, migrated.length);
}

// ── checkpoints ──────────────────────────────────────────────────────
// The history lives in its own localStorage key (history.ts) so a quota
// failure while saving it can never take the library down with it.
export function saveHistory(list: H.Checkpoint[]): void {
  H.save(list);
}

function coerceDocs(raw: unknown): Doc[] | null {
  if (!Array.isArray(raw)) return null;
  const docs = raw
    .filter(d => d && typeof (d as any).text === 'string')
    .map(d => {
      const o = d as any;
      const doc: Doc = {
        id: o.id ? String(o.id) : newId('i'),
        name: String(o.name ?? 'Transcription'),
        // Line endings normalised on the way in. A textarea's value has its
        // own newlines normalised by the browser, so a document arriving with
        // CRLFs would hold characters the textarea doesn't — and every offset
        // the parser reported after the first line would land one character
        // late in the editor.
        text: String(o.text).replace(/\r\n?/g, '\n'),
      };
      if (typeof o.syntax === 'number') doc.syntax = o.syntax;
      if (typeof o.updated === 'number') doc.updated = o.updated;
      if (o.pitching === 'C' || o.pitching === 'Bb') doc.pitching = o.pitching;
      if (typeof o.swing === 'boolean') doc.swing = o.swing;
      const mix = coerceMix(o.mix);
      // playBass was the one-song-one-switch version of the mix, and shipped
      // for about a day. Read it as what it became.
      if (typeof o.playBass === 'boolean' && !mix?.bass) {
        doc.mix = { ...mix, bass: { on: o.playBass } };
      } else if (mix) {
        doc.mix = mix;
      }
      // How the part is READ, in octaves. Clamped rather than trusted: it
      // arrives from the cloud as well as from here, and a wild number would
      // engrave the whole tune off the page.
      if (typeof o.octave === 'number' && Number.isFinite(o.octave)) {
        doc.octave = Math.max(-3, Math.min(3, Math.round(o.octave)));
      }
      if (typeof o.bassOctave === 'number' && Number.isFinite(o.bassOctave)) {
        doc.bassOctave = Math.max(-3, Math.min(3, Math.round(o.bassOctave)));
      }
      const audio = coerceAudio(o.audio);
      if (audio) doc.audio = audio;
      // Every way a document can arrive — the local cache, the cloud row —
      // comes through here, so this is the one place that has to bring an
      // older one up to the language the app now speaks.
      const next = migrateDoc(doc);
      // A migration rewrote the text. Hand the app what it looked like before,
      // so it can be checkpointed — a rewrite you didn't ask for is exactly
      // the kind you want to be able to walk back.
      if (next.text !== doc.text) migrated.push({ doc: next, before: doc.text });
      return next;
    });
  return docs.length ? docs : null;
}

// The three voices' settings, read back defensively — a Doc arrives from the
// cloud as well as from here, and only the fields that make sense are kept.
// Which patch names are real is playback.ts's business, not this file's; it
// checks them against its own lists when it resolves a mix.
function coerceMix(raw: unknown): Doc['mix'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: NonNullable<Doc['mix']> = {};
  for (const v of VOICES) {
    const o = (raw as any)[v];
    if (!o || typeof o !== 'object') continue;
    const one: Partial<VoiceMix> = {};
    if (typeof o.on === 'boolean') one.on = o.on;
    if (typeof o.patch === 'string') one.patch = o.patch;
    if (typeof o.vol === 'number' && Number.isFinite(o.vol)) one.vol = Math.max(0, Math.min(1, o.vol));
    if (Object.keys(one).length) out[v] = one;
  }
  return Object.keys(out).length ? out : null;
}

// The attached recording, read back defensively: it names a row in ANOTHER
// app's library, it arrives from the cloud as well as from here, and a field
// that has gone strange should cost the marks rather than the document.
function coerceAudio(raw: unknown): Doc['audio'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as any;
  if (typeof o.id !== 'string' || !o.id) return null;
  const secs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const audio: NonNullable<Doc['audio']> = { id: o.id };
  const start = secs(o.start);
  if (start != null) audio.start = start;
  if (Array.isArray(o.bookmarks)) {
    audio.bookmarks = o.bookmarks
      .map((b: any) => {
        const at = secs(b?.at);
        if (at == null) return null;
        return typeof b.label === 'string' && b.label ? { at, label: b.label } : { at };
      })
      .filter((b: unknown): b is { at: number; label?: string } => !!b)
      .sort((a: { at: number }, b: { at: number }) => a.at - b.at);
  }
  if (Array.isArray(o.off)) audio.off = o.off.filter((x: unknown) => typeof x === 'string');
  if (o.levels && typeof o.levels === 'object') {
    const levels: Record<string, number> = {};
    for (const [id, v] of Object.entries(o.levels as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) levels[id] = Math.max(0, Math.min(1, v));
    }
    if (Object.keys(levels).length) audio.levels = levels;
  }
  if (typeof o.rate === 'number' && Number.isFinite(o.rate) && o.rate > 0) audio.rate = o.rate;
  if (typeof o.shift === 'number' && Number.isFinite(o.shift) && o.shift) {
    audio.shift = Math.max(-12, Math.min(12, Math.round(o.shift)));
  }
  return audio;
}

// ── deletions ────────────────────────────────────────────────────────
// A merge that only ever adds would resurrect every document you've ever
// deleted, since the other side still has it. So a delete leaves a mark:
// this id was removed at this moment. A document older than its tombstone
// stays deleted; one edited AFTER it (on another device, say) comes back,
// which is the right way round — an edit is evidence you still want it.
export type Tomb = { id: string; at: number };

// Long enough that a laptop opened after a month still honours a deletion,
// short enough that the list can't grow without bound.
const TOMB_TTL = 180 * 24 * 3600 * 1000;

export function loadTombs(): Tomb[] {
  try { return coerceTombs(JSON.parse(localStorage.getItem(TOMBS_KEY) || '[]')); } catch { return []; }
}

function saveTombs(tombs: Tomb[]): void {
  try {
    localStorage.setItem(TOMBS_KEY, JSON.stringify(tombs));
  } catch { /* ignore */ }
}

export function recordDelete(id: string): void {
  const now = Date.now();
  saveTombs([...loadTombs().filter(t => t.id !== id && now - t.at < TOMB_TTL), { id, at: now }]);
}

function coerceTombs(raw: unknown): Tomb[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .filter(t => t && typeof (t as any).id === 'string' && typeof (t as any).at === 'number')
    .map(t => ({ id: String((t as any).id), at: Number((t as any).at) }))
    .filter(t => now - t.at < TOMB_TTL);
}

// Nothing to pull: the library is only ever this browser's. Kept as the
// app's one on-mount hook so the startup sequence reads as it always did.
export async function hydrate(): Promise<{ docs?: Doc[]; currentId?: string; history?: H.Checkpoint[] }> {
  return {};
}

let idSeq = 0;
export function newId(prefix = 'j'): string {
  idSeq++;
  return `${prefix}${Date.now().toString(36)}${idSeq}`;
}

// Every new document is born here, so it's stamped with the language version
// it was written in. A document that reached storage unstamped would be read
// as version 1 next time and migrated as though it were old — which is the one
// way this scheme can corrupt a file, so there's exactly one door in.
export function newDoc(name: string, text: string, syntax = SYNTAX_VERSION): Doc {
  return { id: newId(), name, text, syntax: syntax || SYNTAX_VERSION, updated: Date.now() };
}
