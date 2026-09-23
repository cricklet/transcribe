// The filterable syntax reference pane.
//
// Every line of the upstream README's syntax list, searchable by symbol or by
// prose ("octave", "'", "pickup", "verse two"), and honest about what this
// app's abcjs renderer can actually draw.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CHEATSHEET, Entry, Support, SUPPORT_LABEL, filterCheatsheet } from './cheatsheet';

type Props = {
  onClose?: () => void;
  // Put the caret straight in the filter when opened as a popover, so you can
  // hit alt+/ and start typing.
  autoFocus?: boolean;
};

export function CheatSheet({ onClose, autoFocus }: Props) {
  const [q, setQ] = useState('');
  const [hideUnsupported, setHideUnsupported] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const rows = useMemo(() => {
    let r = filterCheatsheet(q);
    if (hideUnsupported) r = r.filter(e => e.support !== 'no');
    return r;
  }, [q, hideUnsupported]);

  // Keep the upstream grouping, but only for groups that survived the filter.
  const groups = useMemo(() => {
    const byGroup = new Map<string, Entry[]>();
    for (const e of rows) {
      const list = byGroup.get(e.group) ?? [];
      list.push(e);
      byGroup.set(e.group, list);
    }
    return Array.from(byGroup.entries());
  }, [rows]);

  return (
    <section class="jp-cheat">
      <div class="jp-pane-head">
        <span class="jp-pane-title">Syntax</span>
        <span class="jp-cheat-head-r">
          <span class="jp-cheat-count">{rows.length}/{CHEATSHEET.length}</span>
          {onClose && (
            <button class="jp-cheat-clear" data-hint="close" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M5.3 4.2 12 10.9l6.7-6.7a.8.8 0 0 1 1.1 1.1L13.1 12l6.7 6.7a.8.8 0 0 1-1.1 1.1L12 13.1l-6.7 6.7a.8.8 0 0 1-1.1-1.1L10.9 12 4.2 5.3a.8.8 0 0 1 1.1-1.1Z" />
              </svg>
            </button>
          )}
        </span>
      </div>

      <div class="jp-cheat-filter">
        <input
          class="jp-cheat-input"
          ref={inputRef}
          value={q}
          placeholder="filter — try octave, pickup, tuplet, ~"
          spellcheck={false}
          aria-label="Filter the syntax reference"
          onInput={e => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={e => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
        />
        {q && (
          <button class="jp-cheat-clear" data-hint="clear" aria-label="Clear the filter"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M5.3 4.2 12 10.9l6.7-6.7a.8.8 0 0 1 1.1 1.1L13.1 12l6.7 6.7a.8.8 0 0 1-1.1 1.1L12 13.1l-6.7 6.7a.8.8 0 0 1-1.1-1.1L10.9 12 4.2 5.3a.8.8 0 0 1 1.1-1.1Z" />
            </svg>
          </button>
        )}
      </div>

      <label class="jp-cheat-only">
        <input type="checkbox" checked={hideUnsupported}
          onChange={e => setHideUnsupported((e.target as HTMLInputElement).checked)} />
        only what this app engraves
      </label>

      <div class="jp-cheat-list">
        {groups.map(([name, entries]) => (
          <div class="jp-cheat-group" key={name}>
            <div class="jp-cheat-gname">{name}</div>
            {entries.map((e, i) => (
              <div class="jp-cheat-row" key={`${name}-${i}`}>
                <code class="jp-cheat-syntax">{e.syntax}</code>
                <span class="jp-cheat-what">{e.what}</span>
                <SupportTag support={e.support} note={e.note} />
              </div>
            ))}
          </div>
        ))}
        {!rows.length && <div class="jp-empty">Nothing matches “{q}”.</div>}
      </div>
    </section>
  );
}

function SupportTag({ support, note }: { support: Support; note?: string }) {
  if (support === 'yes' && !note) return null;
  return (
    <span class={`jp-sup jp-sup-${support}`} title={note ?? SUPPORT_LABEL[support]}>
      {SUPPORT_LABEL[support]}{note ? ` — ${note}` : ''}
    </span>
  );
}
