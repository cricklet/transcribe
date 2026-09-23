// Transcribe — write the source on the left, read engraved notation on
// the right, with your whole transcription library in the rail and the
// jianpu-ly syntax reference filterable alongside.
//
// jianpu-ly itself is a Python preprocessor that emits LilyPond, which we
// can't run in a browser, so jianpu/parse.ts reimplements its input language
// and jianpu/abc.ts lowers it to ABC for abcjs — the same renderer the melodic
// trainer, rhythm trainer and comping library use.

import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { keyAt, keyFromSpec, parseJianpu } from './parse';
import { romanWord } from './roman';
import { ChordMark, buildAbc, markCues } from './abc';
import { listenMidi } from './midi';
import { Editor, Flaw } from './editor';
import { hasNotesIn, keyChoices, planRespell } from './retune';
import { planTranspose } from './transpose';
import { Score, revealCue } from './staff';
import { CheatSheet } from './cheatsheet-pane';
import { Shortcuts } from './shortcuts-pane';
import { AudioCommands, AudioPane } from './audio-pane';
import { touchesMarks, withMarkAdded, withMarksDropped } from './marks';
import { Player, Pitching, PATCHES, PITCHING_SEMITONES, auditionChord, buildEvents, mixOf } from './playback';
import * as P from './persistence';
import * as H from './history';
import * as L from './songs';
import { DOXY_NAME, DOXY_TEXT } from './doxy';
import { FLANAGAN_NAME, FLANAGAN_TEXT } from './flanagan';
import { ChordFont, ChordView, Doc, DocAudio, DocSort, Side, Span, TICKS_PER_WHOLE, Voice, VOICES, VoiceMix } from './types';

const STARTER_TEXT = `1=C 4/4

1 2 3 4 | 5 - - -
`;

// The narrow breakpoint has to agree with the one in pages/transcribe.css,
// since it decides whether a drag resizes the editor's width or its height.
// Set wide on purpose: a side-by-side split only earns its keep when BOTH
// halves are comfortable, and below this the stacked layout — full-width
// source over full-width notation — reads better than two cramped columns.
const NARROW_QUERY = '(max-width: 1200px)';

// Below this there isn't room for a split at all — a phone, or a window pulled
// down to one. The app becomes the notation and nothing else: a header you
// scroll off the top, and the engraving under it. The second clause catches a
// phone on its side, where the width is fine but the height is the problem.
const PHONE_QUERY = '(max-width: 560px), (max-height: 500px) and (max-width: 1200px)';
// Two bars to a system is the phone-in-your-hand reading; turned sideways
// there's width for the usual four.
const TIGHT_QUERY = '(max-width: 560px)';

// What the editor needs to put itself back: see Editor’s `restore` prop.
type Restore = { caret: number; top: number; n: number };
// Putting a SCROLLER back where it was is a chase rather than an assignment.
// The engraving lands a few frames after the document does — abcjs needs the
// pane’s width before it can set a note — and a scrollTop asked for before the
// music is tall enough silently clamps to the bottom of what’s there. So it’s
// asked for again every frame until it takes, given up on after a moment
// either way, and abandoned the instant you scroll yourself, which is you
// saying where you’d rather be.
function chaseScroll(el: HTMLElement | null, top: number): () => void {
  if (!el || !(top > 0)) return () => {};
  let raf = 0;
  const until = performance.now() + 1500;
  const stop = () => {
    cancelAnimationFrame(raf);
    el.removeEventListener('wheel', stop);
    el.removeEventListener('pointerdown', stop);
  };
  const tick = () => {
    el.scrollTop = top;
    if (Math.abs(el.scrollTop - top) < 1 || performance.now() > until) { stop(); return; }
    raf = requestAnimationFrame(tick);
  };
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('pointerdown', stop);
  tick();
  return stop;
}

// One boolean per media query, kept live.
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fire = () => setOn(mq.matches);
    fire();
    mq.addEventListener('change', fire);
    return () => mq.removeEventListener('change', fire);
  }, [query]);
  return on;
}

// How long a caret move, a scroll or a moving playhead waits before the place
// it left is written down. Short enough that closing the tab mid-scroll keeps
// up, long enough that a song playing under the pointer isn’t a write a frame.
const PLACE_MS = 600;

// How long typing has to settle before the document is checkpointed. Long
// enough that a burst of edits becomes ONE entry in the history rather than
// twenty, short enough that walking away mid-thought still records it.
const BURST_MS = 20_000;

// How many bookmark changes ⌘Z can walk back through. Deep enough to cover a
// session's worth of placing and re-placing marks, and each entry is two
// copies of the text, so not unbounded.
const MARK_UNDO_DEPTH = 100;

// Whether two sets of bookmarks are the same set. Compared as written rather
// than field by field: it's a handful of numbers, and the question is only
// ever "did the marks move".
const marksOf = (a?: DocAudio) => JSON.stringify(a?.bookmarks ?? []);

// The chord faces, in the order the picker steps through them, and where each
// view starts: the handwritten face over a staff, and the mono the degrees
// themselves are set in over a page of numbers.
const CHORD_FACES: ChordFont[] = ['jazz', 'plain'];
const CHORD_FACE_DEFAULT: Record<ChordView, ChordFont> = { staff: 'jazz', numbers: 'plain' };

// How long a click waits before it sounds its note, so a double-click can
// claim the pair first. Long enough for a deliberate double-click (people
// land those inside ~200ms), short enough that click-to-hear still feels
// like it answers straight away.
const DOUBLE_CLICK_MS = 220;
// How long an auditioned chord rings. Short: stepping a chart with alt+] is a
// run of chords one after another, and a voicing still ringing when the next
// one lands turns the two into a third chord neither of them is. Long enough
// to hear the harmony, and then out of the way.
const CHORD_PREVIEW_SEC = 0.5;
// How long alt+<digit> waits for a second digit before taking itself as the
// whole number. Only ever waited when a two-digit bookmark starting with that
// digit actually exists — see `aim` — so it costs nothing in the ordinary
// case of a handful of marks.
const DIGIT_WAIT = 450;

// The selected transcription lives in ?doc=<id> so back/forward walk your
// history of documents and a link reopens the right one.
function docFromUrl(): string | null {
  try { return new URLSearchParams(location.search).get('doc'); } catch { return null; }
}
function putDocInUrl(id: string, mode: 'push' | 'replace') {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('doc') === id) return;
    url.searchParams.set('doc', id);
    history[mode === 'push' ? 'pushState' : 'replaceState']({ doc: id }, '', url);
  } catch { /* ignore */ }
}

function initialDocs(): Doc[] {
  const docs = P.loadDocs();
  if (docs.length) return docs;
  // A first visit opens on Doxy, with the Flanagan demo beside it.
  const doxy = P.newDoc(DOXY_NAME, DOXY_TEXT);
  doxy.swing = true;
  const flanagan = P.newDoc(FLANAGAN_NAME, FLANAGAN_TEXT);
  flanagan.swing = true;
  return [doxy, flanagan];
}

export function App() {
  const [docs, setDocs] = useState<Doc[]>(initialDocs);
  // A ?doc= in the URL wins over the last-used document, so a link opens what
  // it names.
  const [currentId, setCurrentId] = useState<string>(() => docFromUrl() ?? P.loadCurrentId() ?? '');
  const [explain, setExplain] = useState<boolean>(() => P.loadExplain());
  const [clickPlay, setClickPlay] = useState<boolean>(() => P.loadClickPlay());
  // The numbers view: jianpu degrees in place of noteheads, and no staff
  // under them.
  const [numbers, setNumbers] = useState<boolean>(() => P.loadNumbers());
  // …and, separately, whether the chords are read as roman numerals.
  const [roman, setRoman] = useState<boolean>(() => P.loadRoman());
  // Which face the chord symbols are set in — the handwritten chart face, the
  // plain one, or the same mono the source is written in. Kept per view, so
  // flipping to the numbers and back doesn't undo either choice.
  const [chordFonts, setChordFonts] = useState<Record<ChordView, ChordFont>>(() => ({
    staff: P.loadChordFont('staff', CHORD_FACE_DEFAULT.staff),
    numbers: P.loadChordFont('numbers', CHORD_FACE_DEFAULT.numbers),
  }));
  const [cheatOpen, setCheatOpen] = useState(false);
  // The shortcuts list (and how-it-works notes), from the top-right link or ?.
  const [keysOpen, setKeysOpen] = useState(false);
  const narrow = useMedia(NARROW_QUERY);
  // The phone layout: notation only, and the library arrives as a sheet.
  const phone = useMedia(PHONE_QUERY);
  const tight = useMedia(TIGHT_QUERY);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Bumped by "/" — the rail hears it and takes focus into its search box.
  const [findN, setFindN] = useState(0);
  const [paneW, setPaneW] = useState<number | null>(() => P.loadPaneSize('w'));
  const [paneH, setPaneH] = useState<number | null>(() => P.loadPaneSize('h'));
  const [railW, setRailW] = useState<number | null>(() => P.loadPaneSize('railW'));
  const [railH, setRailH] = useState<number | null>(() => P.loadPaneSize('railH'));
  const railRef = useRef<HTMLElement | null>(null);
  // The whole of the layout: which of the two side panes is up beside the
  // notation. ` walks the three stops and nothing else sets it — no strips to
  // click, no fold buttons, no unfold chevrons. The notation is always on the
  // page (it's what the window is for), the transcriptions and the source are
  // never on it together, and there's no combination of folds that can leave
  // you looking at nothing.
  const [side, setSide] = useState<Side>(() => P.loadSide());
  // The desktop never has neither up — a "neither" saved from the phone
  // opens the rail instead.
  useEffect(() => { if (!phone && side === 'none') setSide('docs'); }, [phone, side]);
  // The song strip along the bottom, and the handle onto its transport — the
  // keys that drive it have to work from inside the editor, where the pane
  // itself never sees them.
  const [songOpen, setSongOpen] = useState<boolean>(() => P.loadSongOpen());
  const songApi = useRef<AudioCommands | null>(null);
  // A bookmark key waiting to see whether a second digit is coming — see the
  // `aim` in the song-keys effect.
  const digitHeld = useRef<{ n: number; timer: number } | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  // The staff reads back into the text: hovering a note washes in the
  // characters that wrote it, clicking one sends the caret there.
  const [pickHover, setPickHover] = useState<Span | null>(null);
  // …and back the other way: where the caret is in the source, so the note it
  // is writing lights up on the staff. A character offset here; which NOTE
  // that is, is worked out against the engraving below (see caretLit).
  const [caret, setCaret] = useState<number | null>(null);
  const [jump, setJump] = useState<{ span: Span; n: number; quiet?: boolean } | null>(null);
  const jumpN = useRef(0);
  const [playing, setPlaying] = useState(false);
  // The MIDI keyboard, if one is plugged in: its name, and whether what it
  // plays is heard. Nothing is asked of you to get one working — see midi.ts.
  const [midiName, setMidiName] = useState<string | null>(null);
  const [midiOn, setMidiOn] = useState(() => P.loadMidiOn());
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  // Checkpoints of every document, newest first.
  const [history, setHistory] = useState<H.Checkpoint[]>(() => H.load());
  // The checkpoint the pointer is resting on: the staff shows THAT version
  // while the editor keeps the live one, so you can recognise a version
  // without committing to it.
  const [preview, setPreview] = useState<H.Checkpoint | null>(null);
  const [histOpen, setHistOpen] = useState(false);
  const [mixOpen, setMixOpen] = useState(false);
  // Where the mix dropdown hangs. Measured off the button and drawn FIXED, so
  // it escapes the pane it was opened from instead of being clipped by it.
  const mixBtnRef = useRef<HTMLButtonElement | null>(null);
  const [mixAt, setMixAt] = useState<{ top: number; right: number } | null>(null);
  const mixPanelRef = useRef<HTMLDivElement | null>(null);
  // A one-line confirmation that fades itself out: saving, importing, or an
  // import that couldn't be read. The nonce restarts the fade when the same
  // message happens twice.
  const [flash, setFlash] = useState<{ msg: string; bad?: boolean; n: number } | null>(null);
  const flashN = useRef(0);
  const say = useCallback((msg: string, bad = false) => {
    setFlash({ msg, bad, n: ++flashN.current });
  }, []);
  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) playerRef.current = new Player();
  // The stretch of the performance the last play covered — the transport's
  // "here", which the play button restarts from. `to` is null for "and on to
  // the end", which every play is.
  const lastRange = useRef<{ from: number; to: number | null }>({ from: 0, to: null });

  // The live library, for callbacks that must not close over a stale copy —
  // an import merges against whatever is on screen right now.
  const view: ChordView = numbers ? 'numbers' : 'staff';
  const chordFont = chordFonts[view];
  const cycleChordFont = useCallback(() => {
    setChordFonts(f => {
      const v: ChordView = numbers ? 'numbers' : 'staff';
      return { ...f, [v]: CHORD_FACES[(CHORD_FACES.indexOf(f[v]) + 1) % CHORD_FACES.length] };
    });
  }, [numbers]);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const currentIdRef = useRef(currentId);

  const currentDoc = docs.find(d => d.id === currentId) ?? docs[0];
  currentIdRef.current = currentDoc?.id ?? currentId;
  const text = currentDoc?.text ?? '';
  // Playback settings belong to the document, not the app.
  const swing = currentDoc?.swing ?? false;
  // How the notation is READ — an octave up, for a part whose instrument reads
  // there. Nothing about the playback moves with it.
  const octave = currentDoc?.octave ?? 0;
  // The bass staff's own — see the pair of 8va pills. Separate because the two
  // staves are read by two people, and only one of them is reading the tune.
  const bassOctave = currentDoc?.bassOctave ?? 0;
  // The three voices, as this song has them set. Everything not said falls
  // back to the defaults in playback.ts.
  const mix = useMemo(() => mixOf(currentDoc), [currentDoc?.mix]);
  const setVoice = useCallback((v: Voice, patch: Partial<VoiceMix>) => {
    patchDoc({ mix: { ...currentDoc?.mix, [v]: { ...currentDoc?.mix?.[v], ...patch } } });
  }, [currentDoc?.mix]);

  // Parse + engrave on every keystroke. Both are pure and cheap enough at
  // transcription sizes that there's no reason to debounce and watch the
  // notation lag behind the text.
  const score = useMemo(() => parseJianpu(text), [text]);
  // What the writing is pitched for, said by the text itself: CONCERT=Bb makes
  // the page a B♭ part, so everything the app SOUNDS — the score, a clicked
  // note, a MIDI keyboard played over it — comes out a tone lower and meets
  // the recording. Nothing on the page moves; see the directive in parse.ts.
  const pitching: Pitching = score.concert;
  const built = useMemo(
    () => score.movements.map((m, i) => buildAbc(m, i + 1, { numbers, roman, chordFont, reflow: phone, octaves: octave, bassOctaves: bassOctave })),
    [score, numbers, roman, chordFont, phone, octave, bassOctave],
  );
  // Which engraved note each M in the writing belongs over. Not part of the
  // engraving — the staff draws them in afterwards, so a marked score sits
  // exactly where an unmarked one does.
  const cues = useMemo(() => markCues(score.movements, score.marks), [score]);
  // Where every chord chart sits in the source, for the editor's hover bar. A
  // chart is the unit a wrong key is wrong in — you paste a form and it's a
  // tone out — so the bar moves the whole of one, and the spans come from the
  // parser rather than from a second reading of the text.
  // What this chart actually HAS, so the mixer can say which of its three
  // rows are about something and which are waiting for you to write it.
  const hasBass = useMemo(
    () => score.movements.some(m => m.unders.some(u => u.kind === 'bass' && u.items.length > 0)),
    [score],
  );
  const hasChords = useMemo(() => score.movements.some(m => m.chords.length > 0), [score]);
  // A T: staff is a written-out part rather than a symbol to comp, but it
  // sounds on the same voice — so it counts as something for that voice to do.
  const hasTreble = useMemo(
    () => score.movements.some(m => m.unders.some(u => u.kind === 'treble' && u.items.length > 0)),
    [score],
  );
  const charts = useMemo(
    () => score.movements.flatMap(m => m.items
      .filter(i => i.kind === 'mark' && i.mark.t === 'chordline')
      .map(i => i.src)),
    [score],
  );
  // Everything wrong with the source, in one list for the editor to squiggle:
  // the parser's errors and warnings plus the engraver's. Nothing is printed
  // under the pane any more — each one is read where it happened.
  const flaws = useMemo<Flaw[]>(() => [
    ...score.errors.map(d => ({ ...d, kind: 'err' as const })),
    ...score.warnings.map(d => ({ ...d, kind: 'warn' as const })),
    ...built.flatMap(b => b.warnings).map(d => ({ ...d, kind: 'warn' as const })),
  ], [score, built]);
  // Hovering a checkpoint engraves THAT text in the staff pane. The editor is
  // left alone — you're looking, not editing — and the staff's read-back into
  // the source is switched off while you are, since those offsets belong to a
  // different version of the text.
  const previewBuilt = useMemo(() => {
    if (!preview) return null;
    const was = parseJianpu(preview.text);
    return {
      built: was.movements.map((m, i) => buildAbc(m, i + 1, { numbers, roman, chordFont, reflow: phone, octaves: octave, bassOctaves: bassOctave })),
      cues: markCues(was.movements, was.marks),
    };
  }, [preview, numbers, roman, chordFont, phone, octave, bassOctave]);
  const shown = previewBuilt?.built ?? built;
  const shownCues = previewBuilt?.cues ?? cues;

  // The note the caret is in — or, when it sits between notes (in the space
  // after one, on a barline, out on a lyric), the last one it passed. Which is
  // how reading a caret works everywhere else: you are in the word you just
  // typed, not in the one you are about to.
  //
  // Every engraved staff is searched, the ones under the music included, so a
  // caret in a B: line lights the bass note it wrote. The block is carried
  // along with the span because a score in several movements engraves one
  // Score each, and only one of them holds the caret.
  const caretLit = useMemo<{ block: number; span: Span } | null>(() => {
    if (caret == null || preview) return null;
    let best: { block: number; span: Span } | null = null;
    const take = (block: number, span: Span | null) => {
      if (!span || span.start > caret) return;
      // Inside one wins over merely being after it, and of two that both
      // contain the caret (a note inside a bracket) the innermost does.
      if (best && best.span.start >= span.start) return;
      best = { block, span };
    };
    for (let i = 0; i < shown.length; i++) {
      for (const span of shown[i].noteSpans) take(i, span);
      for (const u of shown[i].unders) for (const span of u.spans) take(i, span);
    }
    return best;
  }, [caret, shown, preview]);

  // ── where you were ─────────────────────────────────────────────────
  //
  // The caret, both panes’ scroll and the recording’s head, kept per
  // transcription (see P.Place) and put back when you open it again. It all
  // runs off refs: the head moves sixty times a second while a song plays,
  // and none of that is worth a render.
  const place = useRef<{ id: string; at: P.Place }>({ id: '', at: {} });
  const placeTimer = useRef<number | null>(null);
  const flushPlace = useCallback(() => {
    if (placeTimer.current != null) { clearTimeout(placeTimer.current); placeTimer.current = null; }
    if (place.current.id) P.savePlace(place.current.id, place.current.at);
  }, []);
  // Note what moved. Which document it belongs to is whichever one is open
  // NOW, so a scroll that arrives a beat after a switch is filed against the
  // right one — and the place being kept for the last one is written out
  // before we let go of it.
  const markPlace = useCallback((patch: P.Place) => {
    const id = currentIdRef.current;
    if (!id) return;
    if (place.current.id !== id) {
      flushPlace();
      place.current = { id, at: P.loadPlace(id) ?? {} };
    }
    place.current.at = { ...place.current.at, ...patch };
    if (placeTimer.current == null) placeTimer.current = window.setTimeout(flushPlace, PLACE_MS);
  }, [flushPlace]);
  const markCaret = useCallback((at: number) => { setCaret(at); markPlace({ caret: at }); }, [markPlace]);
  const markSrcScroll = useCallback((top: number) => markPlace({ src: top }), [markPlace]);
  const markScoreScroll = useCallback((e: Event) => {
    markPlace({ score: (e.currentTarget as HTMLElement).scrollTop });
  }, [markPlace]);
  // A tab being closed or sent to the background runs no cleanups, so the
  // write waiting out its debounce is forced through here.
  useEffect(() => {
    const out = () => flushPlace();
    window.addEventListener('pagehide', out);
    document.addEventListener('visibilitychange', out);
    return () => {
      window.removeEventListener('pagehide', out);
      document.removeEventListener('visibilitychange', out);
      flushPlace();
    };
  }, [flushPlace]);

  // The document that's open takes its place over during RENDER rather than
  // from an effect — a child's effects run before its parent's, so a place
  // adopted in an effect would arrive after the editor had already restored
  // itself from the document before. The one we're leaving is written out on
  // the way past.
  const restoreN = useRef(0);
  if (place.current.id !== (currentDoc?.id ?? '')) {
    flushPlace();
    const id = currentDoc?.id ?? '';
    place.current = { id, at: (id && P.loadPlace(id)) || {} };
    restoreN.current++;
  }
  // What the editor puts itself back to. Rebuilt every render off the live
  // place, so the source pane rotating back into view lands on the line you
  // were last on rather than the one the document opened at; the nonce only
  // moves when the document does, which is the only time it's a JUMP.
  const editorPlace: Restore = {
    caret: place.current.at.caret ?? 0,
    top: place.current.at.src ?? 0,
    n: restoreN.current,
  };
  // Where the recording should pick up — a head of 0 is nothing remembered,
  // and falls back to the start marker the way it always did.
  const resumeAt = place.current.at.head || null;

  // The notation's scroller, whichever layout drew it — only one of the two is
  // ever on the page — put back where it was once there's an engraving tall
  // enough to hold it.
  const scoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => chaseScroll(scoreRef.current, place.current.at.score ?? 0),
    [currentDoc?.id, side, phone],
  );

  // Persist locally on every change; the sync layer debounces the cloud write.
  useEffect(() => { P.saveDocs(docs); }, [docs]);
  useEffect(() => { P.saveHistory(history); }, [history]);
  useEffect(() => { if (currentDoc) { setCurrentId(currentDoc.id); P.saveCurrentId(currentDoc.id); } }, [currentDoc?.id]);
  useEffect(() => { P.saveExplain(explain); }, [explain]);
  useEffect(() => { P.saveClickPlay(clickPlay); }, [clickPlay]);
  // The player owns the gain buses, so a volume moved mid-performance takes
  // effect on the note that's already sounding — which is the whole point of
  // being able to move it while the music runs.
  useEffect(() => { playerRef.current?.setMix(mix); }, [mix]);

  // The dropdown follows its button: measured when it opens, and again
  // whenever anything could have moved it. Fixed rather than absolute, so no
  // pane it was opened inside can clip it.
  useLayoutEffect(() => {
    if (!mixOpen) { setMixAt(null); return; }
    const place = () => {
      const b = mixBtnRef.current?.getBoundingClientRect();
      if (!b) return;
      setMixAt({ top: Math.round(b.bottom + 6), right: Math.round(window.innerWidth - b.right) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [mixOpen]);

  // …and closes the way a dropdown does: a click anywhere else, or Escape.
  useEffect(() => {
    if (!mixOpen) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (mixPanelRef.current?.contains(t) || mixBtnRef.current?.contains(t)) return;
      setMixOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMixOpen(false); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [mixOpen]);

  // Changing the mix makes no sound of its own. It used to play a bar of ii–V
  // at you on every nudge, which is noise you didn't ask for — the levels go
  // where you put them, and you hear them on the next thing you play.
  useEffect(() => { P.saveNumbers(numbers); }, [numbers]);
  useEffect(() => { P.saveRoman(roman); }, [roman]);
  useEffect(() => { P.saveChordFont(view, chordFont); }, [view, chordFont]);

  // Pull D1 once on mount and merge it with the local cache — neither side
  // gets to erase the other. An explicit ?doc= still picks what opens.
  useEffect(() => {
    let alive = true;
    const pinned = docFromUrl();
    // A migration that rewrote a document on the way in gets checkpointed
    // under its old text, so an automatic rewrite is always walk-backable.
    const backups = P.takeMigrationBackups();
    if (backups.length) {
      setHistory(h => backups.reduce(
        (acc, b) => H.capture(acc, { ...b.doc, text: b.before }, { label: `before syntax v${b.doc.syntax}` }),
        h));
    }
    P.hydrate().then(r => {
      if (!alive) return;
      if (r.docs) setDocs(r.docs);
      if (r.history) setHistory(r.history);
      if (r.currentId && !pinned) setCurrentId(r.currentId);
      for (const b of P.takeMigrationBackups()) {
        setHistory(h => H.capture(h, { ...b.doc, text: b.before }, { label: `before syntax v${b.doc.syntax}` }));
      }
    });
    return () => { alive = false; };
  }, []);

  // ── checkpoints ────────────────────────────────────────────────────
  // A burst of typing becomes one checkpoint, taken once it settles. The
  // timer restarts on every keystroke, so the entry records where the session
  // ENDED rather than some arbitrary moment inside it.
  useEffect(() => {
    if (!currentDoc) return;
    const doc = currentDoc;
    const t = setTimeout(() => setHistory(h => H.capture(h, doc)), BURST_MS);
    return () => clearTimeout(t);
  }, [currentDoc?.id, text]);

  // Leaving the page mid-burst shouldn't lose the burst.
  useEffect(() => {
    function flush() {
      const doc = docsRef.current.find(d => d.id === currentDoc?.id);
      if (doc) {
        const next = H.capture(H.load(), doc);
        H.save(next);
      }
    }
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [currentDoc?.id]);

  // Restoring is purely additive: where you are now is checkpointed first
  // (labelled, so thinning can never take it), the checkpoint you came from
  // stays exactly where it was, and the text changes. Nothing in the history
  // is dropped or rewritten — walking back is itself walk-backable.
  const restore = useCallback((cp: H.Checkpoint) => {
    const doc = docsRef.current.find(d => d.id === cp.docId);
    if (!doc) return;
    if (doc.text === cp.text) { say('that version is what you already have'); return; }
    setHistory(h => H.capture(h, doc, { label: `before restoring ${H.ago(cp.at)}` }));
    setDocs(ds => ds.map(d => (d.id === doc.id ? { ...d, text: cp.text, updated: Date.now() } : d)));
    setPreview(null);
    say(`restored ${H.ago(cp.at)} — the version you left is in the history`);
  }, [say]);

  const pinNow = useCallback(() => {
    const doc = docsRef.current.find(d => d.id === currentId);
    if (!doc) return;
    setHistory(h => H.capture(h, doc, { pinned: true }));
    setHistOpen(true);
    say('pinned this version');
  }, [currentId, say]);

  const docHistory = useMemo(
    () => history.filter(c => c.docId === currentDoc?.id),
    [history, currentDoc?.id],
  );

  // ── URL ↔ selection ────────────────────────────────────────────────
  // Selecting from the rail pushes a history entry; everything else (first
  // load, hydrate, deleting the open document) only rewrites the current one,
  // so Back always steps between documents you actually chose.
  const selectDoc = useCallback((id: string) => {
    // You're done with the one you're leaving, so record it now rather than
    // waiting out a burst timer that will never fire.
    const leaving = docsRef.current.find(d => d.id === currentIdRef.current);
    if (leaving && leaving.id !== id) setHistory(h => H.capture(h, leaving));
    setCurrentId(id);
    setPreview(null);
    putDocInUrl(id, 'push');
  }, []);

  useEffect(() => {
    if (currentDoc) putDocInUrl(currentDoc.id, 'replace');
  }, [currentDoc?.id]);

  useEffect(() => {
    function onPop() {
      const id = docFromUrl();
      if (id) setCurrentId(id);
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ── layout ─────────────────────────────────────────────────────────
  // On the phone the header is part of the scroll, so it gets out of the way
  // once you're reading — and a round transport fades in at the corner to
  // stand in for it, rather than making you scroll back up to stop the music.
  const phoneHeadRef = useRef<HTMLElement | null>(null);
  const [headGone, setHeadGone] = useState(false);
  useEffect(() => {
    if (!phone) { setHeadGone(false); return; }
    const el = phoneHeadRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setHeadGone(!e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [phone]);

  // Drag the divider: sideways in the wide layout (sets the width of whichever
  // side pane is up), downward in the stacked one (sets its height). Each pane
  // and layout is remembered under its own key, so switching restores the
  // size that one had.
  const onSplitterDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    const rail = side === 'docs';
    const pane = rail ? railRef.current : editorPaneRef.current;
    if (!pane) return;
    const box = pane.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = box.width, startH = box.height;
    const vertical = !narrow;
    const key: P.PaneSize = rail ? (vertical ? 'railW' : 'railH') : (vertical ? 'w' : 'h');
    const set = { w: setPaneW, h: setPaneH, railW: setRailW, railH: setRailH }[key as 'w'];
    document.body.classList.add(vertical ? 'jp-resizing-x' : 'jp-resizing-y');

    let latest = vertical ? startW : startH;
    function move(ev: PointerEvent) {
      latest = vertical
        ? clamp(startW + ev.clientX - startX, rail ? 220 : 280, Math.max(320, window.innerWidth - 420))
        : clamp(startH + ev.clientY - startY, rail ? 90 : 160, Math.max(200, window.innerHeight - 160));
      set(latest);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      document.body.classList.remove('jp-resizing-x', 'jp-resizing-y');
      P.savePaneSize(key, latest);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }, [narrow, side]);

  // Double-click the divider to forget the size and go back to the default.
  const resetPane = useCallback(() => {
    const rail = side === 'docs';
    if (narrow) { (rail ? setRailH : setPaneH)(null); P.savePaneSize(rail ? 'railH' : 'h', 0); }
    else { (rail ? setRailW : setPaneW)(null); P.savePaneSize(rail ? 'railW' : 'w', 0); }
  }, [narrow, side]);

  // ── the pane rotation, and the cheat sheet ─────────────────────────
  // ` works from anywhere, including mid-edit in the textarea — capture phase
  // and preventDefault, so the key never reaches the field. ` isn't part of
  // jianpu-ly's syntax, so nothing is lost by claiming it.
  // Bound ONCE — a global hotkey that re-registered on every state change
  // would tear down and re-add its listener mid-interaction. It reads the
  // current values through refs instead of through the dependency array.
  const cheatOpenRef = useRef(cheatOpen);
  cheatOpenRef.current = cheatOpen;
  const keysOpenRef = useRef(keysOpen);
  keysOpenRef.current = keysOpen;
  // Which pane is up, and whether the phone's library sheet is — read by the
  // same bound-once handler, for the "/" below.
  const sideRef = useRef(side);
  sideRef.current = side;
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ` walks the rotation: transcriptions → source → neither, and round
      // again. On the desktop it only swaps the two — there's room for a
      // pane beside the engraving, so the rail is never put away.
      if (e.key === '`' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setSide(v => (v === 'docs' ? 'source'
          : v === 'source' && phoneRef.current ? 'none' : 'docs'));
        return;
      }
      // "/" reaches for the library's search box — but only when the library
      // is the pane that's up, and only outside a field: "/" is a character
      // in the source (4/4, and the crushed grace g/[ … ]), and inside the
      // search box itself it's one more letter of the query.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (sideRef.current !== 'docs' && !pickerOpenRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        setFindN(n => n + 1);
        return;
      }
      // alt+/ is the reference. Matched on the physical key like every other
      // alt chord here: alt+/ on a Mac is ÷, not a slash.
      if (e.code === 'Slash' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        setKeysOpen(false);
        setCheatOpen(v => !v);
        return;
      }
      // ? is the shortcuts list — outside a field, where it's just a character.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopPropagation();
        setCheatOpen(false);
        setKeysOpen(v => !v);
        return;
      }
      // Escape closes the reference if it's up, the way any popover closes.
      // It does nothing else global — everywhere else Escape already means
      // clear the search, finish the rename, drop the respell menu.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (cheatOpenRef.current || keysOpenRef.current) {
          e.preventDefault();
          setCheatOpen(false);
          setKeysOpen(false);
        }
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ── respelling a selection into another key centre ──────────────────
  // The passage keeps every pitch it had; only the numbers move, around a new
  // 1=. The editor draws the menu (it's the one that knows where the selection
  // sits on screen); the parsing all happens here.
  const respell = useMemo(() => ({
    choices: keyChoices(score.keys).map(k => ({ spec: k.label, name: k.name })),
    usable: (start: number, end: number) => hasNotesIn(text, score, start, end),
    currentAt: (offset: number) => keyAt(score.keys, offset).key.label,
    plan: (start: number, end: number, spec: string) => {
      const target = keyFromSpec(spec);
      if (!target) return { error: `"${spec}" isn't a key` };
      const plan = planRespell(text, score, start, end, target);
      // A respell rewrites a passage in one go. Checkpoint what it looked
      // like first, labelled, so it's always one click back.
      if (!('error' in plan)) {
        const doc = docsRef.current.find(d => d.id === currentIdRef.current);
        if (doc) setHistory(h => H.capture(h, doc, { label: `before respell to ${target.name}` }));
      }
      return plan;
    },
    // …and the same menu's other line: the passage MOVED. Same checkpoint, for
    // the same reason — it rewrites a passage in one go.
    transpose: (start: number, end: number, semitones: number) => {
      const plan = planTranspose(text, score, start, end, semitones);
      if (!('error' in plan)) {
        const doc = docsRef.current.find(d => d.id === currentIdRef.current);
        if (doc) setHistory(h => H.capture(h, doc, { label: `before transposing to ${plan.key}` }));
      }
      return plan;
    },
    // A chart's chords, each rewritten the other way: letters into numerals
    // in the key in force where each sits, or numerals back into the letters
    // they were read as. Whichever way, the whole chart goes — a chart with any
    // letter chord in it goes to numerals.
    toRoman: (start: number, end: number) => chartWords(start, end).some(w => !w.roman),
    romanize: (start: number, end: number) => {
      const words = chartWords(start, end);
      const toNumerals = words.some(w => !w.roman);
      const edits: { start: number; end: number; text: string }[] = [];
      for (const w of words) {
        const next = toNumerals
          ? (w.roman ? null : romanWord(w.sym, keyAt(score.keys, w.src.start).key))
          : w.sym;
        if (next != null && next !== text.slice(w.src.start, w.src.end)) edits.push({ ...w.src, text: next });
      }
      if (!edits.length) return { error: toNumerals ? 'no chords to number' : 'nothing to change' };
      let out = text.slice(start, end);
      for (const e of edits.slice().sort((a, b) => b.start - a.start)) {
        out = out.slice(0, e.start - start) + e.text + out.slice(e.end - start);
      }
      // Letters name their chords outright: a bracketed run's [ ] and the
      // numeral it leads to have nothing left to say.
      if (!toNumerals) out = out.replace(/\]\s*\/\s*[^\s|:\]]+/g, '').replace(/[[\]]/g, '');
      const doc = docsRef.current.find(d => d.id === currentIdRef.current);
      if (doc) setHistory(h => H.capture(h, doc, { label: toNumerals ? 'before chords as numerals' : 'before chords as letters' }));
      return { from: start, to: end, replacement: out, selection: { start, end: start + out.length }, notes: 0 };
    },
  }), [score, text]);

  // The words of the C" charts that sit inside [start, end).
  function chartWords(start: number, end: number) {
    const out: { sym: string; src: Span; roman?: string }[] = [];
    for (const m of score.movements) {
      for (const it of m.items) {
        if (it.kind !== 'mark' || it.mark.t !== 'chordline') continue;
        for (const bar of it.mark.bars) for (const w of bar) {
          if (w.src.start >= start && w.src.end <= end) out.push(w);
        }
      }
    }
    return out;
  }

  // ── the library ────────────────────────────────────────────────────
  const setText = useCallback((t: string) => {
    setDocs(ds => ds.map(d => (d.id === currentDoc?.id ? { ...d, text: t, updated: Date.now() } : d)));
  }, [currentDoc?.id]);

  const patchDoc = useCallback((patch: Partial<Doc>) => {
    setDocs(ds => ds.map(d => (d.id === currentDoc?.id ? { ...d, ...patch } : d)));
  }, [currentDoc?.id]);

  function renameDoc(id: string, name: string) {
    setDocs(ds => ds.map(d => (d.id === id ? { ...d, name } : d)));
  }

  function newDoc() {
    const d = P.newDoc('New transcription', STARTER_TEXT);
    // Swung, to start with — it's jazz that gets transcribed here.
    d.swing = true;
    setDocs(ds => [d, ...ds]);
    setCurrentId(d.id);
  }

  function deleteDoc(id: string) {
    // Leave a mark, so the next hydrate merge doesn't hand it back.
    P.recordDelete(id);
    setDocs(ds => {
      const idx = ds.findIndex(d => d.id === id);
      let next = ds.filter(d => d.id !== id);
      if (!next.length) next = [P.newDoc('New transcription', STARTER_TEXT)];
      if (id === currentId) setCurrentId(next[Math.min(idx, next.length - 1)].id);
      return next;
    });
  }

  // Import a JSON backup — the "export all" array, or one document as ⌘S
  // writes it. Strictly ADDITIVE: nothing already in the library is replaced
  // or renamed, because the reason you're importing is that you lost
  // something, and an import that could overwrite is a second way to lose it.
  // A document whose name and text you already have is skipped, so importing
  // the same file twice doesn't stack up copies.
  const importFile = useCallback(async (file: File) => {
    let incoming: Doc[] = [];
    let raw: any;
    try {
      raw = JSON.parse(await file.text());
      incoming = P.docsFromJson(raw);
    } catch {
      say(`couldn’t read ${file.name}`, true);
      return;
    }
    // Songs first, so the transcriptions that name them find them on load.
    const songs = raw && typeof raw === 'object' ? await L.restoreSongs(raw.songs) : 0;
    if (songs) songApi.current?.reloadLibrary();
    const songsSaid = songs ? ` and ${songs} song${songs === 1 ? '' : 's'}` : '';
    if (!incoming.length) { say(`no transcriptions in ${file.name}`, true); return; }

    const have = docsRef.current;
    const seen = new Set(have.map(d => `${d.name} ${d.text}`));
    const taken = new Set(have.map(d => d.id));
    const fresh: Doc[] = [];
    for (const d of incoming) {
      const key = `${d.name} ${d.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A clash of ids means the file was exported from this library and the
      // document has since changed. Both readings are worth keeping, so the
      // incoming one comes in BESIDE the current one, never over it.
      const id = taken.has(d.id) ? P.newId('i') : d.id;
      taken.add(id);
      fresh.push({ ...d, id });
    }
    if (!fresh.length) { say(`already had everything in ${file.name}${songs ? ` (restored${songsSaid.slice(4)})` : ''}`); return; }
    setDocs(ds => [...fresh, ...ds]);
    setCurrentId(fresh[0].id);
    say(`imported ${fresh.length} transcription${fresh.length === 1 ? '' : 's'}${songsSaid}`);
  }, []);

  // Importing is a drag onto the page — anywhere on it — rather than a button
  // to find, since the file is already under your pointer in the Finder.
  // Files only: a drag of TEXT is the editor's business, so those events go
  // by untouched (calling preventDefault on them would break dropping words
  // into the source).
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    // Crossing into a child fires dragleave on the element behind it, so the
    // scrim counts enters and leaves instead of trusting a single leave.
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    function onEnter(e: DragEvent) { if (files(e)) { depth++; setDropping(true); } }
    function onOver(e: DragEvent) {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    function onLeave(e: DragEvent) { if (files(e) && --depth <= 0) { depth = 0; setDropping(false); } }
    function onDrop(e: DragEvent) {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0; setDropping(false);
      for (const f of Array.from(e.dataTransfer?.files ?? [])) {
        // An mp3 dropped anywhere is attached to the open transcription.
        if (/^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name)) {
          if (songApi.current) songApi.current.attachFile(f);
          else say('open the song strip to attach a recording', true);
          continue;
        }
        if (!/\.json$/i.test(f.name) && f.type !== 'application/json') {
          say(`${f.name} isn’t a JSON backup or an mp3`, true);
          continue;
        }
        importFile(f);
      }
    }
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importFile, say]);

  function duplicateDoc(id: string) {
    const src = docs.find(d => d.id === id);
    if (!src) return;
    // The copy is the same text, so it's the same language version as its
    // source — not necessarily the current one, if the source was pinned.
    const d = P.newDoc(`${src.name} copy`, src.text, src.syntax);
    // …and everything else the document knows about this song comes too: the
    // recording it was transcribed from, where you were in it and the marks on
    // its strip, the mix, the swing, the octaves each staff is read at. A copy
    // you have to set all of that up on again is a copy of the TEXT, not of the
    // transcription — and the text is the thing you were about to change.
    // Cloned rather than shared, so moving a bookmark on one leaves the other
    // where it was. (`pitching` is not among them: it's legacy, and migrate.ts
    // has long since moved it into the source the copy already carries.)
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
    if (src.audio) d.audio = clone(src.audio);
    if (src.mix) d.mix = clone(src.mix);
    if (src.swing != null) d.swing = src.swing;
    if (src.octave != null) d.octave = src.octave;
    if (src.bassOctave != null) d.bassOctave = src.bassOctave;
    setDocs(ds => [d, ...ds]);
    setCurrentId(d.id);
  }

  // ── playback ───────────────────────────────────────────────────────
  // Movements play back to back with a beat of air between them.
  const { playback, startAt } = useMemo(() => {
    const all: ReturnType<typeof buildEvents>['events'] = [];
    // Source offset → when that token sounds, so double-clicking a note on the
    // staff can start the performance there. First one wins: a rest split for
    // a chord symbol writes several items from the one token.
    const at = new Map<number, { end: number; at: number; midis: number[]; dur: number; voice: Voice }>();
    let offset = 0;
    for (const m of score.movements) {
      const { events, totalSec, starts } = buildEvents(m, {
        pitching, swing, chords: mix.chords.on, bass: mix.bass.on,
      });
      for (const e of events) all.push({ ...e, at: e.at + offset });
      for (const s of starts) if (!at.has(s.start)) at.set(s.start, { end: s.end, at: s.at + offset, midis: s.midis, dur: s.dur, voice: s.voice });
      offset += totalSec + 1;
    }
    return { playback: all, startAt: at };
  }, [score, pitching, swing, mix.chords.on, mix.bass.on]);

  useEffect(() => { P.saveSide(side); }, [side]);
  useEffect(() => { P.saveSongOpen(songOpen); }, [songOpen]);
  useEffect(() => { P.saveMidiOn(midiOn); }, [midiOn]);

  const stopPlayback = useCallback(() => {
    playerRef.current?.stop();
    setPlaying(false);
  }, []);

  // Editing, switching document or changing the pitching all invalidate what's
  // scheduled — the audio clock is already committed, so cut it. The seconds
  // a double-click picked don't survive an edit either: the bar they pointed
  // at has moved.
  useEffect(() => { stopPlayback(); lastRange.current = { from: 0, to: null }; }, [text, currentDoc?.id, pitching, swing, mix.chords.on, mix.bass.on, stopPlayback]);
  useEffect(() => () => playerRef.current?.stop(), []);

  // Start (or restart) the performance at `from` seconds in, running to `to`
  // (or to the end of the piece). Everything outside that window is dropped and
  // the rest slides back to zero, so the audio clock still starts at the
  // beginning of what's actually going to sound.
  const playFrom = useCallback(async (from: number, to: number | null = null) => {
    const player = playerRef.current;
    if (!player) return;
    // One at a time. The recording and the transcription aren't on the same
    // clock — a count-in, a rubato intro, a drummer who breathes — so playing
    // both would only ever be two performances arguing. (A single note
    // auditioned with alt+[ / alt+] is a different thing and doesn't count:
    // that one is FOR checking against the record.)
    songApi.current?.stop();
    lastRange.current = { from, to };
    const events = from > 0 || to != null
      ? playback
        .filter(e => e.at + e.dur > from && (to == null || e.at < to))
        .map(e => {
          // Trim to the window at both ends, so a note ringing in from before
          // the passage starts with the passage, and a tie running out the far
          // side stops there rather than dragging the audition on.
          const at = Math.max(e.at, from);
          const end = to == null ? e.at + e.dur : Math.min(e.at + e.dur, to);
          return { ...e, at: at - from, dur: Math.max(0.05, end - at) };
        })
      : playback;
    if (!events.length) { stopPlayback(); return; }
    setAudioBusy(true);
    setAudioErr(null);
    try {
      await player.play(events, () => setPlaying(false));
      setPlaying(true);
    } catch (e) {
      setAudioErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAudioBusy(false);
    }
  }, [playback, stopPlayback]);

  // Play/stop. Stopped, it restarts from wherever playback last began — so
  // after double-clicking bar 9, play keeps replaying bar 9 rather than
  // dragging you back to the top. Editing resets that to the beginning.
  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.playing) { stopPlayback(); return; }
    if (!playback.length) return;
    playFrom(lastRange.current.from, lastRange.current.to);
  }, [playback, playFrom, stopPlayback]);

  // A single click sounds just the note it landed on, so you can read a chart
  // by pointing at it. Rests and percussion beats have nothing to sound and
  // simply move the caret.
  //
  // It waits out the double-click window first. A double-click means "play from
  // here", and the performance strikes that very note a moment later — sounding
  // it on the way in as well flams it, and the second click of the pair would
  // otherwise strike it a third time. Clicking a DIFFERENT note doesn't wait:
  // no double-click spans two notes, so the one already queued is let go
  // immediately and the new one takes its place.
  const pending = useRef<{ timer: number; span: number; fire: () => void } | null>(null);
  const dropPreview = useCallback((flush: boolean) => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    if (flush) p.fire();
  }, []);
  useEffect(() => () => dropPreview(false), [dropPreview]);

  const previewSpan = useCallback((span: Span) => {
    dropPreview(pending.current?.span !== span.start);
    if (!clickPlay) return;
    const found = startAt.get(span.start);
    if (!found?.midis.length) return;
    // Auditioned on the voice it belongs to, so a bass note sounds like one.
    const fire = () => playerRef.current?.preview(found.midis, found.dur, found.voice).catch(e => {
      setAudioErr(e instanceof Error ? e.message : String(e));
    });
    const timer = window.setTimeout(() => { pending.current = null; fire(); }, DOUBLE_CLICK_MS);
    pending.current = { timer, span: span.start, fire };
  }, [clickPlay, startAt, dropPreview]);

  // A chord symbol sounds the harmony rather than a note, on the comping's own
  // voice, so pointing at a symbol answers "what does that chord sound like"
  // in the voice you'd hear it in. Held about as long as a preview can hold —
  // a chord needs a moment to be heard as one, where a melody note only needs
  // striking.
  //
  // The whole chord, root and all — see auditionChord. What the comping plays
  // behind the tune is a thinner thing on purpose, and struck on its own it
  // doesn't say which chord it is, which is the one thing a click on a symbol
  // is asking.
  //
  // The root goes to the BASS when the bass is switched on — an upright under
  // the voicing, down where a bass actually plays one, which is what a chord
  // sounds like when a band plays it. With the bass off it stays under the
  // voicing on the comping instrument, so the chord is rooted either way.
  const soundChord = useCallback((sym: string) => {
    if (!mix.chords.on) return;
    const onBass = mix.bass.on;
    const v = auditionChord(sym, onBass);
    if (!v) return;
    const shift = PITCHING_SEMITONES[pitching];
    const upper = v.upper.map(m => m + shift);
    const root = v.root + shift;
    playerRef.current?.previewParts(
      onBass
        ? [{ midis: upper, voice: 'chords' }, { midis: [root], voice: 'bass' }]
        : [{ midis: [root, ...upper], voice: 'chords' }],
      CHORD_PREVIEW_SEC,
    ).catch(e => {
      setAudioErr(e instanceof Error ? e.message : String(e));
    });
  }, [mix.chords.on, mix.bass.on, pitching]);

  // Clicking one on the staff: the caret goes to the symbol's own characters,
  // and the chord sounds — through the same double-click wait a notehead uses,
  // so a double-click on a symbol still means "play from here" and doesn't
  // flam a voicing into the performance starting under it.
  const previewChord = useCallback((mark: ChordMark) => {
    if (mark.src) setJump({ span: mark.src, n: ++jumpN.current });
    const key = mark.src?.start ?? -1;
    dropPreview(pending.current?.span !== key);
    if (!clickPlay) return;
    const fire = () => soundChord(mark.sym);
    const timer = window.setTimeout(() => { pending.current = null; fire(); }, DOUBLE_CLICK_MS);
    pending.current = { timer, span: key, fire };
  }, [clickPlay, soundChord, dropPreview]);

  // Double-clicking the staff plays from there — the click that came with it
  // has already put the caret on the same note. Focus goes back to the page:
  // a double-click on the engraving is about listening, not about landing in
  // the source with a cursor blinking at you.
  const playFromSpan = useCallback((span: Span) => {
    const found = startAt.get(span.start);
    // The clicks that carried us here queued an audition of this note; the
    // performance is about to sound it properly, so let that one go.
    dropPreview(false);
    (document.activeElement as HTMLElement | null)?.blur?.();
    // The click underneath this one selected the token; a double-click isn't
    // an edit, so collapse that back to a bare caret.
    setJump({ span, n: ++jumpN.current, quiet: true });
    playFrom(found?.at ?? 0);
  }, [startAt, playFrom, dropPreview]);

  // alt+[ and alt+] walk the caret through the notes, sounding each one as it
  // arrives — the way you actually check a transcription against the record:
  // one note, is that it, next. In a chord chart they walk the chords instead,
  // for the same reason and in the same words.
  //
  // The cursor lands on the FAR side of the note it just played, so the two
  // keys read as "back over that one" and "on past that one" rather than as
  // moving a pointer. A rest is walked over like anything else; it just has
  // nothing to sound.
  const marksInOrder = useMemo(
    () => [...startAt.entries()].map(([start, v]) => ({ start, ...v })).sort((a, b) => a.start - b.start),
    [startAt],
  );

  // The chord symbols as they're WRITTEN, in source order — the chart's own
  // words rather than the changes they were placed at, so a form that loops
  // round is walked through once and a symbol that never reached a bar is
  // still walked over. Deduped by where it starts, since a chart and the
  // changes it resolved into can both name the same characters.
  const chordsInOrder = useMemo(() => {
    const out: { start: number; end: number; sym: string }[] = [];
    const seen = new Set<number>();
    const add = (sym: string, src?: Span | null) => {
      if (!src || seen.has(src.start)) return;
      seen.add(src.start);
      out.push({ start: src.start, end: src.end, sym });
    };
    for (const m of score.movements) {
      for (const it of m.items) {
        if (it.kind === 'mark' && it.mark.t === 'chordline') {
          for (const bar of it.mark.bars) for (const c of bar) add(c.sym, c.src);
        }
      }
      // The chords= line writes no chart of its own — its symbols only exist
      // as placed changes.
      for (const c of m.chords) add(c.sym, c.src);
    }
    return out.sort((a, b) => a.start - b.start);
  }, [score]);

  // Whether the caret is in a chord chart — a C" line, a C""" form or a
  // chords= line. The parser has already marked every one of them as chords,
  // so this asks it rather than re-reading the text.
  const inChordChart = useCallback(
    (at: number) => score.annotations.some(a => a.cls === 'chordsym' && at >= a.start && at <= a.end),
    [score],
  );

  const stepNote = useCallback((dir: 1 | -1, at: number) => {
    // In a chord chart the keys walk the CHORDS, sounding each voicing the way
    // they sound each note in the music: the chart is what you're reading, so
    // it's what the audition should be about.
    if (inChordChart(at) && chordsInOrder.length) {
      const c = dir > 0
        ? chordsInOrder.find(x => x.end > at)
        : [...chordsInOrder].reverse().find(x => x.start < at);
      if (!c) { say(dir > 0 ? 'that was the last chord' : 'that was the first chord'); return; }
      const to = dir > 0 ? c.end : c.start;
      setJump({ span: { start: to, end: to }, n: ++jumpN.current });
      soundChord(c.sym);
      return;
    }
    if (!marksInOrder.length) return;
    // Forwards: the first note the caret hasn't passed the end of — so a caret
    // sitting inside a token plays THAT token rather than skipping it.
    // Backwards: the last one that starts before the caret, which steps again
    // each time it's pressed from the note it just landed on.
    const found = dir > 0
      ? marksInOrder.find(m => m.end > at)
      : [...marksInOrder].reverse().find(m => m.start < at);
    if (!found) { say(dir > 0 ? 'that was the last note' : 'that was the first note'); return; }
    setJump({ span: { start: dir > 0 ? found.end : found.start, end: dir > 0 ? found.end : found.start }, n: ++jumpN.current });
    if (!found.midis.length) return;
    playerRef.current?.preview(found.midis, found.dur, found.voice).catch(e => {
      setAudioErr(e instanceof Error ? e.message : String(e));
    });
  }, [marksInOrder, say, inChordChart, chordsInOrder, soundChord]);

  // alt+\ plays the score on from the caret, and stops it if it's already
  // going — the same shape as alt+space on the recording, and the only way to
  // stop the performance without reaching for the button.
  //
  // Where it starts is the same note alt+] would audition: the first one the
  // caret hasn't passed the end of, so a caret sitting inside a token plays
  // that token rather than the one after it.
  const playFromCaret = useCallback((at: number) => {
    const player = playerRef.current;
    if (player?.playing) { stopPlayback(); return; }
    const found = marksInOrder.find(m => m.end > at);
    if (!found) { say('nothing left to play from here'); return; }
    playFrom(found.at);
  }, [marksInOrder, playFrom, stopPlayback, say]);

  // ── the marks ──────────────────────────────────────────────────────
  // An `M1` written anywhere in the source and the recording's first bookmark
  // are two ends of one place. Landing on the bookmark — alt+1, a click on the
  // strip, a walk with alt+- — brings the caret to the mark, so the passage
  // you are about to hear is the passage you are looking at.
  //
  // Where each number was written. The first one wins if a number was set
  // twice; the parser has already said so with a squiggle.
  const markSpans = useMemo(() => {
    const m = new Map<number, Span>();
    for (const k of score.marks) if (!m.has(k.n)) m.set(k.n, k.span);
    return m;
  }, [score]);
  const textMarks = useMemo(() => [...markSpans.keys()].sort((a, b) => a - b), [markSpans]);

  const goToMark = useCallback((n: number) => {
    const span = markSpans.get(n);
    // No M for it yet is not a failure — a bookmark you haven't marked in the
    // writing is just a bookmark. The recording has already gone there.
    if (!span) return;
    setJump({ span, n: ++jumpN.current });
    // Both ends of the place, not just the writing end: the M lights up in the
    // source AND the number it wrote scrolls into view on the staff, so the
    // bar you are about to hear is on the page in both panes. Measured after
    // the paint, so the cue is looked for once this jump's render has landed
    // (the caret lights a note on the staff, and that is a render).
    requestAnimationFrame(() => revealCue(n));
  }, [markSpans]);

  // The bookmarks are numbered by where they FALL, so one added or dropped in
  // the middle renumbers everything after it — and the marks in the source
  // have to move with them or every number after that one points at the wrong
  // passage. A checkpoint first: this is a rewrite of the text that the text
  // didn't ask for, and it has to be as undoable as any other.
  const renumberMarks = useCallback((op: 'add' | 'drop', from: number, to = from) => {
    if (!touchesMarks(score.marks, from)) return;
    const next = op === 'add'
      ? withMarkAdded(text, score.marks, from)
      : withMarksDropped(text, score.marks, from, to);
    if (next === text) return;
    const doc = docsRef.current.find(d => d.id === currentIdRef.current);
    if (doc) setHistory(h => H.capture(h, doc, { label: `before renumbering the marks` }));
    setText(next);
    say(op === 'add'
      ? `bookmark ${from} went in — the marks from M${from} on moved up`
      : from === to
        ? `M${from} dropped — the marks after it moved down`
        : `M${from}–M${to} dropped — the marks after them moved down`);
  }, [score, text, setText, say]);

  // ── taking a bookmark change back ───────────────────────────────────
  // ⌘Z / ⌘⇧Z. The writing has the textarea's own undo stack, which is the
  // right one for typing and has never heard of the strip — so a mark dropped
  // by accident had no way back at all. The bookmarks get a stack of their
  // own, here, where both halves of a bookmark change can be reached.
  //
  // Because a bookmark change is never only a bookmark change: dropping the
  // 3rd one takes M3 out of the source and counts M4 down to M3 (see
  // renumberMarks). So an entry holds the pair — the recording's settings and
  // the text — and putting one back puts both back together. Half of it would
  // leave the M numbers pointing at the wrong passages, which is the very
  // thing the renumbering exists to prevent.
  //
  // Which of the two stacks ⌘Z means is simply whichever you touched last: a
  // mark moved since your last keystroke is what "take that back" is about,
  // and otherwise this keeps its hands off and the textarea does what it has
  // always done.
  type Snap = { docId: string; audio?: DocAudio; text: string };
  type MarkEdit = { at: number; before: Snap; after: Snap };
  const markUndo = useRef<MarkEdit[]>([]);
  const markRedo = useRef<MarkEdit[]>([]);
  const markWas = useRef<Snap | null>(null);
  // Set while one of our own ⌘Zs is landing, so the change it makes isn't
  // itself recorded as one more thing to take back.
  const markApplying = useRef(false);
  // …and set by the strip on its way in, so only a change made HERE counts as
  // one. A document arriving from the server or from a reload rewrites the
  // same fields and is nothing anyone asked to undo.
  const markFromStrip = useRef(false);
  // When the writing was last touched on its own — the other half of
  // "whichever you touched last".
  const textEditAt = useRef(0);

  useEffect(() => {
    if (!currentDoc) { markWas.current = null; return; }
    const now: Snap = { docId: currentDoc.id, audio: currentDoc.audio, text: currentDoc.text };
    const was = markWas.current;
    markWas.current = now;
    const fromStrip = markFromStrip.current;
    markFromStrip.current = false;
    // Another document is another history: an entry kept across the switch
    // would only offer to undo a change into a page that isn't on screen.
    if (!was || was.docId !== now.docId) { markUndo.current = []; markRedo.current = []; return; }
    if (marksOf(was.audio) === marksOf(now.audio)) {
      if (was.text !== now.text) textEditAt.current = Date.now();
      return;
    }
    if (markApplying.current) { markApplying.current = false; return; }
    if (!fromStrip) return;
    markUndo.current = [...markUndo.current, { at: Date.now(), before: was, after: now }]
      .slice(-MARK_UNDO_DEPTH);
    markRedo.current = [];
  }, [currentDoc]);

  const putMarksBack = useCallback((s: Snap) => {
    markApplying.current = true;
    setDocs(ds => ds.map(d => (
      d.id === s.docId ? { ...d, audio: s.audio, text: s.text, updated: Date.now() } : d
    )));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      const back = !e.shiftKey;
      const stack = back ? markUndo.current : markRedo.current;
      const top = stack[stack.length - 1];
      // Nothing of ours to take back, or the writing is the more recent of the
      // two — leave the keystroke alone and let the textarea have it.
      if (!top || top.at < textEditAt.current) return;
      e.preventDefault();
      stack.pop();
      const moved = { ...top, at: Date.now() };
      const to = back ? top.before : top.after;
      putMarksBack(to);
      if (back) markRedo.current = [...markRedo.current, moved];
      else markUndo.current = [...markUndo.current, moved];
      const n = to.audio?.bookmarks?.length ?? 0;
      say(`${back ? 'undone' : 'redone'} — ${n} bookmark${n === 1 ? '' : 's'}`);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [putMarksBack, say]);

  // ── the MIDI keyboard ────────────────────────────────────────────────
  // A keyboard plugged into the machine plays a Rhodes over whatever is on
  // screen, moved by the same concert shift the score is played through — so
  // what you work out under your hands is in the same key as the recording.
  //
  // Subscribed ONCE: what it needs to know that changes (the shift, whether
  // it's switched on) is read through refs, because re-subscribing would mean
  // asking the browser for MIDI access again on every keystroke.
  const midiOnRef = useRef(midiOn);
  midiOnRef.current = midiOn;
  useEffect(() => { playerRef.current?.setKeyShift(PITCHING_SEMITONES[pitching]); }, [pitching]);
  useEffect(() => listenMidi({
    down: (note, vel) => {
      if (!midiOnRef.current) return;
      playerRef.current?.keyDown(note, vel).then(sounded => {
        // The browser only lets a page make sound after it has been touched,
        // and a MIDI message doesn't count as touching it.
        if (!sounded) say('click the page once to let it make sound');
      }).catch(e => setAudioErr(e instanceof Error ? e.message : String(e)));
    },
    up: note => playerRef.current?.keyUp(note),
    pedal: down => playerRef.current?.setPedal(down),
    panic: () => playerRef.current?.allKeysOff(),
    device: name => setMidiName(name),
  }), [say]);

  // The song's keys. They all take alt, which is what lets them work with the
  // caret in the source: a bare key there is a character, and , and . in
  // particular are octave marks you type all day.
  //
  // Matched on the PHYSICAL key, never on e.key. Hold alt on a Mac and the
  // character the keycap says stops arriving: alt+r is ®, alt+, is ≤, alt+[ is
  // a typographic quote. e.code is the key you actually pressed.
  //
  // The key is swallowed whether or not a song is attached, and says so when
  // there isn't one — a shortcut that silently does nothing is indistinguish-
  // able from a shortcut that isn't wired up.
  useEffect(() => {
    const CMDS: Record<string, (api: AudioCommands) => void> = {
      KeyR: api => api.playFromStart(),
      Space: api => api.toggleFromHead(),
      // Stop and go back to where the run began — and again to play it. The
      // difference from alt+space is only what STOPPING does: this one rewinds.
      Enter: api => api.replayFromHead(),
      KeyS: api => { api.markStart(); say('start moved'); },
      // The START, back and forward a beat — the head follows it.
      Comma: api => api.nudge(-1),
      Period: api => api.nudge(1),
      // A bookmark on the head, and the bookmarks by number: alt+1 is the
      // first one in the recording, alt+0 the tenth. The strip labels each
      // mark with its number, so the keys can be aimed by eye.
      KeyM: api => api.addBookmark(),
      // …and the two beside each other, for walking them without counting:
      // back a mark and on a mark from wherever the head is.
      Minus: api => api.stepBookmark(-1),
      Equal: api => api.stepBookmark(1),
    };
    // The same two nudge keys with shift held: the start moves as ever, and if
    // it is sitting on a mark the mark goes with it — which is how a bookmark
    // that landed a beat early gets put right, without leaving the keys.
    const SHIFTED: Record<string, (api: AudioCommands) => void> = {
      Comma: api => api.nudgeMark(-1),
      Period: api => api.nudgeMark(1),
    };
    // A bookmark's number can run into two digits, and there is one key per
    // digit — so alt+1 alt+2 has to mean bookmark 12 rather than bookmark 1
    // and then bookmark 2. A digit that COULD be the first of a pair waits a
    // moment to find out; one that couldn't (alt+2 with nine bookmarks, since
    // there is no 20-something to reach) aims straight away, which is nearly
    // always the case. Whatever is waiting is aimed the moment a second digit
    // makes no sense of it, so nothing is ever swallowed.
    const aim = (n: number, api: AudioCommands) => {
      const held = digitHeld.current;
      if (held) {
        clearTimeout(held.timer);
        digitHeld.current = null;
        const joined = held.n * 10 + n;
        if (joined <= api.bookmarkCount()) { api.goToBookmark(joined); return; }
        api.goToBookmark(held.n);
      }
      const one = n === 0 ? 10 : n;
      if (n > 0 && api.bookmarkCount() >= n * 10) {
        digitHeld.current = {
          n,
          timer: window.setTimeout(() => {
            digitHeld.current = null;
            songApi.current?.goToBookmark(one);
          }, DIGIT_WAIT),
        };
        return;
      }
      api.goToBookmark(one);
    };
    for (let n = 0; n <= 9; n++) {
      CMDS[`Digit${n}`] = api => aim(n, api);
    }
    // The keys that are about to make the RECORDING sound. Playing the song
    // already silences the notation on its way in (onBeforePlay), but only
    // once it has got as far as playing: with nothing attached yet, or a file
    // still loading, alt+space used to leave alt+\'s performance running
    // underneath the complaint. Cut it here instead, before the song is even
    // asked — "stop this and play the record" is what the press meant, and the
    // first half of that shouldn't depend on the second half working out.
    const SILENCE_FIRST = new Set(['Space', 'KeyR', 'Enter']);
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const run = e.shiftKey ? SHIFTED[e.code] : CMDS[e.code];
      if (!run) return;
      e.preventDefault();
      if (!e.shiftKey && SILENCE_FIRST.has(e.code)) stopPlayback();
      const api = songApi.current;
      if (!api?.attached()) { say('no song attached — open the strip and pick one'); return; }
      run(api);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (digitHeld.current) { clearTimeout(digitHeld.current.timer); digitHeld.current = null; }
    };
  }, [say, stopPlayback]);

  // ⌘S / Ctrl+S saves the OPEN transcription to a JSON file — with its
  // recording inside it, so the file is the whole thing and can be handed to
  // someone else. The browser's own Save dialog is useless for an app like
  // this, so take the shortcut.
  useEffect(() => {
    async function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 's' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      if (!currentDoc) return;
      const doc = currentDoc;
      const songs = doc.audio ? await L.backupSongs([doc.audio.id]) : [];
      download(`${slug(doc.name)}.json`, songs.length ? { ...doc, songs } : doc);
      say(songs.length ? 'saved to your downloads, song included' : 'saved to your downloads');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentDoc]);

  // The engraving itself, which both layouts show — the phone one is only a
  // different frame around this. On a phone the source's own line breaks were
  // left out of the ABC (see BuildOpts.reflow), so manualBreaks is false there
  // and this re-flows to two bars a system.
  const engraving = shown.map((b, i) => (
    <Score
      key={i}
      abc={b.abc}
      wrap={!b.manualBreaks}
      perLine={tight ? 2 : 4}
      // Stepping cuts a system into rows and re-lays them; a staff running
      // under it is cut at the same barline (see splitSystems), so the pair
      // still reads as one line. Off on a phone, where the score re-flows to
      // the pane instead and there's no width to hand a step.
      mayStep={!phone}
      spans={preview ? [] : b.noteSpans}
      numbers={numbers}
      labels={b.noteLabels}
      unders={b.unders}
      onHover={preview ? noop : setPickHover}
      onPick={preview ? noop : (span => { setJump({ span, n: ++jumpN.current }); previewSpan(span); })}
      cues={shownCues}
      caret={caretLit?.block === i ? caretLit.span : null}
      chordMarks={preview ? [] : b.chordMarks}
      onChord={preview ? noop : previewChord}
      onPlayFrom={preview ? noop : playFromSpan}
    />
  ));

  // ── the mixer ────────────────────────────────────────────────────────
  // One row per voice: a switch (the name itself), what it's played on, and
  // how loud. Live — a volume moved here lands on the note already sounding.
  const VOICE_NOTE: Record<Voice, string> = {
    lead: 'the tune',
    chords: hasChords && hasTreble ? 'the C" symbols and the T: staves'
      : hasChords ? 'the C" symbols, comped'
      : hasTreble ? 'the T: staves'
      : 'write a C" chord line',
    bass: hasBass ? 'the B: staves' : 'write a B: line',
  };
  const mixer = mixOpen && mixAt && (
    <div
      class="jp-mix"
      ref={mixPanelRef}
      role="dialog"
      aria-label="Voices"
      style={`top:${mixAt.top}px; right:${mixAt.right}px`}
    >
      <div class="jp-mix-head">
        <span class="jp-mix-title">voices</span>
        <span class="jp-mix-hint">a bar plays on every change</span>
      </div>
      {VOICES.map(v => {
          const has = v === 'lead' ? true : v === 'chords' ? hasChords || hasTreble : hasBass;
          return (
            <div key={v} class={`jp-mix-row${has ? '' : ' empty'}`}>
              <button
                class={`jp-pill${mix[v].on && has ? ' on' : ''}`}
                aria-pressed={mix[v].on}
                disabled={!has}
                data-hint={mix[v].on ? 'sounds' : 'silent'}
                onClick={() => setVoice(v, { on: !mix[v].on })}
              >{v}</button>
              <select
                class="jp-mix-sel"
                aria-label={`What ${v} is played on`}
                value={mix[v].patch}
                onChange={e => setVoice(v, { patch: (e.target as HTMLSelectElement).value })}
              >
                {PATCHES[v].map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input
                class="jp-song-sld jp-mix-vol" type="range" min="0" max="1" step="0.01"
                value={mix[v].vol}
                aria-label={`How loud ${v} is`}
                onInput={e => setVoice(v, { vol: Number((e.target as HTMLInputElement).value) })}
              />
              <span class="jp-mix-note">{VOICE_NOTE[v]}</span>
            </div>
          );
      })}
    </div>
  );

  const previewBar = preview && (
    <div class="jp-preview-bar">
      <span>{preview.label ?? `${H.ago(preview.at)} ago`}</span>
      <button class="jp-btn" onClick={() => restore(preview)}>restore this</button>
    </div>
  );

  // Print the notation. The browser prints the LIVE page — the stylesheet
  // takes the workbench away around the engraving — and the engraving is
  // always on the page, so there's nothing to unfold first.
  const printScore = useCallback(() => window.print(), []);

  // The transcription's name, over the first system when the music carries no
  // title of its own — a printed chart with nothing at the top of it is a
  // chart you have to play to identify. Print only; on screen the pane's own
  // header has said it already.
  const printHead = currentDoc?.name && !score.movements.some(m => m.title)
    ? <div class="jp-print-head">{currentDoc.name}</div>
    : null;

  // The transport, shared by both layouts: play/stop, who's reading (C or B♭),
  // numbers or staff, swing, click-to-hear, and the chord face.
  const transport = (
    <>
      <button
        class={`jp-btn icon${playing ? ' on' : ''}`}
        disabled={!playback.length || audioBusy}
        data-hint={audioBusy ? 'loading' : playing ? 'stop' : 'play'}
        aria-label={playing ? 'Stop playback' : 'Play'}
        onClick={togglePlay}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
            <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />
          </svg>
        ) : (
          /* Centroid-centred so the triangle doesn't read left-heavy. */
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
            <path d="M8 5.6a1 1 0 0 1 1.5-.87l10 6.4a1 1 0 0 1 0 1.74l-10 6.4A1 1 0 0 1 8 18.4Z" />
          </svg>
        )}
      </button>
      {/* The three voices — what each is played on, how loud, and whether it
          sounds at all. Behind a button because it's three rows of controls
          and you set it once a song, not once a bar. */}
      <button
        ref={mixBtnRef}
        class={`jp-pill${mixOpen ? ' on' : ''}`}
        aria-pressed={mixOpen}
        aria-expanded={mixOpen}
        data-hint="voices"
        aria-label="Sounds and volumes for the tune, the chords and the bass"
        onClick={() => setMixOpen(o => !o)}
      >mix</button>
      {/* How the part is READ, and the reason the label above says "plays".
          8va draws the notation an octave above what's typed and touches
          nothing else — no key signature, no chord, and above all no playback,
          which stays on the record. It's what lets a solo transcribed where it
          actually sounds be read on a tenor, which reads up there.

          One per staff, because the two are read by different people: the tune
          moved up for a tenor mustn't take the bass part with it. The bass one
          only appears when there's a bass staff to move — a switch for a staff
          that isn't there is a switch that does nothing. */}
      <button
        class={`jp-pill${octave ? ' on' : ''}`}
        aria-pressed={!!octave}
        data-hint={octave ? 'tune reads 8va' : 'tune as written'}
        aria-label="Draw the tune an octave above what is typed — the sound does not move"
        onClick={() => patchDoc({ octave: octave ? 0 : 1 })}
      >8va</button>
      {hasBass && (
        <button
          class={`jp-pill${bassOctave ? ' on' : ''}`}
          aria-pressed={!!bassOctave}
          data-hint={bassOctave ? 'bass reads 8va' : 'bass as written'}
          aria-label="Draw the bass staff an octave above what is typed — the sound does not move"
          onClick={() => patchDoc({ bassOctave: bassOctave ? 0 : 1 })}
        >B 8va</button>
      )}
      <button
        class={`jp-pill${numbers ? ' on' : ''}`}
        aria-pressed={numbers}
        data-hint={numbers ? 'numbers' : 'staff'}
        onClick={() => setNumbers(v => !v)}
        aria-label="Show jianpu numbers instead of notes"
      >123</button>
      <button
        class={`jp-pill${roman ? ' on' : ''}`}
        aria-pressed={roman}
        data-hint={roman ? 'chords as numerals' : 'chords as letters'}
        onClick={() => setRoman(v => !v)}
        aria-label="Show chords as roman numerals instead of letter names"
      >ii V</button>
      <button
        class={`jp-pill${swing ? ' on' : ''}`}
        aria-pressed={swing}
        data-hint="swing eighths"
        onClick={() => patchDoc({ swing: !swing })}
      >swing</button>
      {/* A MIDI keyboard, when one is plugged in — and nothing at all when
          there isn't, since a switch for a device you haven't got is a
          switch that does nothing. It plays a Rhodes, moved by the same
          concert shift as the score, so what you work out under your
          hands is in the recording's key. */}
      {midiName && (
        <button
          class={`jp-pill${midiOn ? ' on' : ''}`}
          aria-pressed={midiOn}
          aria-label={`${midiName} — ${midiOn ? 'sounding' : 'silent'}`}
          data-hint={midiOn ? midiName : 'keyboard off'}
          onClick={() => {
            playerRef.current?.allKeysOff();
            setMidiOn(v => !v);
          }}
        >
          {/* A stretch of keyboard: three white keys with two blacks
              between them, seen from above. */}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
            <path d="M3.6 5h16.8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm.9 1.9v10.2h5.1V6.9H4.5Zm6.9 0v10.2H14V6.9h-2.6Zm4.5 0v10.2h3.6V6.9H15.9Z" />
            <path d="M8.6 6.9h2.2v5.6H8.6zM15 6.9h2.2v5.6H15z" />
          </svg>
          keys
        </button>
      )}
      {/* Click-to-hear. The icon is a notehead with two sound waves
          coming off it — drawn here rather than borrowed from a font,
          so it sits centred in the pill like the others. */}
      <button
        class={`jp-pill${clickPlay ? ' on' : ''}`}
        aria-pressed={clickPlay}
        aria-label="Sound a note when it is clicked"
        data-hint={clickPlay ? 'click plays notes' : 'click is silent'}
        onClick={() => setClickPlay(v => !v)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <ellipse cx="8" cy="15.4" rx="4.3" ry="3.2" transform="rotate(-20 8 15.4)" />
          <path d="M11.4 14.2V4.9a.95.95 0 0 1 1.9 0v9.3a.95.95 0 0 1-1.9 0Z" />
          <path d="M16.4 8.4a.9.9 0 0 1 1.27-.06 4.6 4.6 0 0 1 0 6.82.9.9 0 1 1-1.2-1.34 2.8 2.8 0 0 0 0-4.14.9.9 0 0 1-.07-1.28Z" />
          <path d="M19.3 5.3a.9.9 0 0 1 1.27-.07 8.5 8.5 0 0 1 0 13.04.9.9 0 1 1-1.2-1.34 6.7 6.7 0 0 0 0-10.36.9.9 0 0 1-.07-1.27Z" />
        </svg>
        hear
      </button>
      {/* The chord face, as one button that names the face it's in and
          steps to the next one. Three choices don't earn three controls,
          and setting the label in its own face says what it does with no
          words at all.

          It rebuilds the ABC rather than just restyling: %%gchordfont is
          what abcjs measures the symbol's width with, so a wider face
          swapped in by CSS alone would overlap the music it was spaced
          for. */}
      <button
        class="jp-btn cycle"
        data-hint="chord face"
        aria-label={`Chord font: ${chordFont}. Click for the next one.`}
        onClick={cycleChordFont}
      >
        <span class={`chords-${chordFont}`}>{chordFont}</span>
      </button>
      {/* Print. What comes out is the engraving as it stands on screen and
          nothing else around it — see the @media print block in the
          stylesheet. The notation has to be UNFOLDED for there to be
          anything to print, so a folded pane opens first and the printer
          waits a frame for it to engrave. */}
      <button
        class="jp-btn icon"
        data-hint="print"
        aria-label="Print the notation"
        onClick={printScore}
      >
        {/* A printer: paper going in at the top, the sheet coming out below. */}
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M7 3h10v3.5H7zM4.5 8h15A1.5 1.5 0 0 1 21 9.5v6a1.5 1.5 0 0 1-1.5 1.5H18v-2.5H6V17H4.5A1.5 1.5 0 0 1 3 15.5v-6A1.5 1.5 0 0 1 4.5 8Zm13 2.2a1 1 0 1 0 1 1 1 1 0 0 0-1-1ZM7.5 16h9v5h-9z" />
        </svg>
      </button>
    </>
  );

  // ── the phone ──────────────────────────────────────────────────────
  // No source, no rail, no split: one scroller holding a header and the
  // engraving. The header goes with the scroll — reading a chart is the whole
  // job here, and the controls have had their say by the time you start.
  // Two quiet links in the top right: the keys, and the notation reference.
  const helpLinks = (
    <span class="jp-help-links">
      <button class="jp-help-link" data-hint="all the keys" aria-label="Keyboard shortcuts"
        onClick={() => { setCheatOpen(false); setKeysOpen(v => !v); }}>shortcuts</button>
      <button class="jp-help-link" data-hint="syntax guide" aria-label="Notation reference"
        onClick={() => { setKeysOpen(false); setCheatOpen(v => !v); }}>notation</button>
    </span>
  );
  const helpOverlays = (
    <>
      {cheatOpen && (
        <div class="jp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) setCheatOpen(false); }}>
          <div class="jp-overlay-panel" role="dialog" aria-modal="true" aria-label="Syntax reference">
            <CheatSheet autoFocus onClose={() => setCheatOpen(false)} />
          </div>
        </div>
      )}
      {keysOpen && (
        <div class="jp-overlay" onPointerDown={e => { if (e.target === e.currentTarget) setKeysOpen(false); }}>
          <div class="jp-overlay-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <Shortcuts
              onClose={() => setKeysOpen(false)}
              onReference={() => { setKeysOpen(false); setCheatOpen(true); }}
            />
          </div>
        </div>
      )}
    </>
  );

  if (phone) return (
    <div class="jp-phone">
      <div class="jp-phone-scroll" ref={scoreRef as any} onScroll={markScoreScroll}>
        <header class="jp-phone-head" ref={phoneHeadRef as any}>
          <button class="jp-phone-doc" onClick={() => setPickerOpen(true)}>
            {/* Stacked pages: the library. */}
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d="M4 5.4a1 1 0 0 1 1-1h14a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1Zm0 5.6a1 1 0 0 1 1-1h14a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1Zm0 5.6a1 1 0 0 1 1-1h9a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1Z" />
            </svg>
            <span class="jp-phone-name">{currentDoc?.name || 'untitled'}</span>
            <span class="jp-phone-sub">{summarise(text)}</span>
          </button>
          <div class="jp-phone-tools">{transport}</div>
        </header>
        <div class="jp-phone-help">{helpLinks}</div>
        {audioErr && <div class="jp-diag err">Rhodes samples wouldn’t load: {audioErr}</div>}
        <div class={`jp-phone-score chords-${chordFont}${preview ? ' previewing' : ''}`}>
          {printHead}
          {previewBar}
          {engraving}
        </div>
      </div>

      {/* The header, once it's gone: play from anywhere in the chart. */}
      {headGone && (
        <button
          class={`jp-phone-float${playing ? ' on' : ''}`}
          disabled={!playback.length || audioBusy}
          data-hint={playing ? 'stop' : 'play'}
          aria-label={playing ? 'Stop playback' : 'Play'}
          onClick={togglePlay}
        >
          {playing ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M8 5.6a1 1 0 0 1 1.5-.87l10 6.4a1 1 0 0 1 0 1.74l-10 6.4A1 1 0 0 1 8 18.4Z" />
            </svg>
          )}
        </button>
      )}

      {flash && <div class="jp-phone-flash"><Flash key={flash.n} msg={flash.msg} bad={flash.bad} /></div>}

      {mixer}
      {helpOverlays}
      {/* The library, as a sheet up from the bottom. The rail's list exactly —
          search, rename, duplicate, delete, history — only reachable by a tap
          instead of always on screen. Hover-to-preview is left out: there's no
          hover to leave, so a tapped preview would never wash back off. */}
      {pickerOpen && (
        <div class="jp-overlay jp-sheet-wrap" onPointerDown={e => { if (e.target === e.currentTarget) setPickerOpen(false); }}>
          <div class="jp-sheet" role="dialog" aria-modal="true" aria-label="Transcriptions">
            <span class="jp-sheet-grip" aria-hidden="true" />
            <DocList
              docs={docs} currentId={currentDoc?.id ?? ''} find={findN}
              onSelect={id => { selectDoc(id); setPickerOpen(false); }}
              onNew={newDoc} onRename={renameDoc}
              onDelete={deleteDoc} onDuplicate={duplicateDoc}
              history={docHistory}
              histOpen={histOpen}
              onHistToggle={() => setHistOpen(v => !v)}
              onPreview={noop}
              onRestore={restore}
              onPin={(id, on) => setHistory(h => H.setPinned(h, id, on))}
              onPinNow={pinNow}
            />
            <button class="jp-btn jp-sheet-done" onClick={() => setPickerOpen(false)}>done</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div class="jp-frame">
    <div class="jp-app">
      {side === 'docs' && (
      <aside
        class="jp-rail"
        ref={railRef as any}
        style={narrow
          ? (railH ? `height:${railH}px; max-height:none` : undefined)
          : (railW ? `flex:0 1 ${railW}px` : undefined)}
      >
        <DocList
          docs={docs} currentId={currentDoc?.id ?? ''} find={findN}
          /* Picking something to work on steps the rotation on to the
             source — the same move you'd make with ` a moment later. */
          onSelect={id => { selectDoc(id); setSide('source'); }}
          onNew={newDoc} onRename={renameDoc}
          onDelete={deleteDoc} onDuplicate={duplicateDoc}
          history={docHistory}
          histOpen={histOpen}
          onHistToggle={() => setHistOpen(v => !v)}
          onPreview={setPreview}
          onRestore={restore}
          onPin={(id, on) => setHistory(h => H.setPinned(h, id, on))}
          onPinNow={pinNow}
        />
      </aside>
      )}

      {side === 'source' && (
      <section
        class="jp-pane jp-pane-editor"
        ref={editorPaneRef as any}
        style={narrow
          ? (paneH ? `height:${paneH}px; min-height:0` : undefined)
          // Shrinkable, not pinned. A width dragged out on a wide screen is
          // remembered, and a narrower window later would otherwise hold the
          // source at that width and push the notation off the right edge —
          // flex-shrink lets it give way, down to the pane's own min-width.
          : (paneW ? `flex:0 1 ${paneW}px` : undefined)}
      >
        <div class="jp-pane-head">
          {/* The pane names the transcription rather than itself — which pane
              this is is obvious from what's in it, and the name isn't. */}
          <span class="jp-pane-title doc">{currentDoc?.name || 'untitled'}</span>
          <div class="jp-pane-tools">
            {/* The only trace of a problem outside the text itself: a count,
                and a way to land on the first one. What's actually WRONG is
                on the squiggle under the characters. */}
            {flaws.length > 0 && (
              <button
                class={`jp-pill jp-flaws${flaws.some(f => f.kind === 'err') ? ' bad' : ''}`}
                data-hint="go to the first"
                aria-label={`${flaws.length} problem${flaws.length === 1 ? '' : 's'} — go to the first`}
                onClick={() => {
                  const first = flaws.reduce((a, b) => (b.span.start < a.span.start ? b : a));
                  setJump({ span: first.span, n: ++jumpN.current });
                }}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                  <path d="M12 3.6a1.5 1.5 0 0 1 1.3.76l8 14A1.5 1.5 0 0 1 20 20.6H4a1.5 1.5 0 0 1-1.3-2.24l8-14A1.5 1.5 0 0 1 12 3.6Zm0 4.7a1 1 0 0 0-1 1.1l.4 4.3a.6.6 0 0 0 1.2 0l.4-4.3a1 1 0 0 0-1-1.1Zm0 8a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z" />
                </svg>
                {flaws.length}
              </button>
            )}
            <button
              class={`jp-pill${explain ? ' on' : ''}`}
              aria-pressed={explain}
              data-hint={explain ? 'hints on' : 'hints off'}
              onClick={() => setExplain(v => !v)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Zm0 1.9a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm0 2.6a2.9 2.9 0 0 0-2.9 2.6.95.95 0 0 0 1.9.2 1 1 0 1 1 1.4 1 2 2 0 0 0-1.35 1.9v.6a.95.95 0 0 0 1.9 0v-.5a3 3 0 0 0 1.95-2.9A2.9 2.9 0 0 0 12 7.1Zm0 8.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" />
              </svg>
              explain
            </button>
          </div>
        </div>
        <Editor
          text={text}
          annotations={score.annotations}
          flaws={flaws}
          explain={explain}
          onChange={setText}
          respell={respell}
          charts={charts}
          focus={pickHover}
          jump={jump}
          onCaret={markCaret}
          restore={editorPlace}
          onScroll={markSrcScroll}
          onStep={stepNote}
          onPlayFromCaret={playFromCaret}
        />
        {flash && <Flash key={flash.n} msg={flash.msg} bad={flash.bad} />}
      </section>
      )}

      {/* A split to drag whenever a side pane is up — it sizes whichever one
          that is. On the third stop the notation simply has the window. */}
      {side !== 'none' && <div
        class="jp-splitter"
        role="separator"
        aria-orientation={narrow ? 'horizontal' : 'vertical'}
        aria-label={side === 'docs' ? 'Resize the transcriptions' : 'Resize the editor'}
        data-hint="drag · double-click to reset"
        onPointerDown={onSplitterDown as any}
        onDblClick={resetPane}
      />}

      <section class="jp-pane jp-pane-score">
        <div class="jp-pane-head bare">
          <div class="jp-pane-tools">{transport}{helpLinks}</div>
        </div>
        {audioErr && <div class="jp-diag err">Rhodes samples wouldn’t load: {audioErr}</div>}
        <div
          class={`jp-score-scroll chords-${chordFont}${preview ? ' previewing' : ''}`}
          ref={scoreRef as any}
          onScroll={markScoreScroll}
        >
          {printHead}
          {previewBar}
          {engraving}
        </div>
        {/* Saves and imports normally report under the source; when the
            source isn't up, they report here rather than nowhere. */}
        {side !== 'source' && flash && <Flash key={flash.n} msg={flash.msg} bad={flash.bad} />}
      </section>

      {dropping && (
        <div class="jp-drop" aria-hidden="true">
          <span class="jp-drop-note">drop a backup to import, or an mp3 to attach</span>
        </div>
      )}

      {helpOverlays}
      {mixer}
    </div>
    {/* The recording, along the bottom under everything else — a transport
        wants width, and it stays put while you work in either pane. */}
    <AudioPane
      audio={currentDoc?.audio ?? null}
      onChange={(a: DocAudio | null) => {
        markFromStrip.current = true;
        patchDoc({ audio: a ?? undefined, updated: Date.now() });
      }}
      api={songApi}
      resumeAt={resumeAt}
      docId={currentDoc?.id ?? ''}
      onHead={at => markPlace({ head: at })}
      onBeforePlay={stopPlayback}
      say={say}
      textMarks={textMarks}
      onGoToMark={goToMark}
      onMarkAdded={n => renumberMarks('add', n)}
      onMarkDropped={(from, to) => renumberMarks('drop', from, to)}
      foldable={narrow}
      open={songOpen}
      onToggle={() => setSongOpen(v => !v)}
    />
    </div>
  );
}

// A confirmation that fades itself out. Keyed on the nonce, so the same
// message twice restarts it rather than doing nothing because it's already
// mounted. An import that failed lingers a beat longer — it's the one you
// have to actually read.
function Flash({ msg, bad }: { msg: string; bad?: boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGone(true), bad ? 4000 : 1600);
    return () => clearTimeout(t);
  }, [bad]);
  if (gone) return null;
  return <div class={`jp-diag ${bad ? 'err' : 'ok'} jp-saved`}>{msg}</div>;
}

// ── the file browser ─────────────────────────────────────────────────
// One flat list, organised by name — no folders. Three columns: the name,
// how many bars of music are in it, and how long ago it was touched. The
// column headings ARE the sort: click one to order by it, click it again to
// turn it round.

// Case-insensitive and numeric, so "Blues 2" comes before "Blues 10" and a
// lowercase title doesn't sink to the bottom.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Which way a column sorts the first time its heading is clicked: names from
// the top of the alphabet, the rest biggest-and-newest first.
const FIRST_DESC: Record<DocSort['by'], boolean> = { name: false, edited: true, bars: true };

// How many bars of music a transcription holds. Barlines are optional in the
// source, so this counts TIME rather than barlines: every movement's notes
// and rests added up against its meter, a pickup as the one short bar it is,
// and a multi-bar rest as the bars it stands for. Parsing is the dear part,
// so each text is only ever counted once.
const barsSeen = new Map<string, number>();
function barsIn(text: string): number {
  const seen = barsSeen.get(text);
  if (seen != null) return seen;
  let bars = 0;
  try {
    for (const mv of parseJianpu(text).movements) {
      const perBar = (mv.meter.bn * TICKS_PER_WHOLE) / mv.meter.den;
      let ticks = 0;
      for (const it of mv.items) {
        if (it.kind === 'note') ticks += it.dur;
        else if (it.mark.t === 'multirest') bars += it.mark.bars;
      }
      if (mv.pickup && ticks > 0) { bars++; ticks = Math.max(0, ticks - mv.pickup); }
      if (perBar > 0) bars += Math.ceil(ticks / perBar - 1e-9);
    }
  } catch { /* a count is a nicety — a text that won't parse shows none */ }
  // Every keystroke is a new text; don't keep all of them.
  if (barsSeen.size > 500) barsSeen.clear();
  barsSeen.set(text, bars);
  return bars;
}

// "now", "18m", "2h", "3d", "5w", "4mo", "2y" — as narrow as a column can be
// and still say it.
function edited(at: number | undefined, now = Date.now()): string {
  if (!at) return '';
  const m = Math.max(0, now - at) / 60000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 14) return `${Math.floor(d)}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// A copy of `docs` in the chosen order. An untitled document sorts under the
// word the rail shows for it rather than under the empty string. Ties fall
// back to the name, so equal counts don't shuffle between renders.
function ordered(docs: Doc[], sort: DocSort): Doc[] {
  const name = (a: Doc, b: Doc) => byName.compare(a.name || 'untitled', b.name || 'untitled');
  const key = (d: Doc) => (sort.by === 'bars' ? barsIn(d.text) : d.updated ?? 0);
  const cmp = sort.by === 'name'
    ? name
    : (a: Doc, b: Doc) => key(a) - key(b) || name(a, b);
  const out = docs.slice().sort(cmp);
  return sort.desc ? out.reverse() : out;
}

function DocList(props: {
  docs: Doc[]; currentId: string;
  // Bumped when "/" is pressed anywhere in the app: take the focus into the
  // search box, with whatever was in it selected.
  find: number;
  onSelect: (id: string) => void; onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  // Checkpoints of the OPEN document, newest first.
  history: H.Checkpoint[];
  histOpen: boolean;
  onHistToggle: () => void;
  onPreview: (cp: H.Checkpoint | null) => void;
  onRestore: (cp: H.Checkpoint) => void;
  onPin: (id: string, pinned: boolean) => void;
  onPinNow: () => void;
}) {
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Where the keyboard is in the list — an index into the rows as drawn.
  // Focus stays in the search box while this walks, so the list narrows under
  // the arrows as you keep typing; that's also why it's drawn as a highlight
  // rather than as a focus ring.
  const [cursor, setCursor] = useState(-1);
  // …and only while the box actually has the keyboard. A dashed row sitting
  // there for ever would just be a second border on the open document.
  const [finding, setFinding] = useState(false);
  // Whether the open document's name is being edited. Only by asking — the
  // name itself is a thing you click to open.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setRenaming(false), [props.currentId]);
  // How the list is ordered, remembered across reloads — you settle into one
  // way of finding things and it should still be there tomorrow.
  const [sort, setSort] = useState<DocSort>(() => P.loadDocSort());
  const sortBy = (by: DocSort['by']) => setSort(s => {
    const next = { by, desc: s.by === by ? !s.desc : FIRST_DESC[by] };
    P.saveDocSort(next);
    return next;
  });

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => ordered(
    needle ? props.docs.filter(d => `${d.name} ${d.text}`.toLowerCase().includes(needle)) : props.docs,
    sort,
  ), [props.docs, needle, sort]);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // ── walking the list from the keyboard ───────────────────────────
  // "/" puts the focus in the search box; from there the arrows walk the
  // rows and Enter opens the one under the cursor.
  const step = (dir: 1 | -1) => setCursor(c => {
    const n = shownRef.current.length;
    if (!n) return -1;
    return Math.max(0, Math.min(n - 1, c < 0 ? (dir > 0 ? 0 : n - 1) : c + dir));
  });
  const onListKey = (e: KeyboardEvent) => {
    const row = cursor >= 0 ? shown[cursor] : null;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'Enter':
        if (!row) return;
        e.preventDefault();
        // Done searching, and done with the keyboard: the query goes, and the
        // focus leaves the box so the transport's own keys work again.
        setQ('');
        searchRef.current?.blur();
        props.onSelect(row.id);
        break;
      case 'Escape':
        e.preventDefault();
        if (q) setQ('');
        else { setCursor(-1); searchRef.current?.blur(); }
        break;
    }
  };

  // "/" from anywhere: the box takes the focus with whatever was in it
  // selected, so typing replaces the last search rather than extending it.
  useEffect(() => {
    if (!props.find) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [props.find]);

  // A new search is a new list, and the top hit is the one you meant — "/",
  // three letters and Enter opens it. With no query the cursor sits on the
  // document that's open, so the arrows walk from where you already are.
  useEffect(() => {
    setCursor(needle ? 0 : shownRef.current.findIndex(d => d.id === props.currentId));
  }, [needle, props.currentId]);

  // Keep the row under the cursor on screen — walking past the bottom of the
  // rail shouldn't lose it.
  useEffect(() => {
    if (cursor < 0 || !finding) return;
    listRef.current?.querySelector('.here')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, finding]);

  // ── rows ─────────────────────────────────────────────────────────
  const now = Date.now();
  // The longest thing in the library sets the scale for the bars column —
  // the whole library, not just what a search leaves, so a row's line
  // doesn't change length as you type.
  const most = Math.max(1, ...props.docs.map(d => barsIn(d.text)));
  const docRow = (d: Doc, here: boolean) => {
    const active = d.id === props.currentId;
    const bars = barsIn(d.text);
    return (
      <li class={`jp-doc${active ? ' active' : ''}${here ? ' here' : ''}`} key={d.id}>
        {active && renaming ? (
          <input
            class="jp-doc-name" value={d.name} spellcheck={false}
            aria-label="Transcription name"
            ref={el => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
            onBlur={() => setRenaming(false)}
            onInput={e => props.onRename(d.id, (e.target as HTMLInputElement).value)}
          />
        ) : (
          <button class="jp-doc-pick" onClick={() => props.onSelect(d.id)}>
            {d.name || 'untitled'}
          </button>
        )}
        {/* How much music, as a length rather than a number: a line on a
            square-root scale, so a four-bar sketch still shows beside a
            hundred-bar solo. The count itself is in the hint. */}
        <span class="jp-doc-len" data-hint={bars ? `${bars} bar${bars === 1 ? '' : 's'}` : 'empty'}>
          {bars > 0 && <i style={`width:${Math.max(2, Math.round(100 * Math.sqrt(bars / most)))}%`} />}
        </span>
        <span class="jp-doc-num">{edited(d.updated, now)}</span>
        {active && (
          <span class={`jp-doc-acts${renaming || props.histOpen ? ' held' : ''}`}>
            <button class={`jp-doc-act${renaming ? ' on' : ''}`} data-hint="rename" aria-label="Rename"
              onMouseDown={e => { if (renaming) e.preventDefault(); }}
              onClick={() => setRenaming(v => !v)}>
              {/* A pencil, nib down the diagonal. */}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M17.4 2.9a1.7 1.7 0 0 1 2.4 0l1.3 1.3a1.7 1.7 0 0 1 0 2.4l-1.6 1.6-3.7-3.7ZM14.4 5.9l3.7 3.7-8.6 8.6-4.6 1 1-4.6Z" />
              </svg>
            </button>
            <button
              class={`jp-doc-act${props.histOpen ? ' on' : ''}`}
              aria-expanded={props.histOpen}
              data-hint={`history · ${props.history.length}`}
              aria-label="Version history"
              onClick={props.onHistToggle}>
              {/* A clock: face, then two hands drawn as one path. */}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z" />
                <path d="M11 7.4a1 1 0 0 1 2 0v4.2l2.8 1.6a1 1 0 0 1-1 1.73l-3.3-1.9a1 1 0 0 1-.5-.87Z" />
              </svg>
            </button>
            <button class="jp-doc-act" data-hint="duplicate" aria-label="Duplicate"
              onClick={() => props.onDuplicate(d.id)}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M9 3.5h8.5A2.5 2.5 0 0 1 20 6v9.5a1 1 0 1 1-2 0V6a.5.5 0 0 0-.5-.5H9a1 1 0 0 1 0-2Zm-2.5 3h7A2.5 2.5 0 0 1 16 9v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 18V9a2.5 2.5 0 0 1 2.5-2.5Zm0 2A.5.5 0 0 0 6 9v9a.5.5 0 0 0 .5.5h7A.5.5 0 0 0 14 18V9a.5.5 0 0 0-.5-.5Z" />
              </svg>
            </button>
            <button class="jp-doc-act danger" data-hint="delete" aria-label="Delete"
              onClick={() => { if (confirm(`Delete “${d.name || 'untitled'}”?`)) props.onDelete(d.id); }}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M5.3 4.2 12 10.9l6.7-6.7a.8.8 0 0 1 1.1 1.1L13.1 12l6.7 6.7a.8.8 0 0 1-1.1 1.1L12 13.1l-6.7 6.7a.8.8 0 0 1-1.1-1.1L10.9 12 4.2 5.3a.8.8 0 0 1 1.1-1.1Z" />
              </svg>
            </button>
          </span>
        )}
        {/* Any other row can be deleted from where it sits, on hover — no need
            to open it first. The rest of the buttons act on the open one. */}
        {!active && (
          <span class="jp-doc-acts">
            <button class="jp-doc-act danger" data-hint="delete" aria-label={`Delete ${d.name || 'untitled'}`}
              onClick={() => { if (confirm(`Delete “${d.name || 'untitled'}”?`)) props.onDelete(d.id); }}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M5.3 4.2 12 10.9l6.7-6.7a.8.8 0 0 1 1.1 1.1L13.1 12l6.7 6.7a.8.8 0 0 1-1.1 1.1L12 13.1l-6.7 6.7a.8.8 0 0 1-1.1-1.1L10.9 12 4.2 5.3a.8.8 0 0 1 1.1-1.1Z" />
              </svg>
            </button>
          </span>
        )}
        {active && props.histOpen && (
          <History
            list={props.history}
            onPreview={props.onPreview}
            onRestore={props.onRestore}
            onPin={props.onPin}
            onPinNow={props.onPinNow}
          />
        )}
      </li>
    );
  };

  // A column heading: its name, and — on the one the list is sorted by — a
  // small chevron saying which way round.
  const heading = (by: DocSort['by'], word: string) => {
    const on = sort.by === by;
    return (
      <button
        class={`jp-col${on ? ' on' : ''}`}
        aria-label={`Sort by ${word}`}
        aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : undefined}
        onClick={() => sortBy(by)}>
        <span>{word}</span>
        {on && (
          <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor" aria-hidden="true"
            style={sort.desc ? undefined : 'transform:rotate(180deg)'}>
            <path d="M4.6 8.2a1.2 1.2 0 0 1 1.7 0L12 13.9l5.7-5.7a1.2 1.2 0 1 1 1.7 1.7l-6.55 6.55a1.2 1.2 0 0 1-1.7 0L4.6 9.9a1.2 1.2 0 0 1 0-1.7Z" />
          </svg>
        )}
      </button>
    );
  };

  return (
    <>
      {/* Find something, or start something. */}
      <div class="jp-rail-find">
        <input
          class="jp-rail-search"
          ref={searchRef as any}
          value={q}
          placeholder="search"
          spellcheck={false}
          aria-label="Search transcriptions"
          onInput={e => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={onListKey}
          onFocus={() => setFinding(true)}
          onBlur={() => setFinding(false)}
        />
        <button class="jp-btn icon" data-hint="new" aria-label="New transcription" onClick={props.onNew}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
            <path d="M11 4.6a1 1 0 0 1 2 0V11h6.4a1 1 0 0 1 0 2H13v6.4a1 1 0 0 1-2 0V13H4.6a1 1 0 0 1 0-2H11V4.6Z" />
          </svg>
        </button>
      </div>

      <div class="jp-cols">
        {heading('name', 'name')}
        {heading('edited', 'edited')}
        {heading('bars', 'bars')}
      </div>

      <ul class="jp-doclist" ref={listRef as any}>
        {shown.map((d, i) => docRow(d, finding && i === cursor))}
        {needle && !shown.length && <li class="jp-empty">No transcription matches “{q}”.</li>}
      </ul>

      {/* The foot of the panel: how much library there is, and the one thing
          you do to the library as a whole rather than to something in it. */}
      <div class="jp-rail-foot">
        <span class="jp-rail-count">
          {props.docs.length} transcription{props.docs.length === 1 ? '' : 's'}
        </span>
        <button class="jp-btn" data-hint="export all" onClick={() => void exportDocs(props.docs)}>export</button>
      </div>
    </>
  );
}

// The open document's checkpoints. Hovering a row engraves that version in
// the staff pane; clicking restores it (which checkpoints where you are
// first, so it's never a one-way door). The pin keeps a row out of the
// thinning for good.
function History(props: {
  list: H.Checkpoint[];
  onPreview: (cp: H.Checkpoint | null) => void;
  onRestore: (cp: H.Checkpoint) => void;
  onPin: (id: string, pinned: boolean) => void;
  onPinNow: () => void;
}) {
  return (
    <div class="jp-hist" onPointerLeave={() => props.onPreview(null)}>
      <div class="jp-hist-head">
        <span>history</span>
        <button class="jp-hist-add" data-hint="checkpoint now" onClick={props.onPinNow}>pin now</button>
      </div>
      {!props.list.length && <div class="jp-empty">Nothing yet — a checkpoint is taken when typing settles.</div>}
      <ul>
        {props.list.map((cp, i) => (
          <li class={`jp-hist-row${cp.pinned ? ' pinned' : ''}`} key={cp.id}
            onPointerEnter={() => props.onPreview(cp)}>
            <button class="jp-hist-pick" onClick={() => props.onRestore(cp)} data-hint="restore">
              <span class="jp-hist-when">{H.ago(cp.at)}</span>
              <span class="jp-hist-what">{cp.label ?? H.describe(cp, props.list[i + 1])}</span>
            </button>
            <button
              class={`jp-hist-pin${cp.pinned ? ' on' : ''}`}
              data-hint={cp.pinned ? 'unpin' : 'keep'}
              aria-pressed={!!cp.pinned}
              aria-label={cp.pinned ? 'Unpin this checkpoint' : 'Keep this checkpoint'}
              onClick={() => props.onPin(cp.id, !cp.pinned)}>
              {/* A pushpin, head down. */}
              <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
                <path d="M14.1 2.9a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1-.9 1.7l-2.7-.5-3.3 3.3.6 3a1 1 0 0 1-1.7.9l-3.2-3.2-4.7 4.7a1 1 0 0 1-1.4-1.4l4.7-4.7L5.3 9a1 1 0 0 1 .9-1.7l3 .6 3.3-3.3-.5-2.7a1 1 0 0 1 .3-.9Z" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The key / meter line under the phone header.
function summarise(text: string): string {
  const key = /(^|\s)([1-7]=[A-Ga-g][#b]*)(\s|$)/.exec(text)?.[2];
  const meter = /(^|\s)(\d+\/\d+)(\s|$)/.exec(text)?.[2];
  const bits = [key, meter].filter(Boolean);
  return bits.length ? bits.join(' · ') : `${text.trim().split(/\s+/).length} words`;
}

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Everything: every transcription, and every song one of them is attached to.
async function exportDocs(docs: Doc[]) {
  const songs = await L.backupSongs(docs.flatMap(d => (d.audio ? [d.audio.id] : [])));
  download(`transcriptions-${new Date().toISOString().slice(0, 10)}.json`, { transcriptions: docs, songs });
}

// A filename that won't fight the filesystem.
function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'transcription';
}

function noop() { /* interactions are off while a checkpoint is previewed */ }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
