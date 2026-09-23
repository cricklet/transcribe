# Transcribe

A browser app for transcribing music: write a line in numbered notation
(`1=C`, `1 2 3 …`) and it engraves as a staff while you type. You can attach
the recording you're transcribing, then loop it, slow it down, move its pitch
and drop numbered bookmarks that line up with `M1`, `M2` … in the text.

**Everything is in one file:** `dist/transcribe.html`. Download it and open it
in a browser. There's no server and no account.

## Where your work is kept

- Transcriptions, bookmarks and settings: **localStorage**, in the browser you
  opened the file with.
- Attached mp3s: **IndexedDB** in that same browser. localStorage only holds
  about 5 MB, which is less than one song.

Nothing is synced, so back up your work:

- **⌘S / Ctrl+S** downloads the open transcription as `.json`, with its mp3
  embedded.
- **export** (at the foot of the library) downloads every transcription and
  every attached song in one `.json`.
- **Drop a `.json` backup anywhere on the page** to import it. Imports only
  add; they never overwrite. An mp3 dropped on the page is attached to the
  open transcription.

Each browser keeps its own storage, so the same file opened in Chrome and in
Safari (or on two computers) gives you two separate libraries. Use backups to
move work between them.

## Using it

- `?` or **shortcuts** (top right) lists every key, with a few notes on how
  the app works.
- `alt+/` or **notation** (top right) opens the notation reference.
- **explain** above the source: hover any character to see what it means.
- The library starts with Miles Davis's *Doxy*, a Flanagan demo and *Tenor Madness*.

You need an internet connection for playing the notation back (the instrument
samples come from a CDN) and for the UI fonts. Engraving, editing, storage and
mp3 playback all work offline.

## Building

```sh
npm install
npm run build     # → dist/transcribe.html
npm run watch     # rebuild on change
```

`build.mjs` bundles `src/transcribe/index.tsx` with esbuild, then inlines that
bundle, abcjs, the CSS and the chord font into one HTML page.

```
src/transcribe/     the app (Preact)
  app.tsx           layout, library, keys, backup/import
  songs.ts          the mp3 store (IndexedDB) and backup encoding
  persistence.ts    localStorage
  audio-pane.tsx    the song strip
  shortcuts-pane.tsx  the shortcuts / how-it-works panel
  doxy.ts, flanagan.ts, tenor-madness.ts  the bundled transcriptions
src/melodic-trainer/, src/rhythm-library/   shared notation helpers
assets/             CSS and the Petaluma Script chord font
```

## Licences of bundled code

- [abcjs](https://github.com/paulrosen/abcjs): MIT
- [Preact](https://preactjs.com): MIT
- [rubberband-web](https://github.com/delude88/rubberband-web)
  (Rubber Band): **GPL-2.0-or-later**. It's what keeps the pitch right when
  the recording plays slower or faster. Because it's in the bundle, anything
  you distribute from this repo, `dist/transcribe.html` included, has to be
  GPL-compatible.
- Petaluma Script font (Steinberg): SIL Open Font License
