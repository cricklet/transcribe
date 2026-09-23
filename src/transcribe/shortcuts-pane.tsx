// The keyboard shortcuts, and a few lines on how the app hangs together —
// opened from the link in the top right, or with ?. Everything listed here is
// wired up elsewhere (app.tsx, editor.tsx, staff.tsx, audio-pane.tsx); this is
// only the list, so a key that moves there has to move here too.

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const CMD = MAC ? '⌘' : 'Ctrl';
const ALT = MAC ? '⌥' : 'Alt';
const SHIFT = MAC ? '⇧' : 'Shift';

type Row = { keys: string[][]; what: string };
type Group = { title: string; rows: Row[] };

// Each row's keys are alternatives; each alternative is a chord of keys.
const GROUPS: Group[] = [
  {
    title: 'Anywhere',
    rows: [
      { keys: [['`']], what: 'switch between the library and the source' },
      { keys: [['/']], what: 'search the library' },
      { keys: [[ALT, '/']], what: 'notation reference' },
      { keys: [['?']], what: 'this list' },
      { keys: [[CMD, 'S']], what: 'save the open transcription (with its song) as a file' },
      { keys: [[CMD, 'Z'], [CMD, SHIFT, 'Z']], what: 'undo / redo — bookmark moves included' },
      { keys: [['Esc']], what: 'close a panel' },
    ],
  },
  {
    title: 'Writing the source',
    rows: [
      { keys: [[ALT, '['], [ALT, ']']], what: 'step to the previous / next note and hear it' },
      { keys: [[ALT, '\\']], what: 'play on from the caret' },
      { keys: [[ALT, '←'], [ALT, '→']], what: 'move a token at a time (add shift to select)' },
      { keys: [[CMD, '/']], what: 'comment the line out, or back in' },
      { keys: [['Tab']], what: 'indent' },
    ],
  },
  {
    title: 'On the notation',
    rows: [
      { keys: [['click']], what: 'put the caret on that note (and hear it)' },
      { keys: [['double-click']], what: 'play from that note' },
      { keys: [['click a chord']], what: 'hear the chord' },
    ],
  },
  {
    title: 'The recording',
    rows: [
      { keys: [[ALT, 'Space']], what: 'play / stop from the playhead' },
      { keys: [[ALT, 'R']], what: 'play from the start marker' },
      { keys: [[ALT, 'Enter']], what: 'stop and rewind to where the run began; again to replay' },
      { keys: [[ALT, 'S']], what: 'move the start marker to the playhead' },
      { keys: [[ALT, ','], [ALT, '.']], what: 'nudge the start back / on a beat' },
      { keys: [[ALT, SHIFT, ','], [ALT, SHIFT, '.']], what: '…taking the bookmark under it along' },
      { keys: [[ALT, 'M']], what: 'drop a bookmark at the playhead' },
      { keys: [[ALT, '1'], [ALT, '0']], what: 'jump to bookmark 1 … 10 (type two digits for 11+)' },
      { keys: [[ALT, '-'], [ALT, '=']], what: 'previous / next bookmark' },
    ],
  },
  {
    title: 'Library search',
    rows: [
      { keys: [['↑'], ['↓']], what: 'move through the matches' },
      { keys: [['Enter']], what: 'open it' },
      { keys: [['Esc']], what: 'clear the search' },
    ],
  },
];

function Chord({ keys }: { keys: string[] }) {
  return (
    <span class="jp-keys-chord">
      {keys.map((k, i) => <kbd key={i}>{k}</kbd>)}
    </span>
  );
}

export function Shortcuts({ onClose, onReference }: { onClose: () => void; onReference: () => void }) {
  return (
    <section class="jp-keys">
      <div class="jp-pane-head">
        <span class="jp-pane-title">How it works</span>
        <button class="jp-cheat-clear" data-hint="close" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
            <path d="M5.3 4.2 12 10.9l6.7-6.7a.8.8 0 0 1 1.1 1.1L13.1 12l6.7 6.7a.8.8 0 0 1-1.1 1.1L12 13.1l-6.7 6.7a.8.8 0 0 1-1.1-1.1L10.9 12 4.2 5.3a.8.8 0 0 1 1.1-1.1Z" />
          </svg>
        </button>
      </div>
      <div class="jp-keys-body">
        <ul class="jp-keys-about">
          <li>
            Write in numbers — <code>1=C</code> sets the key, <code>1 2 3</code> are scale degrees — and the
            staff engraves as you type. Turn on <b>explain</b> and hover any character to see what it means,
            or open the <button class="jp-keys-link" onClick={onReference}>notation reference</button>{' '}
            (<Chord keys={[ALT, '/']} />).
          </li>
          <li>
            Attach a recording from the strip along the bottom, or drop an mp3 anywhere on the page.
            Bookmarks you drop on it are numbered, and <code>M1</code>, <code>M2</code> … in the source
            line up with them.
          </li>
          <li>
            Everything is kept in <b>this browser</b> only. <Chord keys={[CMD, 'S']} /> downloads the open
            transcription with its song; <b>export</b> under the library downloads all of it. Drop a
            downloaded file on the page to bring it back — here or on someone else’s computer.
          </li>
        </ul>
        {GROUPS.map(g => (
          <div class="jp-keys-group" key={g.title}>
            <div class="jp-keys-title">{g.title}</div>
            {g.rows.map((r, i) => (
              <div class="jp-keys-row" key={i}>
                <span class="jp-keys-keys">
                  {r.keys.map((k, j) => (
                    <>
                      {j > 0 && <span class="jp-keys-or">/</span>}
                      <Chord keys={k} />
                    </>
                  ))}
                </span>
                <span class="jp-keys-what">{r.what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
