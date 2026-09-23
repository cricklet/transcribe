// The song library: every mp3 you've attached to a transcription, kept in this
// browser.
//
// The bytes live in IndexedDB, not localStorage — localStorage holds about
// five megabytes of STRINGS per site, which is less than one song. Everything
// else the app keeps (the transcriptions, their marks, the settings) is still
// in localStorage; only the audio itself needs the bigger store.
//
// A song is uploaded once and can be attached to any number of
// transcriptions: the transcription only holds its id (plus its own marks,
// rate and so on — see DocAudio in types.ts).

const DB_NAME = 'transcribe-songs';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_META = 'meta';

export type Song = {
  id: string;
  name: string;
  addedAt: number;
  size?: number;
  duration?: number;
  // Uploaded songs don't come with a tempo; kept in the shape so a beat can
  // be derived from one if it's ever set.
  bpm?: number;
  // Never set here — a song uploaded on its own has no stems. Kept so the
  // strip's stem handling stays as it was.
  parentId?: string;
  folder?: string;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openLibrary(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function request<T>(r: IDBRequest): Promise<T | null> {
  return new Promise(resolve => {
    r.onsuccess = () => resolve((r.result ?? null) as T | null);
    r.onerror = () => resolve(null);
  });
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise(resolve => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

// Every song, newest first.
export async function loadAll(): Promise<Song[]> {
  const db = await openLibrary();
  if (!db) return [];
  try {
    const rows = await request<Song[]>(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll());
    return (rows ?? []).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  } catch { return []; }
}

export async function loadBytes(id: string): Promise<ArrayBuffer | null> {
  const db = await openLibrary();
  if (!db) return null;
  try {
    const rec = await request<{ id: string; buffer: ArrayBuffer }>(
      db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).get(id));
    return rec?.buffer ?? null;
  } catch { return null; }
}

// Store an uploaded file and hand back its row. Throws with a readable message
// when the browser won't take it (private windows, a full disk).
export async function addSong(file: File, id?: string): Promise<Song> {
  const db = await openLibrary();
  if (!db) throw new Error('this browser won’t store audio (private window?)');
  const buffer = await file.arrayBuffer();
  const song: Song = {
    id: id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: file.name,
    addedAt: Date.now(),
    size: buffer.byteLength,
  };
  const duration = await measure(buffer);
  if (duration) song.duration = duration;
  const tx = db.transaction([STORE_FILES, STORE_META], 'readwrite');
  tx.objectStore(STORE_FILES).put({ id: song.id, buffer });
  tx.objectStore(STORE_META).put(song);
  if (!(await done(tx))) throw new Error('couldn’t save the song — out of space?');
  return song;
}

export async function removeSong(id: string): Promise<void> {
  const db = await openLibrary();
  if (!db) return;
  const tx = db.transaction([STORE_FILES, STORE_META], 'readwrite');
  tx.objectStore(STORE_FILES).delete(id);
  tx.objectStore(STORE_META).delete(id);
  await done(tx);
}

// How long the song runs, for the list. Decoding a copy is the only portable
// way to know; a failure just leaves the length off.
async function measure(buffer: ArrayBuffer): Promise<number | null> {
  try {
    const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx(1, 1, 44100);
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    return decoded.duration;
  } catch { return null; }
}

// ── the rest of the strip's old vocabulary ───────────────────────────
// The strip was written against a library that had stems and loops. An
// uploaded mp3 has neither, so these answer "none".

export function songsIn(all: Song[]): Song[] {
  return all.filter(s => !s.parentId);
}

export function stemsIn(all: Song[], parentId: string): Song[] {
  return all.filter(s => s.parentId === parentId).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

export function stemLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

export function loopStarts(_id: string, _bpm: number | undefined): number[] {
  return [];
}

export function stemsOffset(_id: string): number {
  return 0;
}

export function droppedStems(_id: string): Set<string> {
  return new Set();
}

// ── backups ──────────────────────────────────────────────────────────
// A full backup carries the audio too, as base64, so a shared file brings the
// songs with it. Chunked, because String.fromCharCode on a whole song blows the
// argument limit.

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export type SongBackup = { id: string; name: string; data: string };

export async function backupSongs(ids: string[]): Promise<SongBackup[]> {
  const all = await loadAll();
  const out: SongBackup[] = [];
  for (const id of new Set(ids)) {
    const meta = all.find(s => s.id === id);
    const bytes = await loadBytes(id);
    if (meta && bytes) out.push({ id, name: meta.name, data: toBase64(bytes) });
  }
  return out;
}

// Put backed-up songs back, keeping their ids so the transcriptions that name
// them find them. A song already here is left alone.
export async function restoreSongs(list: unknown): Promise<number> {
  if (!Array.isArray(list)) return 0;
  const have = new Set((await loadAll()).map(s => s.id));
  let n = 0;
  for (const s of list) {
    if (!s || typeof s.id !== 'string' || typeof s.data !== 'string' || have.has(s.id)) continue;
    try {
      const buf = fromBase64(s.data);
      const file = new File([buf], typeof s.name === 'string' ? s.name : 'song.mp3', { type: 'audio/mpeg' });
      await addSong(file, s.id);
      n++;
    } catch { /* skip a song that won't restore; the rest still can */ }
  }
  return n;
}
