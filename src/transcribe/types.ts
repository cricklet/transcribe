// Transcribe — types shared by the parser, the ABC builder and the UI.

// ── the library ──────────────────────────────────────────────────────
// One saved transcription. Same shape as comping-library's ChartDoc: the
// authored text IS the document, everything else is derived.
export type Doc = {
  id: string;
  name: string;
  text: string;
  // Which version of the source language this text is written in. Absent means
  // version 1 — it was saved before the field existed. migrate.ts walks a
  // document up to the current version on load, so a change to what a
  // character MEANS never silently reinterprets a file already written.
  syntax?: number;
  // Wall-clock of the last edit, for the "recent first" sort in the browser.
  updated?: number;
  // Legacy: "this page is a B♭ part" used to be a switch kept here. It is a
  // fact about the transcription rather than a preference, so it is written in
  // the source now — CONCERT=Bb — and migrate.ts moves it there on load. Only
  // read, never written.
  pitching?: 'C' | 'Bb';
  // A tune that swings keeps swinging, whichever document you open next.
  swing?: boolean;
  // How many octaves ABOVE what's typed the notation is drawn. Reading only —
  // it never touches playback — so a solo transcribed where it actually sounds
  // can be read on a tenor, which reads an octave and a tone above concert.
  octave?: number;
  // …and the same for the bass staff, which is read by whoever is playing the
  // bass rather than by whoever is reading the tune, so it moves on its own.
  bassOctave?: number;
  // The three voices, as they're set for THIS song: what each is played on,
  // how loud, and whether it sounds at all. Anything absent falls back to the
  // defaults in playback.ts, so an old document arrives with everything on.
  mix?: Partial<Record<Voice, Partial<VoiceMix>>>;
  // The recording this was transcribed from, if one is attached — see
  // DocAudio. It lives on the DOCUMENT rather than beside the song, which is
  // what lets two transcriptions of the same recording keep their own places
  // in it.
  audio?: DocAudio;
};

// A recording attached to a transcription. `id` is a row in the loop player's
// library — the audio itself stays over there, and nothing here is ever
// written back to it.
export type DocAudio = {
  id: string;
  // Where alt+r starts from, in seconds. Remembered, so coming back to a
  // transcription puts you back at the bar you were working on.
  start?: number;
  // Places worth returning to, in seconds. These are OURS: the loop player's
  // own loops are drawn on the strip too, but they belong to it and are only
  // ever read.
  bookmarks?: { at: number; label?: string }[];
  // Tracks switched off, by library id (the mix included). Off rather than on,
  // so a stem added to the song later arrives audible.
  off?: string[];
  // How loud each track sits, by library id, 0–1. Only the ones that have been
  // moved are written — anything absent is full, so a stem added later arrives
  // at the level everything else started at.
  levels?: Record<string, number>;
  // Playback speed, as a fraction of the recording's own tempo.
  rate?: number;
  // Semitones the RECORDING is moved by — the ± on the strip. Nothing to do
  // with CONCERT=, which is about what the writing sounds: this one is for a
  // take that sits a semitone off concert, or for hearing the thing you are
  // working out in another key.
  shift?: number;
};

// ── the mix ──────────────────────────────────────────────────────────
// What a performance is made of. Three streams that come from three different
// places in the source and want three different sounds: the tune, the chord
// symbols over it realised as comping, and the B: staff under it.
export type Voice = 'lead' | 'chords' | 'bass';
export const VOICES: Voice[] = ['lead', 'chords', 'bass'];

// One voice's settings. `patch` is a General MIDI instrument name (the
// gleitz/midi-js-soundfonts spelling, which is what smplr wants); `vol` is a
// plain 0–1 gain on that voice's own bus.
export type VoiceMix = { on: boolean; patch: string; vol: number };
export type Mix = Record<Voice, VoiceMix>;

// Which face chord symbols are set in: the handwritten chart face, plain
// text, or the same monospace the source is written in.
export type ChordFont = 'jazz' | 'plain';

// The two ways of reading a score. The chord face is remembered against each
// of them separately — an engraved staff and a page of numbers don't want the
// same one.
export type ChordView = 'staff' | 'numbers';

// How the file browser orders the library: the column whose heading was
// clicked, and which way round.
export type DocSort = { by: 'name' | 'edited' | 'bars'; desc: boolean };

// ── durations ────────────────────────────────────────────────────────
// Everything is counted in TICKS, where a semibreve (whole note) is 128.
// That makes every plain note value — down to jianpu-ly's shortest, the
// hemidemisemiquaver (64th = 2 ticks) — an integer, and their dotted forms
// too (dotted 64th = 3). It's also exactly ABC's L:1/128 unit, so a tick
// count doubles as the ABC duration multiplier with no conversion.
export const TICKS_PER_WHOLE = 128;
export const TICKS_PER_CROTCHET = 32;

// ── the parsed score ─────────────────────────────────────────────────

// One pitch inside a note (a chord has several). `degree` is the jianpu
// number 1..7; `rest` and `perc` are the 0 and x tokens.
export type Pitch = {
  degree: number;       // 1..7
  octave: number;       // octave shift: ' is +1, , is -1
  acc: number | null;   // explicit # / b (+1 / -1); null = take the key signature
};

// A decoration/annotation attached to a note, already in ABC spelling.
export type NoteDeco = string;

// One grace note out of a `g[ … ]` bracket: the pitches it holds (more than
// one is a chord), the value it was written as — a quaver unless the writer
// said otherwise — and where it sits in the source, so a transposition can
// rewrite it like any other note. `slash` rides the FIRST of a group and
// marks the crushed sort, `g/[ … ]`, which is where the slash is drawn.
export type GraceNote = { pitches: Pitch[]; dur: number; src: Span; slash?: boolean };

export type NoteItem = {
  kind: 'note';
  pitches: Pitch[];       // empty = rest
  perc: boolean;          // the `x` percussion beat
  dur: number;            // ticks
  tie: boolean;           // tie into the next note (jianpu-ly `~`)
  slurOpen: number;       // count of `(` that opened here
  slurClose: number;      // count of `)` that closed here
  decos: NoteDeco[];      // ABC decorations, e.g. !p! !fermata!
  above?: string;         // ^"text"
  below?: string;         // _"text"
  grace?: GraceNote[];    // g[ … ] before the note
  // Tuplet grouping: set on the FIRST member of a p:q group. Members are
  // emitted verbatim (never metric-split) and the bar cursor advances by
  // the group's sounding length.
  tuplet?: { p: number; q: number; r: number };
  inTuplet: boolean;
  // A bare `R`: a rest whose length is whatever is left of the bar. The
  // parser resolves it to a real tick count once the whole movement is known,
  // so nothing downstream has to special-case it.
  fill?: boolean;
  // Where this note falls in the movement, in ticks from its start. Filled in
  // by the parser's own walk (resolveFillRests), and only when something is
  // going to ask: it is what lets an M written on a B: line — or between the
  // chords of a C" chart — be drawn over the note of the TUNE it lands on.
  tick?: number;
  src: Span;              // where this note came from in the source text
};

export type MarkItem = {
  kind: 'mark';
  // Emitted into the ABC body between notes.
  mark:
    | { t: 'bar'; sym: string }          // explicit \bar "..."
    | { t: 'repeatStart' }
    | { t: 'repeatEnd' }
    | { t: 'alt'; n: number }            // |1  |2 …
    | { t: 'altEnd' }
    // A 1= / K= written after the music has started: the key changes from
    // here on. Carries the whole resulting state, not just the half that the
    // token moved, so nothing downstream has to track the other half.
    | { t: 'key'; keySig: KeySig; printKey: { name: string; sharps: number } | null }
    | { t: 'rehearsal'; label: string }
    | { t: 'text'; above: string }       // Fine / D.C. / Segno …
    | { t: 'multirest'; bars: number }
    | { t: 'linebreak' }
    // A C"…" line — or a whole C""" … """ form — resolved to ticks by a
    // post-pass once bar positions are known. `bars` is what was WRITTEN, one
    // entry per barline, each symbol keeping the characters it came from;
    // `order` is what is PLAYED, indices into it, so a |: … :| section is
    // written once and played twice. `loop` repeats the whole order until the
    // next chord line, or the end of the music. `cues` runs alongside `bars`:
    // the M's written in each bar, each with the index of the chord it stands
    // in front of, so a mark inside a form lands on the bar it was written in
    // rather than on the top of the chart.
    | { t: 'chordline'; bars: ChordWord[][]; order: number[]; loop: boolean;
        cues: { n: number; idx: number; src: number }[][] };
  src: Span;
};

export type Item = NoteItem | MarkItem;

// A half-open [start, end) range of the source text.
export type Span = { start: number; end: number };

// A hover-explainable run of source characters. The editor renders one span
// per annotation and shows `label` (+ `detail`) instantly on hover.
export type Annotation = {
  start: number;
  end: number;
  label: string;              // terse: "quaver", "mi · degree 3"
  detail?: string;            // one extra clause, e.g. "½ beat"
  cls: AnnClass;              // drives the syntax colour
};

// What the WRITING is pitched for — declared at the top of the source with
// CONCERT=. 'C' is a concert-pitch transcription; 'Bb' says the page is a B♭
// part (a trumpet or tenor reading), so what it SOUNDS is a tone lower than
// what it says. Nothing about the notation moves either way: this is a
// statement about the instrument the page is written for, and it is what the
// app's own playback — and a MIDI keyboard played over it — is put through so
// that both meet the recording.
export type Pitching = 'C' | 'Bb';

export type AnnClass =
  | 'degree' | 'rest' | 'perc' | 'acc' | 'octave' | 'dur' | 'dot'
  | 'dash' | 'bar' | 'repeat' | 'tuplet' | 'tie' | 'slur' | 'deco'
  | 'header' | 'key' | 'meter' | 'tempo' | 'lyric' | 'chordsym'
  | 'comment' | 'directive' | 'mark' | 'unknown';

// One chord symbol as written, with the characters it came from.
// `roman` is the word as written when it was a roman numeral (V7/II-); `sym`
// is then the letter chord it was read into, in the key in force there.
// `lead` is where a bracketed run ending on this chord resolves — analysis
// only, drawn beside it as numerals ([VII-7 | III7] / VI).
// `run` marks the chords that open and close that bracketed run, so it can
// be drawn as one group — (II-7  V7)/VI- — with its target said once.
export type ChordRun = 'open' | 'close' | 'both';
export type ChordWord = { sym: string; src: Span; roman?: string; lead?: string; run?: ChordRun };

// A guitar-chord symbol placed at a tick offset from the start of the score.
// `src` is the symbol's own characters, so a chord the engraver couldn't place
// can be squiggled where it was written rather than merely described.
export type ChordSym = { tick: number; sym: string; src?: Span; roman?: string; lead?: string; run?: ChordRun };

export type Lyric = { verse: number; syllables: string[] };

// One staff under the music, and what it's written on:
//
//   X:  the comping rhythm — a one-line staff, no clef, X noteheads
//   T:  a part in treble clef, T2: a second one, T3: a third …
//   B:  a part in bass clef, B2: a second one, and so on
//
// The music is always the top staff; under it come the stabs, then the treble
// parts in number order, then the bass parts in number order. That's the order
// this list is in — `n` is the number written after the letter (1 for a bare
// T: or B:) and `id` is what was actually typed, which is what a diagnostic
// has to say back to you.
export type UnderKind = 'stab' | 'treble' | 'bass';
export type Under = { id: string; kind: UnderKind; n: number; items: Item[] };

export type Diagnostic = { span: Span; msg: string };

// One movement (jianpu-ly `NextScore` starts another).
export type Movement = {
  title?: string;
  headers: Record<string, string>;
  // Key: degree 1's pitch class + the major-key signature it implies.
  keySig: KeySig;
  meter: { bn: number; den: number };
  // An explicit K= overrides only the PRINTED key signature. Degrees still
  // take their pitches from the 1= declaration, so the music sounds the same
  // — only which accidentals get drawn changes.
  printKey: { name: string; sharps: number } | null;
  pickup: number | null;      // anacrusis length in ticks, or null
  tempo: { unit: number; bpm: number } | null;
  items: Item[];
  // The staves written UNDER the music, in the order they're engraved. Each
  // is a second, parallel piece of music that shares this movement's bars and
  // its key and nothing else — its own register, its own beat, its own
  // brackets — so a part lands under the beat it falls on without taking any
  // time away from the line being transcribed.
  unders: Under[];
  chords: ChordSym[];
  // Where the M's written INSIDE a C" chart land, in ticks — the one placement
  // a mark can't be read off the source order, since a chart is written above
  // (or beside) the bars it applies to rather than among them. `src` is the
  // mark's own offset, so the engraver can tell these from the marks it places
  // for itself. Everything else about them — which note they end up over — is
  // markCues's business.
  cues: { tick: number; n: number; src: number }[];
  lyrics: Lyric[];
};

export type KeySig = {
  // MIDI pitch class of jianpu degree 1 (do).
  tonicPc: number;
  // The natural letter (0=C,2=D,4=E,5=F,7=G,9=A,11=B) degree 1 is spelled on.
  tonicLetterPc: number;
  // Sharps (+) or flats (−) in the signature.
  sharps: number;
  // The name to print, e.g. "C", "Bb", "F#m".
  name: string;
  minor: boolean;
  // The source text of the k=pitch declaration ("1=C"), for display.
  label: string;
};

// Where a key starts applying, in source order over the WHOLE document —
// header declarations, mid-piece modulations and the implicit default that
// opens each movement all land here. It's what lets a tool ask "which key is
// in force at this character?", which is the question respelling a selection
// into another key centre turns on.
export type KeyPoint = {
  at: number;                  // takes effect from this source offset
  span: Span | null;           // the declaration token, null when implicit
  key: KeySig;
  printKey: { name: string; sharps: number } | null;
};

// One line of the source that the token pass actually read: the music, and the
// X: / B: lines riding under it. Lyrics, headers, chord lines and comments are
// NOT here — which is the point. A tool that rewrites the source has to know
// which lines hold notes before it touches a character, because a `,` is a
// register mark in the music and a comma in a lyric.
//
// `under` names the staff a line belongs to (see Under) — null for the music
// itself. Every under-staff keeps its own register, so a tool walking the
// music's registers has to step over those lines rather than read them as part
// of the line above.
export type MusicLine = { span: Span; under: string | null };

// A numbered place in the SOURCE — an `M1` written wherever the spot is: in
// the music, in a C" chart, on a B: line, anywhere the parser reads. It is
// not engraved and takes no time; it exists so that a place in the writing
// and a place in the RECORDING can be the same place. Mark n is the
// recording's nth bookmark, so alt+1 moves both ends at once, and adding or
// dropping a bookmark renumbers these to keep that true.
export type SourceMark = { n: number; span: Span };

export type Score = {
  movements: Movement[];
  annotations: Annotation[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  keys: KeyPoint[];
  music: MusicLine[];
  marks: SourceMark[];
  // CONCERT= at the top of the file, or 'C' when it doesn't say.
  concert: Pitching;
};

// Which side pane is on the page beside the notation. One state, three stops,
// walked by ` — the notation is always up, and the transcriptions and the
// source are never up together.
export type Side = 'docs' | 'source' | 'none';
