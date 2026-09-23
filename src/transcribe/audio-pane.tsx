// The song strip: the recording a transcription was made from, along the
// bottom of the workspace.
//
// The recording is an mp3 you upload; it's kept in this browser (see
// songs.ts) and can be attached to any number of transcriptions. The
// bookmarks live on the TRANSCRIPTION, so two transcriptions of the same
// recording keep their own places in it.
//
// The song and the notation never sound together on purpose: a transcription
// is written in bars from bar one and the recording has a count-in, a rubato
// intro, a drummer — the two aren't on the same clock and never will be, so
// playing both would only ever be a mess. Starting either stops the other.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as L from './songs';
import { MIX, Mp3Player } from './mp3';
import { DocAudio } from './types';
import * as P from './persistence';

export type AudioCommands = {
  // alt+r — from the start marker, wherever the head happens to be.
  playFromStart(): void;
  // alt+space — from the head, and again to stop.
  toggleFromHead(): void;
  // alt+enter — stop and put the head back where the run began; pressed again,
  // play from there. The pair replays the same passage over and over, which is
  // what transcribing a lick actually consists of.
  replayFromHead(): void;
  // alt+, / alt+. — the start, one beat of the recording at a time, with the
  // head following it.
  nudge(beats: number): void;
  // alt+shift+, / alt+shift+. — the same step, but the mark the start is
  // sitting on comes along with it. Nowhere near a mark, it's a plain nudge.
  nudgeMark(beats: number): void;
  // alt+s — the start, onto wherever the head has got to.
  markStart(): void;
  // alt+m — a bookmark, on wherever the head has got to.
  addBookmark(): void;
  // alt+1 … alt+0 — the nth bookmark in time order, 1-based.
  goToBookmark(n: number): void;
  // How many there are, so the keys know whether a second digit could be
  // coming: with nine bookmarks, alt+1 can only ever mean the first one.
  bookmarkCount(): number;
  // alt+- / alt+= — the bookmark before or after the head.
  stepBookmark(dir: 1 | -1): void;
  stop(): void;
  playing(): boolean;
  attached(): boolean;
  // Store an mp3 and attach it to the open transcription — the page-wide
  // drop target hands audio files here.
  attachFile(file: File): void;
  // Re-read the stored songs, after an import has put some back.
  reloadLibrary(): void;
};

type Props = {
  audio: DocAudio | null;
  onChange: (a: DocAudio | null) => void;
  // Filled in with this pane's commands, so the app can bind them to keys
  // that have to work from inside the editor too.
  api: { current: AudioCommands | null };
  // Called just before the song starts, to silence the notation.
  onBeforePlay: () => void;
  // Where the head had got to when this transcription was last open, in
  // seconds — the app remembers it per document. Null when there’s nothing
  // remembered, and the head goes to the start marker the way it always did.
  resumeAt?: number | null;
  // Which transcription that head belongs to. The strip only needs it to know
  // that the DOCUMENT changed under a song it's already holding — two
  // transcriptions of the same take keep their own places in it, and the
  // second one shouldn't inherit where the first got to.
  docId?: string;
  // …and the head as it moves, so the app can remember it. Fires with every
  // frame of playback, so it had better be cheap on the other end.
  onHead?: (at: number) => void;
  // ── the marks, and the M1 M2 … in the transcription ────────────────
  // The strip knows nothing about the source. It only reports which bookmark
  // was landed on, added or dropped, BY NUMBER, and the app keeps the marks
  // in the writing numbered to match — see marks.ts.
  //
  // Which numbers the transcription has actually written down, so a bookmark
  // can say on the strip whether anything points at it.
  textMarks: number[];
  // The nth bookmark was landed on — by key, by click or by walking.
  onGoToMark: (n: number) => void;
  // A bookmark went in as the nth …
  onMarkAdded: (n: number) => void;
  // … and the ones from `from` through `to` came out (both 1-based, and the
  // same number when it's one mark).
  onMarkDropped: (from: number, to: number) => void;
  // A message for the flash line — the pane has no room to explain itself.
  say: (msg: string, bad?: boolean) => void;
  // Whether the strip is allowed to fold at all. Side by side there's height
  // to spare and a transport that comes and goes is just one more thing to
  // manage — it's simply there. Stacked, every band of vertical space is a
  // system of music, so it folds.
  foldable: boolean;
  open: boolean;
  onToggle: () => void;
};

// Playback speed the strip offers, as a fraction of the recording's own tempo.
const RATE_MIN = 0.4;
const RATE_MAX = 1.25;

// How far the RECORDING itself may be moved, in semitones. Nothing to do with
// what the transcription is written for (that's CONCERT= in the source, and it
// moves what the app plays rather than what it heard): this is for a take that
// sits a little off concert, or for hearing the passage you're working out in
// a key that suits the horn in your hands. An octave either way is more than
// anyone needs and the stretcher stops sounding like the record long before
// it.
const SHIFT_MAX = 12;

// ── where the next mark goes ─────────────────────────────────────────
//
// Marks get placed by ear, one at a time, and once a few are down the next one
// is usually predictable: the same distance on again. So the strip shows where
// it would go, and you either take it or you don't — which is the only honest
// way to do this, because none of the input is exact. A mark dropped on the
// beat by hand lands within a tenth of a second of where it meant to, the
// marks before a solo may be at a different spacing entirely, and there is
// usually a stretch at the top of the recording with nothing marked at all.
//
// So the interval isn't read off the whole set — it's read off the RUN the
// last mark belongs to, walking back only as far as the spacing holds:
//
//   ·   ·           ·  ·  ·  ·  ·  ·   ?      ← two marks, a break, then a run
//                   └──────┬──────┘
//                   this is what says where ? is
//
// A gap roughly twice (or three times) the run's own spacing is a mark that
// didn't get placed rather than the end of the run, so it counts as two — that
// is what NEXT_STEPS is for. Anything that fits neither ends the walk.
const NEXT_TOL = 0.28;      // how far off the run's spacing a gap may sit
const NEXT_STEPS = 4;       // …and how many intervals one gap may stand for
const NEXT_TAIL = 0.25;     // no guess this close to the end of the song

export type NextMark = { at: number; period: number; of: number };

export function nextMark(marks: { at: number }[], duration: number): NextMark | null {
  if (marks.length < 2 || !(duration > 0)) return null;
  const gaps: number[] = [];
  for (let i = 1; i < marks.length; i++) gaps.push(marks[i].at - marks[i - 1].at);

  // Back from the last gap while the spacing holds. `period` is the median of
  // what has been accepted so far — a median rather than a mean because one
  // mark placed late shouldn't drag the estimate — and every accepted gap is
  // divided by however many intervals it covers.
  const run: number[] = [];
  // Each mark of the run, with how many intervals it sits before the last one.
  const back: { at: number; steps: number }[] = [{ at: marks[marks.length - 1].at, steps: 0 }];
  let period = gaps[gaps.length - 1];
  if (!(period > 0.05)) return null;
  let steps = 0;
  for (let i = gaps.length - 1; i >= 0; i--) {
    const k = Math.round(gaps[i] / period);
    if (k < 1 || k > NEXT_STEPS || Math.abs(gaps[i] - k * period) > NEXT_TOL * period) break;
    run.push(gaps[i] / k);
    period = median(run);
    steps += k;
    back.push({ at: marks[i].at, steps });
  }
  if (!run.length || !(period > 0.05)) return null;

  // Where the run says the LAST mark is. Every mark in it gets a vote — each
  // projected forward by its own distance — and the median of those is what
  // the next one is counted from, so the guess doesn't inherit the error of
  // whichever mark happened to be placed last.
  const at = Math.round((median(back.map(b => b.at + b.steps * period)) + period) * 1000) / 1000;
  if (at > duration - NEXT_TAIL || at <= marks[marks.length - 1].at + 0.05) return null;
  return { at, period, of: back.length };
}

function median(ns: number[]): number {
  const s = ns.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const VOLUME_KEY = 'transcribe.songVolume.v1';
// How far the strip is zoomed in, as a multiple of the whole song fitting its
// width. Remembered — you settle on a zoom that suits how you listen.
const ZOOM_KEY = 'transcribe.songZoom.v1';
const ZOOM_MAX = 16;

function loadZoom(): number {
  try {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(raw) && raw >= 1 ? Math.min(ZOOM_MAX, raw) : 1;
  } catch { return 1; }
}

function loadVolume(): number {
  const raw = Number(localStorage.getItem(VOLUME_KEY));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.9;
}

function fmt(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The name without its extension — every row in the library is a .mp3 and
// saying so on each one is noise.
function songName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Times are kept to the millisecond: a mark is placed by ear and by pointer,
// and the digits past that are noise that only makes two marks that are in the
// same place fail to look like it.
const round3 = (secs: number) => Math.round(secs * 1000) / 1000;

export function AudioPane({
  audio, onChange, api, onBeforePlay, say, foldable, open, onToggle,
  textMarks, onGoToMark, onMarkAdded, onMarkDropped, resumeAt, onHead, docId,
}: Props) {
  const playerRef = useRef<Mp3Player | null>(null);
  if (!playerRef.current) playerRef.current = new Mp3Player();
  const player = playerRef.current;
  // Both read from refs: the song is loaded by an effect that must not re-run
  // when the app hands down a new lambda, or a new second.
  const resumeRef = useRef(resumeAt);
  resumeRef.current = resumeAt;
  const onHeadRef = useRef(onHead);
  onHeadRef.current = onHead;

  const [library, setLibrary] = useState<L.Song[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  // Bumped whenever something the strip draws has changed under it — the
  // player is a plain object, not state, so this is how a redraw is asked for.
  const [, bump] = useState(0);
  const redraw = useCallback(() => bump(n => n + 1), []);
  const [head, setHead] = useState(0);
  const [volume, setVolume] = useState(loadVolume);
  // The strip's window onto the song: how zoomed in, and the second its left
  // edge sits at. Only the zoom is remembered — where you're looking follows
  // the playhead anyway.
  const [zoom, setZoomRaw] = useState(loadZoom);
  const [viewFrom, setViewFrom] = useState(0);
  // How tall the waveform is — dragged from the grip along the top edge of
  // the strip's section, and remembered for the whole app.
  const [stripH, setStripH] = useState<number | null>(() => P.loadPaneSize('song'));
  const onGripDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = stripRef.current?.getBoundingClientRect().height ?? 60;
    let latest = startH;
    document.body.classList.add('jp-resizing-y');
    const move = (ev: PointerEvent) => {
      // Up is taller: the strip grows into the window above it.
      latest = Math.round(Math.max(24, Math.min(window.innerHeight * 0.5, startH + startY - ev.clientY)));
      setStripH(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', move);
      document.body.classList.remove('jp-resizing-y');
      P.savePaneSize('song', latest);
    }, { once: true });
  }, []);
  // What is SELECTED — picked out by clicking it — as the two ends of a run:
  // the mark you clicked first and the mark you shift-clicked last, which are
  // the same mark until you extend it. Held by the times the marks sit at,
  // which is their identity here, since that is the one thing about a mark
  // that is its own.
  //
  // The row of controls is open exactly while this is set, and it stays open:
  // a mark is a hairline among hairlines, and the row is how you check you
  // have hold of the ones you meant before you move them or drop them. Nothing
  // that reads which marks you are working on should be able to change under
  // the pointer on the way to the button.
  const [sel, setSel] = useState<{ anchor: number; at: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ── uploading ──────────────────────────────────────────────────────
  const reloadLibrary = useCallback(async () => { setLibrary(await L.loadAll()); }, []);
  const attachFile = useCallback(async (file: File) => {
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name)) {
      say(`${file.name} isn’t audio`, true);
      return;
    }
    setPicking(false);
    setLoading(true);
    try {
      const row = await L.addSong(file);
      setLibrary(await L.loadAll());
      onChange({ id: row.id, start: 0, bookmarks: [], off: [], rate: 1 });
      say(`attached ${songName(row.name)}`);
    } catch (e) {
      setLoading(false);
      say(e instanceof Error ? e.message : `couldn’t store ${file.name}`, true);
    }
  }, [onChange, say]);
  const chooseFile = useCallback(() => fileRef.current?.click(), []);
  const forget = useCallback(async (s: L.Song) => {
    if (!confirm(`Remove “${songName(s.name)}” from this browser? Transcriptions it’s attached to keep their marks, but lose the audio.`)) return;
    await L.removeSong(s.id);
    if (s.id === audio?.id) onChange(null);
    setLibrary(await L.loadAll());
  }, [audio?.id, onChange]);

  const song = useMemo(
    () => (audio && library ? library.find(s => s.id === audio.id) ?? null : null),
    [audio, library],
  );
  const stems = useMemo(
    () => (song && library ? L.stemsIn(library, song.id).filter(s => !L.droppedStems(song.id).has(s.id)) : []),
    [song, library],
  );
  // A beat of the RECORDING, which is what the loop marks are counted in and
  // what nudging the head steps by. Nothing to do with the transcription's own
  // metre — the two aren't aligned.
  const beat = song?.bpm && song.bpm > 0 ? 60 / song.bpm : 0.5;
  const loops = useMemo(() => (song ? L.loopStarts(song.id, song.bpm) : []), [song]);

  const start = audio?.start ?? 0;
  // …and the same number somewhere the key commands can always reach it. They
  // live in a ref that the app calls into, so anything they close over is a
  // snapshot of the render that built them; a marker that moved a moment ago
  // would be replayed at where it used to be. The ref can't go stale, which
  // matters more here than anywhere — playing from the start is the one thing
  // alt+r is FOR.
  const startRef = useRef(start);
  startRef.current = start;
  const bookmarks = audio?.bookmarks ?? [];
  const off = useMemo(() => new Set(audio?.off ?? []), [audio]);
  const levels = audio?.levels ?? {};

  // Opening the picker puts you in the filter with whatever was left in it
  // selected, so the picker is one gesture: click, type the song's name.
  // (`autofocus` is a parse-time attribute — an input that appears later has
  // to be focused by hand, and it wouldn't select the old text anyway.)
  useEffect(() => {
    if (!picking) return;
    const raf = requestAnimationFrame(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [picking]);

  // ── the library ────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    L.loadAll().then(rows => { if (alive) setLibrary(rows); });
    return () => { alive = false; };
  }, []);

  // ── loading the attached song ──────────────────────────────────────
  useEffect(() => {
    if (!audio?.id || !library) return;
    let alive = true;
    setLoading(true);
    (async () => {
      const row = library.find(s => s.id === audio.id);
      if (!row) { if (alive) { setLoading(false); say(`that song isn’t stored in this browser — attach the mp3 again`, true); } return; }
      const mine = L.stemsIn(library, row.id).filter(s => !L.droppedStems(row.id).has(s.id));
      const offset = L.stemsOffset(row.id);
      const mainBytes = await L.loadBytes(row.id);
      if (!alive) return;
      if (!mainBytes) { setLoading(false); say(`couldn't read ${songName(row.name)}`, true); return; }
      const stemBytes = await Promise.all(mine.map(s => L.loadBytes(s.id)));
      if (!alive) return;
      await player.load(
        { id: row.id, bytes: mainBytes },
        mine.map((s, i) => ({ id: s.id, bytes: stemBytes[i]! , offset }))
          .filter((_, i) => !!stemBytes[i]),
      );
      if (!alive) return;
      player.setVolume(volume);
      player.setRate(audio.rate ?? 1);
      player.setShift(audio.shift ?? 0);
      for (const t of player.tracks()) {
        player.setTrackOn(t.id, !off.has(t.id));
        player.setTrackLevel(t.id, audio.levels?.[t.id] ?? 1);
      }
      // Where you left off, or the start marker when that’s all there is.
      const from = resumeRef.current ?? audio.start ?? 0;
      setHead(from);
      player.seek(from);
      setLoading(false);
      redraw();
    })();
    return () => { alive = false; };
    // Only the identity of the attached song reloads it — the marks and knobs
    // are applied without a reload below.
  }, [audio?.id, library]);

  // Nothing attached any more: let the audio go, but keep the context.
  useEffect(() => {
    if (!audio?.id) { player.unload(); setHead(0); redraw(); }
  }, [audio?.id]);

  useEffect(() => () => { player.unload(); }, []);

  // ── the moving head ────────────────────────────────────────────────
  useEffect(() => {
    if (!player.playing) return;
    let raf = 0;
    // Every head position is a state change, so it re-renders the pane — and
    // on a 120 Hz screen it did that twice per displayed frame's worth of
    // motion. The head is a line sliding across a strip; 60 updates a second
    // is already more than the eye asks of it.
    let last = -Infinity;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - last < 1000 / 62) return;
      last = now;
      setHead(player.pos());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player.playing]);

  player.onEnd = useCallback(() => { setHead(0); redraw(); }, [redraw]);

  // Out to the app, which writes it down against the open transcription.
  useEffect(() => { onHeadRef.current?.(head); }, [head]);

  // A new transcription of a song already loaded: no reload, just the head
  // where this one left it. Not while the recording is running — switching
  // documents isn't asking the music to jump.
  useEffect(() => {
    if (!audio?.id || player.playing) return;
    const at = resumeRef.current ?? startRef.current ?? 0;
    setHead(at);
    player.seek(at);
  }, [docId]);

  // ── the transport ──────────────────────────────────────────────────
  // Where the run now going began — what alt+enter rewinds to. A ref rather
  // than state: nothing on screen shows it, and it has to survive being read
  // from inside a key command that closed over an older render.
  const ranFrom = useRef(0);

  const playFrom = useCallback(async (at: number) => {
    if (!player.loaded) return;
    onBeforePlay();
    ranFrom.current = at;
    setHead(at);
    await player.play(at);
    redraw();
  }, [onBeforePlay, redraw]);

  const stop = useCallback(() => {
    if (!player.playing) return;
    player.stop();
    setHead(player.pos());
    redraw();
  }, [redraw]);

  // Stop the way a tape stops rather than the way a pause does: the head goes
  // back to where the run began, so the next press plays the same passage
  // again instead of carrying on from wherever you happened to hear enough.
  // Not playing, it's simply play — from the head, which is where the press
  // before it left one.
  const replay = useCallback(() => {
    if (!player.loaded) return;
    if (!player.playing) { void playFrom(player.pos()); return; }
    player.stop();
    const back = ranFrom.current;
    player.seek(back);
    setHead(back);
    redraw();
  }, [playFrom, redraw]);

  // ── the marks ──────────────────────────────────────────────────────
  const patch = useCallback((p: Partial<DocAudio>) => {
    if (!audio) return;
    onChange({ ...audio, ...p });
  }, [audio, onChange]);

  // How far the recording is being moved, and moving it. Live — the stretcher
  // is already in the chain, so the change lands on the sound already going
  // and neither the tempo nor the playhead moves.
  const shift = audio?.shift ?? 0;
  const setShift = useCallback((semis: number) => {
    const next = Math.max(-SHIFT_MAX, Math.min(SHIFT_MAX, Math.round(semis)));
    player.setShift(next);
    patch({ shift: next || undefined });
    redraw();
  }, [patch, redraw]);

  const setStart = useCallback((at: number) => {
    patch({ start: Math.max(0, Math.round(at * 1000) / 1000) });
  }, [patch]);

  // Walk the START along, a beat of the recording at a time, and bring the
  // head with it — the start is the thing being aimed, and a head left behind
  // where it was would only be somewhere you have to click back to. It steps
  // from the start rather than from the head, so holding the key walks it
  // evenly instead of accelerating away wherever playback had got to.
  const nudge = useCallback((beats: number) => {
    if (!player.loaded) return;
    const at = Math.max(0, Math.min(player.duration, start + beats * beat));
    setStart(at);
    if (player.playing) { void playFrom(at); return; }
    player.seek(at);
    setHead(at);
    redraw();
  }, [beat, start, playFrom, redraw, setStart]);

  // A bookmark, on the head — or on a spot handed in, which is what the guess
  // on the strip does with the one it is pointing at.
  const addBookmark = useCallback((spot?: number) => {
    if (!audio) return;
    const at = Math.round((spot ?? head) * 1000) / 1000;
    // A second bookmark on the same spot says nothing the first one didn't.
    if (bookmarks.some(b => Math.abs(b.at - at) < 0.05)) { say('there is already a mark there'); return; }
    const next = [...bookmarks, { at }].sort((a, b) => a.at - b.at);
    patch({ bookmarks: next });
    // Which number it came in as. One dropped in the middle of the song pushes
    // every bookmark after it up one, so the transcription's marks move with
    // them — see marks.ts.
    onMarkAdded(next.findIndex(b => b.at === at) + 1);
    say(`marked ${fmt(at)}`);
  }, [audio, head, bookmarks, patch, say, onMarkAdded]);

  // Going to a mark, whether a click or a key asked: the START moves onto it —
  // a mark you jumped to is the bit you're about to work on, which is what the
  // start marker is for — and the head follows. Playing, the music jumps there
  // and carries on rather than stopping to be restarted.
  const goTo = useCallback((at: number) => {
    setStart(at);
    if (player.playing) { void playFrom(at); return; }
    player.seek(at);
    setHead(at);
    redraw();
  }, [setStart, playFrom, redraw]);

  // The bookmarks in time order, which is the order alt+1 … alt+0 count in and
  // the order alt+- / alt+= walk. They're kept sorted as they're added, but a
  // document from anywhere else has made no such promise.
  const marks = useMemo(
    () => bookmarks.slice().sort((a, b) => a.at - b.at),
    [bookmarks],
  );

  // The selection as a run of numbers — which is what everything downstream
  // wants, since the marks are numbered by where they fall and a run of them
  // is therefore always contiguous. Whichever end you clicked first, `from` is
  // the earlier one. A selection whose marks have since gone is no selection.
  const range = useMemo(() => {
    if (!sel) return null;
    const at = marks.findIndex(b => b.at === sel.at);
    if (at < 0) return null;
    const anchor = marks.findIndex(b => b.at === sel.anchor);
    const other = anchor < 0 ? at : anchor;
    return { from: Math.min(at, other), to: Math.max(at, other) };
  }, [sel, marks]);

  // Landing on the nth mark: the recording goes there, and so does the
  // transcription — the M in the writing and the bookmark on the strip are two
  // ends of the same place, which is the whole point of numbering them
  // together. Whether it was a key, a click or a walk that asked.
  // Where the next mark would go, from the run the last one belongs to — see
  // nextMark. Drawn on the strip as a guess you can take or leave: clicking it
  // goes there, the + over it puts a mark there.
  const guess = useMemo(
    () => nextMark(marks, player.duration),
    [marks, player.duration, loading],
  );

  const land = useCallback((i: number) => {
    const b = marks[i];
    if (!b) return;
    goTo(b.at);
    onGoToMark(i + 1);
  }, [marks, goTo, onGoToMark]);

  // How far marks `from`..`to` can actually move if they're scooted `beats`
  // along as one, or null if there is nowhere for them to go. A run moves
  // RIGIDLY — every mark in it by the same amount — because the spacing inside
  // it is the thing you got right and is not what you are adjusting; what you
  // are adjusting is where the whole passage sits.
  //
  // It cannot pass the marks on either side of it: the marks are NUMBERED by
  // where they fall, so one that overtook its neighbour would renumber both and
  // every M in the transcription with them, which is not what "a bit later"
  // means. It stops just short instead.
  const shiftedBy = useCallback((from: number, to: number, beats: number) => {
    const first = marks[from], last = marks[to];
    if (!first || !last) return null;
    const low = from > 0 ? marks[from - 1].at + 0.06 : 0;
    const high = to < marks.length - 1 ? marks[to + 1].at - 0.06 : player.duration;
    if (high - low < last.at - first.at) return null;
    let d = beats * beat;
    if (first.at + d < low) d = low - first.at;
    if (last.at + d > high) d = high - last.at;
    const delta = round3(d);
    return delta === 0 ? null : delta;
  }, [marks, beat]);

  // …and moving them. Everything outside the run stays exactly where it was.
  // Returns how far they actually went, so a caller that has to follow them
  // (the playhead, the start marker) knows.
  const scootRun = useCallback((from: number, to: number, beats: number, carryStart: boolean) => {
    if (!audio) return null;
    const delta = shiftedBy(from, to, beats);
    if (delta == null) return null;
    const moving = new Set(marks.slice(from, to + 1).map(b => b.at));
    const next = bookmarks
      .map(b => (moving.has(b.at) ? { ...b, at: round3(b.at + delta) } : b))
      .sort((a, b) => a.at - b.at);
    // The selection is held by WHERE its marks are, so it travels with them —
    // otherwise the row would be pointing at times nothing is at any more.
    setSel(was => (was && moving.has(was.anchor) && moving.has(was.at)
      ? { anchor: round3(was.anchor + delta), at: round3(was.at + delta) }
      : was));
    if (carryStart) onChange({ ...audio, bookmarks: next, start: round3(start + delta) });
    else patch({ bookmarks: next });
    return delta;
  }, [audio, marks, bookmarks, start, shiftedBy, onChange, patch]);

  // Nudging with the mark: when the start is sitting ON a bookmark — which it
  // is whenever you got here by landing on one — the two move together, so
  // "the mark is half a beat early" is fixed by the same keys that aim the
  // start, with shift held. If that mark is one of a selected run, the whole
  // run comes: you said they were a group, and this is the group being moved.
  // Off a mark there is nothing to bring along and it is simply a nudge.
  //
  // One patch does both the marks and the start, because two in a row would
  // each be spreading the same render's `audio` and the second would put the
  // first's back.
  const nudgeMark = useCallback((beats: number) => {
    if (!audio || !player.loaded) return;
    const on = marks.findIndex(m => Math.abs(m.at - start) < 0.05);
    if (on < 0) { nudge(beats); return; }
    const run = range && on >= range.from && on <= range.to ? range : { from: on, to: on };
    const delta = scootRun(run.from, run.to, beats, true);
    if (delta == null) return;
    const to = round3(start + delta);
    if (player.playing) { void playFrom(to); return; }
    player.seek(to);
    setHead(to);
    redraw();
  }, [audio, marks, start, range, nudge, scootRun, playFrom, redraw]);

  // The commands the app binds to keys. Rebuilt whenever what they close over
  // changes, so a key never runs against a stale song.
  useEffect(() => {
    api.current = {
      playFromStart: () => { void playFrom(startRef.current); },
      toggleFromHead: () => { if (player.playing) stop(); else void playFrom(player.pos()); },
      replayFromHead: replay,
      nudge,
      nudgeMark,
      markStart: () => { setStart(player.pos()); },
      addBookmark: () => addBookmark(),
      goToBookmark: n => {
        if (!marks[n - 1]) { say(`no bookmark ${n}`); return; }
        land(n - 1);
      },
      // From where the head IS, not from the last one landed on, so it walks
      // whether you got here by key, by click or by playing past one. The
      // sliver of slack is what stops the mark you're sitting on counting as
      // the one in front of you.
      bookmarkCount: () => marks.length,
      stepBookmark: dir => {
        const at = player.pos();
        const i = dir > 0
          ? marks.findIndex(m => m.at > at + 0.05)
          : marks.map(m => m.at).reduce((found, x, k) => (x < at - 0.05 ? k : found), -1);
        if (i < 0) { say(dir > 0 ? 'no bookmark after this' : 'no bookmark before this'); return; }
        land(i);
      },
      stop,
      playing: () => player.playing,
      attached: () => player.loaded,
      attachFile: (f: File) => { void attachFile(f); },
      reloadLibrary: () => { void reloadLibrary(); },
    };
    return () => { api.current = null; };
  }, [api, playFrom, stop, replay, nudge, nudgeMark, setStart, addBookmark, land, marks, say, attachFile, reloadLibrary]);

  // Dropping the run: all of them at once, and the M's in the transcription
  // that answered to them go too.
  const dropRun = useCallback((from: number, to: number) => {
    const gone = new Set(marks.slice(from, to + 1).map(b => b.at));
    if (!gone.size) return;
    setSel(null);
    patch({ bookmarks: bookmarks.filter(b => !gone.has(b.at)) });
    // Which ones went, said out loud: a mark is a hairline on a strip and the
    // one beside it looks the same, so the numbers are how you know they were
    // the ones you meant. (⌘Z takes them back if they weren't.)
    say(gone.size === 1 ? `mark ${from + 1} dropped` : `marks ${from + 1}–${to + 1} dropped`);
    // Everything after them counts back by however many went — see marks.ts.
    onMarkDropped(from + 1, to + 1);
  }, [bookmarks, marks, patch, say, onMarkDropped]);

  // Scooting the run along from its row, a beat of the recording at a time —
  // the same step alt+, and alt+. move the start by, since it is the same
  // question asked of a different thing: not quite there, a bit later.
  // (alt+shift+, / alt+shift+. move the run and the start together; see
  // nudgeMark.)
  const scootMarks = useCallback((from: number, to: number, beats: number) => {
    scootRun(from, to, beats, false);
  }, [scootRun]);

  // Clicking a mark selects it AND goes there — the two are one gesture, since
  // the reason to pick a mark out is that it's the passage you're about to
  // work on. Its row opens over the strip and stays open until you pick
  // another one or click the strip somewhere else, so the marks being edited
  // are always ones you named on purpose and can see named back at you.
  //
  // Shift held, the click reaches out from the mark you started at and takes
  // in everything as far as this one — marks are numbered by where they fall,
  // so "these ones" is always a stretch of the song, and the row then moves or
  // drops the lot. Shift-clicking again from the same end re-aims that end,
  // which is how you widen or narrow a run you've already got.
  const pick = useCallback((at: number, i: number, extend: boolean) => {
    setSel(was => (extend && was ? { anchor: was.anchor, at } : { anchor: at, at }));
    land(i);
  }, [land]);
  // Anything that changes which song is on the strip drops the selection.
  useEffect(() => setSel(null), [audio?.id]);

  // …and so does a pointer landing anywhere else. The row floats over the
  // music and the rail, so once you've turned to something else it is in the
  // way of the thing you turned to; reaching for ANY other control — another
  // pane, the transcription, the rest of this bar — puts it away. The marks on
  // the strip are the exception: a click on one is picking the next selection
  // rather than leaving this one, and clearing here would cost a shift-click
  // the end it was reaching out from. Capture, so it still fires for a control
  // that stops the event on its way up.
  useEffect(() => {
    if (!sel) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.jp-song-edit, .jp-song-mark')) return;
      setSel(null);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [sel]);

  // ── the strip ──────────────────────────────────────────────────────
  // Zoomed, the strip shows `span` seconds from `from`; everything on it is
  // placed through posOf, so a marker outside the window just lands off the
  // edge and the strip's clipping takes care of it.
  const span = player.duration / zoom;
  const from = Math.max(0, Math.min(player.duration - span, viewFrom));
  const posOf = (secs: number) => (span > 0 ? (secs - from) / span : 0);

  // Zoom keeping one moment where it is on screen: the pointer's, for a
  // pinch, or the playhead's (when it's in view) for the buttons.
  const zoomRef = useRef({ zoom, from, span, head });
  zoomRef.current = { zoom, from, span, head };
  const zoomTo = useCallback((z: number, anchor?: { at: number; frac: number }) => {
    const cur = zoomRef.current;
    const next = Math.max(1, Math.min(ZOOM_MAX, z));
    const a = anchor ?? (cur.head >= cur.from && cur.head <= cur.from + cur.span
      ? { at: cur.head, frac: (cur.head - cur.from) / (cur.span || 1) }
      : { at: cur.from + cur.span / 2, frac: 0.5 });
    setZoomRaw(next);
    setViewFrom(a.at - a.frac * (player.duration / next));
    try { localStorage.setItem(ZOOM_KEY, String(next)); } catch { /* private mode */ }
  }, []);

  // The window turns the page when the playhead runs off it — so playing
  // zoomed in, the music you're hearing is always the music on screen.
  useEffect(() => {
    if (zoom <= 1 || !span) return;
    if (head < from || head > from + span * 0.98) setViewFrom(head - span * 0.05);
  // Keyed on the head alone: zooming or panning away while it sits still
  // is looking elsewhere on purpose, and mustn't snap back.
  }, [head]);

  // A pinch (or ctrl + wheel) zooms about the pointer; a sideways swipe (or
  // shift + wheel) pans. Bound by hand: a wheel listener has to be
  // non-passive to keep the page from zooming or scrolling along with it.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const cur = zoomRef.current;
      const r = el.getBoundingClientRect();
      if (e.ctrlKey) {
        e.preventDefault();
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        zoomTo(cur.zoom * Math.exp(-e.deltaY * 0.01), { at: cur.from + frac * cur.span, frac });
        return;
      }
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      if (cur.zoom <= 1 || Math.abs(dx) < Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
      e.preventDefault();
      setViewFrom(cur.from + (dx / r.width) * cur.span);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [player.loaded, zoomTo]);

  // Clicking the strip goes there — head AND start together. Clicking a spot
  // in a recording means "this is the bit I'm working on", and that's what the
  // start marker is for; leaving it behind where it was would only make you
  // say it twice.
  const seekTo = useCallback((e: MouseEvent) => {
    const el = stripRef.current;
    if (!el || !player.duration) return;
    setSel(null);
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    goTo(from + frac * span);
  }, [goTo, from, span]);

  // The waveform. Drawn at device resolution and re-drawn whenever the peaks,
  // the size or the colours change — it reads the palette off its own computed
  // style, so it follows the theme without knowing what the theme is.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const peaks = player.peaks;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!peaks.length) return;
      const cs = getComputedStyle(canvas);
      g.fillStyle = cs.getPropertyValue('--jp-wave').trim() || cs.color;
      const mid = h / 2;
      // The window's share of the peaks, and each pixel takes the loudest of
      // the buckets under it — zoomed out, there are several per pixel.
      const dur = player.duration || 1;
      const p0 = (from / dur) * peaks.length;
      const per = (span / dur) * peaks.length / w;
      for (let x = 0; x < w; x++) {
        const a = Math.floor(p0 + x * per);
        const b = Math.max(a + 1, Math.floor(p0 + (x + 1) * per));
        let peak = 0;
        for (let i = Math.max(0, a); i < Math.min(peaks.length, b); i++) if (peaks[i] > peak) peak = peaks[i];
        const half = Math.max(0.5, peak * (h / 2 - 1));
        g.fillRect(x, mid - half, 1, half * 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [player.peaks, loading, from, span]);

  // ── rendering ──────────────────────────────────────────────────────
  const songs = useMemo(() => {
    if (!library) return [];
    const rows = L.songsIn(library);
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(s => `${s.folder ?? ''} ${s.name}`.toLowerCase().includes(q));
  }, [library, query]);

  if (foldable && !open) {
    return (
      <button class="jp-fold-song" onClick={onToggle} aria-expanded={false} data-hint="unfold">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M9 18.5a2.5 2.5 0 1 1-2-2.45V6.2l11-2.2v10.5a2.5 2.5 0 1 1-2-2.45V6.44l-7 1.4V18.5Z" />
        </svg>
        <span class="jp-pane-title">Song</span>
      </button>
    );
  }

  const picker = picking && (
    <div class="jp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) setPicking(false); }}>
      <div class="jp-overlay-panel jp-song-pick" role="dialog" aria-modal="true" aria-label="Songs">
        <div class="jp-pane-head">
          <span class="jp-pane-title">Songs in this browser</span>
          <input
            class="jp-cheat-input" placeholder="filter" value={query} ref={filterRef}
            onInput={e => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="jp-song-list">
          {library == null && <div class="jp-song-empty">reading the library…</div>}
          {library != null && !songs.length && (
            <div class="jp-song-empty">
              {library.length ? 'nothing matches that' : 'no songs yet — upload an mp3'}
            </div>
          )}
          {songs.map(s => {
            const n = L.stemsIn(library!, s.id).filter(x => !L.droppedStems(s.id).has(x.id)).length;
            return (
              <div class="jp-song-item" key={s.id}>
              <button
                class={`jp-song-row${s.id === audio?.id ? ' on' : ''}`}
                onClick={() => {
                  setPicking(false);
                  if (s.id === audio?.id) return;
                  // A song that has been separated is attached on its STEMS:
                  // the mix is the thing you were trying to see inside, and
                  // hearing it over the parts is what you'd switch off first
                  // anyway. A song with no stems is just itself.
                  onChange({ id: s.id, start: 0, bookmarks: [], off: n ? [MIX] : [], rate: 1 });
                }}
              >
                <span class="jp-song-title">{songName(s.name)}</span>
                <span class="jp-song-meta">
                  {s.folder ? `${s.folder} · ` : ''}
                  {s.bpm ? `${Math.round(s.bpm)}bpm · ` : ''}
                  {fmt(s.duration ?? 0)}
                  {n ? ` · ${n} stem${n === 1 ? '' : 's'}` : ''}
                  {s.size ? ` · ${(s.size / 1048576).toFixed(1)} MB` : ''}
                </span>
              </button>
              <button
                class="jp-btn icon danger" data-hint="remove"
                aria-label={`Remove ${songName(s.name)} from this browser`}
                onClick={() => void forget(s)}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <path d="M6.6 5.2 12 10.6l5.4-5.4 1.4 1.4-5.4 5.4 5.4 5.4-1.4 1.4-5.4-5.4-5.4 5.4-1.4-1.4 5.4-5.4-5.4-5.4z" />
                </svg>
              </button>
              </div>
            );
          })}
        </div>
        <div class="jp-song-foot">
          <button class="jp-btn" onClick={chooseFile}>upload mp3…</button>
          <span class="jp-song-foot-gap" />
          {audio && (
            <button class="jp-btn danger" onClick={() => { setPicking(false); onChange(null); }}>
              detach
            </button>
          )}
          <button class="jp-btn" onClick={() => setPicking(false)}>done</button>
        </div>
      </div>
    </div>
  );

  const dur = player.duration;
  const tracks = player.tracks();

  // The selected run's own little row, floating over the strip: which marks
  // they are, a beat back, a beat on, and out. Over rather than in — the strip
  // is 40px of waveform, and a control put inside it would sit on top of the
  // very thing it is aiming. It names them as `M3` / `M3–M7` rather than as
  // "3" because M3 is what you would type in the transcription to meet it, and
  // for a single mark it says when the writing has no M3 yet — the one thing
  // about a mark you can't see by looking at the strip.
  //
  // The name is also the check: these buttons move and drop marks, and the
  // only way to be sure they're the marks you meant is to have said so and to
  // be reading their numbers while you aim at them. Hence a selection and not
  // a hover.
  const runFrom = range ? marks[range.from].at : 0;
  const runTo = range ? marks[range.to].at : 0;
  const runN = range ? range.to - range.from + 1 : 0;
  const named = !range ? '' : runN === 1 ? `M${range.from + 1}` : `M${range.from + 1}–M${range.to + 1}`;
  const aimed = !range ? '' : runN === 1 ? `mark ${range.from + 1}` : `marks ${range.from + 1} to ${range.to + 1}`;
  const markEditor = range != null && (
    <div
      class="jp-song-edit"
      style={`left: clamp(64px, ${posOf((runFrom + runTo) / 2) * 100}%, calc(100% - 64px))`}
      onClick={e => e.stopPropagation()}
    >
      <span class="jp-song-edit-n">{named}</span>
      <span class="jp-song-edit-at">
        {runN === 1
          ? `${fmt(runFrom)}${textMarks.includes(range.from + 1) ? '' : ` · no ${named} yet`}`
          : `${fmt(runFrom)}–${fmt(runTo)} · ${runN} marks`}
      </span>
      <button
        class="jp-btn icon" data-hint="a beat back"
        aria-label={`Move ${aimed} back a beat`}
        onClick={() => scootMarks(range.from, range.to, -1)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M14.25 5 7.5 12l6.75 7z" />
        </svg>
      </button>
      <button
        class="jp-btn icon" data-hint="a beat on"
        aria-label={`Move ${aimed} on a beat`}
        onClick={() => scootMarks(range.from, range.to, 1)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M9.75 5 16.5 12 9.75 19z" />
        </svg>
      </button>
      <button
        class="jp-btn icon danger" data-hint="drop"
        aria-label={`Drop ${aimed}`}
        onClick={() => dropRun(range.from, range.to)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M6.6 5.2 12 10.6l5.4-5.4 1.4 1.4-5.4 5.4 5.4 5.4-1.4 1.4-5.4-5.4-5.4 5.4-1.4-1.4 5.4-5.4-5.4-5.4z" />
        </svg>
      </button>
    </div>
  );

  return (
    <section class="jp-song" style={stripH ? `--jp-strip-h:${stripH}px` : undefined}>
      {player.loaded && (
        <div
          class="jp-song-grip" role="separator" aria-orientation="horizontal"
          aria-label="Resize the waveform" data-hint="drag · double-click to reset"
          onPointerDown={onGripDown as any}
          onDblClick={() => { setStripH(null); P.savePaneSize('song', 0); }}
        />
      )}
      <div class="jp-song-bar">
        {foldable && (
          <button class="jp-rail-toggle" aria-expanded onClick={onToggle} data-hint="fold">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M12 15.5 5.5 9h13z" />
            </svg>
          </button>
        )}

        {/* The title is truncated to keep the row on one line — so the hint
            carries the whole of it rather than repeating what the button
            already says. */}
        <button
          class="jp-btn jp-song-name"
          onClick={() => { if (audio) setPicking(true); else chooseFile(); }}
          data-hint={song ? songName(song.name) : 'upload an mp3'}
        >
          {song ? songName(song.name) : loading ? 'loading…' : 'attach a song'}
        </button>

        <button
          class="jp-btn icon"
          disabled={!player.loaded}
          data-hint={player.playing ? 'stop' : 'from the head'}
          aria-label={player.playing ? 'Stop' : 'Play from the playhead'}
          onClick={() => { if (player.playing) stop(); else void playFrom(head); }}
        >
          {player.playing ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 6h12v12H6z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.2 19 12 8 18.8z" /></svg>
          )}
        </button>

        <button
          class="jp-btn icon" disabled={!player.loaded}
          data-hint="from the start" aria-label="Play from the start marker"
          onClick={() => void playFrom(start)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M6 5.5h2v13H6zM10 12l9-6.5v13z" />
          </svg>
        </button>

        <span class="jp-song-time">{fmt(head)} <i>/ {fmt(dur)}</i></span>

        <button class="jp-btn icon" disabled={!player.loaded} data-hint="start here"
          aria-label="Set the start to the playhead" onClick={() => setStart(head)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M11 3h2v5h-2zM11 16h2v5h-2zM12 8.5A3.5 3.5 0 1 1 8.5 12 3.5 3.5 0 0 1 12 8.5Zm0 2A1.5 1.5 0 1 0 13.5 12 1.5 1.5 0 0 0 12 10.5ZM3 11h5v2H3zM16 11h5v2h-5z" />
          </svg>
        </button>
        <button class="jp-btn icon" disabled={!player.loaded} data-hint="bookmark"
          aria-label="Bookmark the playhead" onClick={() => addBookmark()}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4.2L6 21V4a1 1 0 0 1 1-1Zm1 2v12.2l4-2.8 4 2.8V5Z" />
          </svg>
        </button>
        {/* Zoom, a doubling at a time. A pinch on the strip does it finer. */}
        <span class="jp-song-zoom">
          <button class="jp-btn icon" disabled={!player.loaded || zoom <= 1} data-hint="zoom out"
            aria-label="Zoom the waveform out" onClick={() => zoomTo(zoom <= 1.01 ? 1 : zoom / 2)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M5 11h14v2H5z" />
            </svg>
          </button>
          <button class="jp-btn icon" disabled={!player.loaded || zoom >= ZOOM_MAX} data-hint="zoom in"
            aria-label="Zoom the waveform in" onClick={() => zoomTo(zoom * 2)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
            </svg>
          </button>
        </span>
      {song && (
        <>
          {/* One column per track: the switch, and under it how loud it sits.
              The switch alone answers "is the bass in or out"; the slider is
              for the other half of the question — a drum kit you want under
              the tune rather than gone, the mix left in at a whisper while you
              read a stem over it. A level is remembered through a mute, so a
              stem switched off and back comes back where you had it. */}
          <div class="jp-song-tracks">
            {tracks.map(t => (
              <div key={t.id} class="jp-song-track">
                <button
                  class={`jp-pill${t.on ? ' on' : ''}`}
                  data-hint={t.on ? 'in' : 'out'}
                  onClick={() => {
                    const on = !t.on;
                    player.setTrackOn(t.id, on);
                    const next = new Set(off);
                    if (on) next.delete(t.id); else next.add(t.id);
                    patch({ off: [...next] });
                    redraw();
                  }}
                >
                  {t.id === MIX ? 'mix' : L.stemLabel(stems.find(s => s.id === t.id)?.name ?? t.id)}
                </button>
                {/* The bubble goes on the label, not the input: a range input
                    is a replaced element and draws no ::after of its own. */}
                <label
                  class={`jp-song-lvl${t.on ? '' : ' out'}`}
                  data-hint={`${Math.round(t.level * 100)}%`}
                >
                  <input
                    class="jp-song-sld" type="range" min="0" max="1" step="0.01"
                    value={t.level}
                    aria-label={`How loud ${t.id === MIX ? 'the mix' : L.stemLabel(stems.find(s => s.id === t.id)?.name ?? t.id)} sits`}
                    onInput={e => {
                      const lvl = Number((e.target as HTMLInputElement).value);
                      player.setTrackLevel(t.id, lvl);
                      // Only what's been moved is written — see DocAudio.levels.
                      const next = { ...levels };
                      if (lvl >= 1) delete next[t.id]; else next[t.id] = lvl;
                      patch({ levels: next });
                      redraw();
                    }}
                  />
                </label>
              </div>
            ))}
          </div>

          <label class="jp-song-knob" data-hint={song.bpm ? 'tempo' : 'speed'}>
            <span>{song.bpm
              ? `${Math.round(song.bpm * player.getRate())}bpm`
              : `${Math.round(player.getRate() * 100)}%`}</span>
            <input
              class="jp-song-sld" type="range" min={RATE_MIN} max={RATE_MAX} step="0.01"
              value={player.getRate()}
              onInput={e => {
                const r = Number((e.target as HTMLInputElement).value);
                player.setRate(r);
                patch({ rate: r });
                redraw();
              }}
            />
          </label>

          {/* The recording, moved by a semitone at a time. Three small
              controls rather than a slider: it is a count, you almost
              always want ±1 or ±2 of it, and the number in the middle is
              both the readout and the way back to the recording as it
              was. */}
          <div class="jp-song-shift">
            <button
              class="jp-btn icon" data-hint="down a ½ step"
              aria-label="Play the recording a semitone lower"
              disabled={shift <= -SHIFT_MAX}
              onClick={() => setShift(shift - 1)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M5 11h14v2H5z" />
              </svg>
            </button>
            <button
              class={`jp-song-semis${shift ? ' on' : ''}`}
              data-hint={shift ? 'as recorded' : 'at pitch'}
              aria-label={shift ? `Moved ${shift} semitones — click for the recording's own pitch` : 'The recording at its own pitch'}
              onClick={() => setShift(0)}
            >{shift > 0 ? `+${shift}` : shift}</button>
            <button
              class="jp-btn icon" data-hint="up a ½ step"
              aria-label="Play the recording a semitone higher"
              disabled={shift >= SHIFT_MAX}
              onClick={() => setShift(shift + 1)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
              </svg>
            </button>
          </div>

          <label class="jp-song-knob vol" data-hint="volume">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M4 9h3.5L12 5v14L7.5 15H4zM15.5 8.6a4.6 4.6 0 0 1 0 6.8l-1.2-1.4a2.8 2.8 0 0 0 0-4z" />
            </svg>
            <input
              class="jp-song-sld" type="range" min="0" max="1" step="0.01" value={volume}
              onInput={e => {
                const v = Number((e.target as HTMLInputElement).value);
                setVolume(v);
                player.setVolume(v);
                try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* private mode */ }
              }}
            />
          </label>
        </>
      )}
      </div>

      {/* The waveform gets the window's whole width — it's the one thing here
          that reads better the more of it there is, and every marker on it is
          placed as a fraction of that width. */}
      {player.loaded && (
        <div class="jp-song-place">
          <div class="jp-song-strip" ref={stripRef} onClick={seekTo}>
            <canvas class="jp-song-wave" ref={canvasRef} />
            {/* No hint on the loops or on the start: both are drawn through by
                the pointer (pointer-events: none, so a click near one still
                seeks the strip), and a bubble that can never open is worse than
                none. The bookmarks take the pointer and do carry one. */}
            {loops.map(at => (
              <span key={`l${at}`} class="jp-song-loop" style={`left:${posOf(at) * 100}%`} />
            ))}
            {/* A run of more than one, drawn as the stretch of song it is:
                the marks in it are still each their own hairline, but what you
                selected was a passage, and a passage is a length rather than a
                handful of lines that happen to be lit. */}
            {range && range.to > range.from && (
              <span
                class="jp-song-band"
                style={`left:${posOf(runFrom) * 100}%; width:${(posOf(runTo) - posOf(runFrom)) * 100}%`}
              />
            )}
            {marks.map((b, i) => (
              /* Its number is written beside it, because the number is the whole
                 of what a mark is: it is what alt+1 aims at and what the M1 in
                 the transcription answers to, and a mark you have to count along
                 the strip to identify is one you will mis-aim. Clicking it goes
                 there AND picks it out: the row that edits it opens on it and
                 stays, so the marks those buttons are aimed at are ones you
                 named. Shift-clicking takes in everything between. There is no
                 gesture hidden in a second click.

                 No hint bubble: the strip clips its contents, and the row that
                 opens says everything a bubble would in the place you're about
                 to use it. */
              <span
                key={`b${b.at}`}
                class={`jp-song-mark${range && i >= range.from && i <= range.to ? ' on' : ''}`}
                style={`left:${posOf(b.at) * 100}%`}
                onClick={e => { e.stopPropagation(); pick(b.at, i, e.shiftKey); }}
              >
                <i class="jp-song-mark-n" aria-hidden="true">{i + 1}</i>
              </span>
            ))}
            {/* Where the next mark would go, if the ones already down are
                anything to go by. A guess is drawn as a guess: dashed, dimmer,
                and carrying the number it WOULD be. Clicking it goes there and
                leaves it a guess — which is how you check it by ear — and the
                + over it is what turns it into a mark. */}
            {guess && (
              <span
                class="jp-song-guess"
                style={`left:${posOf(guess.at) * 100}%`}
                data-hint={`next · ${fmt(guess.at)}`}
                onClick={e => { e.stopPropagation(); goTo(guess.at); }}
              >
                <i class="jp-song-mark-n" aria-hidden="true">{marks.length + 1}</i>
              </span>
            )}
            <span class="jp-song-start" style={`left:${posOf(start) * 100}%`} />
            <span class="jp-song-head" style={`left:${posOf(head) * 100}%`} />
          </div>
          {markEditor}
          {guess && (
            <button
              class="jp-song-take"
              style={`left: clamp(10px, ${posOf(guess.at) * 100}%, calc(100% - 10px))`}
              data-hint={`mark ${marks.length + 1} here`}
              aria-label={`Put mark ${marks.length + 1} at ${fmt(guess.at)}`}
              onClick={e => { e.stopPropagation(); addBookmark(guess.at); }}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
                <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
              </svg>
            </button>
          )}
        </div>
      )}

      {picker}
      <input
        ref={fileRef} type="file" accept="audio/*,.mp3" hidden
        onChange={e => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (f) void attachFile(f);
        }}
      />
    </section>
  );
}
