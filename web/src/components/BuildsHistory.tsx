import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { postCancel } from '../api';
import type { BuildSummary, Phase } from '../types';
import { isRunning } from '../types';
import { errorMessage, formatTime } from '../format';
import { VirtualList } from './VirtualList';
import type { VirtualListHandle } from './VirtualList';

export function PhaseBadge({ phase }: { phase: Phase }) {
  return <span className={`phase-badge phase--${phase.toLowerCase()}`}>{phase}</span>;
}

/** Compact status light; color comes from the shared .phase--* classes. */
function PhaseDot({ phase }: { phase: Phase }) {
  return (
    <span
      className={`phase--${phase.toLowerCase()}`}
      aria-hidden="true"
      style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }}
    />
  );
}

/** Matches the .history-item layout (brief clamps at 2 lines + vertical padding). */
const ROW_HEIGHT = 54;

const DAY_MS = 86_400_000;
const DAY_LABELS = ['Today', 'Yesterday', 'Older'] as const;
type DayLabel = (typeof DAY_LABELS)[number];

function dayLabel(ts: number | undefined, startOfToday: number): DayLabel {
  if (!ts) return 'Older';
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - DAY_MS) return 'Yesterday';
  return 'Older';
}

/** Headers are presentation-only rows inside the same virtual list so keyboard
 *  navigation stays one continuous sequence across day groups. */
type HistoryRow =
  | { kind: 'header'; key: string; label: DayLabel; count: number }
  | { kind: 'build'; key: string; build: BuildSummary; option: number };

function fullTimestamp(ts: number | undefined): string | undefined {
  if (!ts) return undefined;
  return new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString();
}

interface BuildsHistoryProps {
  builds: BuildSummary[];
  loading: boolean;
  error: string | null;
  currentId?: string;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}

export function BuildsHistory({ builds, loading, error, currentId, onOpen, onRefresh }: BuildsHistoryProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [noteForId, setNoteForId] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const initedRef = useRef(false);

  const closePanel = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  const openBuild = useCallback(
    (id: string) => {
      closePanel();
      onOpen(id);
    },
    [closePanel, onOpen],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return builds;
    return builds.filter(
      (b) =>
        b.brief.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        b.phase.toLowerCase().includes(q),
    );
  }, [builds, query]);

  const { rows, optionToFlat } = useMemo(() => {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const buckets: Record<DayLabel, BuildSummary[]> = { Today: [], Yesterday: [], Older: [] };
    for (const b of filtered) buckets[dayLabel(b.createdAt, startOfToday)].push(b);
    const rows: HistoryRow[] = [];
    const optionToFlat: number[] = [];
    let option = 0;
    for (const label of DAY_LABELS) {
      const list = buckets[label];
      if (list.length === 0) continue;
      rows.push({ kind: 'header', key: `h-${label}`, label, count: list.length });
      for (const build of list) {
        optionToFlat.push(rows.length);
        rows.push({ kind: 'build', key: build.id, build, option });
        option += 1;
      }
    }
    return { rows, optionToFlat };
  }, [filtered]);

  const hasBuilds = builds.length > 0;
  const listReady = open && !loading && !error && rows.length > 0;
  const noMatches = open && !loading && !error && hasBuilds && rows.length === 0;

  // Fresh state per opening; focus lands in the search box.
  useEffect(() => {
    if (!open) {
      initedRef.current = false;
      setActiveIdx(-1);
      return;
    }
    setQuery('');
    setActionError(null);
    setNoteForId(null);
    searchRef.current?.focus();
  }, [open]);

  // Once per panel opening: select the currently open build without stealing
  // focus. Deliberately not re-run on later `builds` refreshes.
  useEffect(() => {
    if (!listReady || initedRef.current) return;
    initedRef.current = true;
    const cur = currentId ? filtered.findIndex((b) => b.id === currentId) : -1;
    setActiveIdx(cur);
    if (cur >= 0) listRef.current?.scrollToIndex(optionToFlat[cur]);
  }, [listReady, currentId, filtered, optionToFlat]);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // First Escape inside a non-empty search clears the filter; panel stays open.
      if (query && searchRef.current && searchRef.current.contains(e.target as Node)) {
        e.stopPropagation();
        setQuery('');
        setActiveIdx(-1);
        return;
      }
      e.stopPropagation();
      closePanel();
    }
    function onDocClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        !toggleRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onDocDown, true);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onDocDown, true);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open, query, closePanel]);

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && filtered.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => (i >= 0 ? i : 0));
      listRef.current?.focus();
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const n = filtered.length;
    if (n === 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = activeIdx < 0 ? 0 : Math.min(n - 1, activeIdx + 1);
    else if (e.key === 'ArrowUp') next = activeIdx < 0 ? n - 1 : Math.max(0, activeIdx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      if (activeIdx >= 0 && activeIdx < n) {
        e.preventDefault();
        openBuild(filtered[activeIdx].id);
      }
      return;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (activeIdx >= 0 && activeIdx < n) {
        e.preventDefault();
        void rowAction(filtered[activeIdx]);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    setActiveIdx(next);
    listRef.current?.scrollToIndex(optionToFlat[next]);
  }

  // Row affordance: running builds can be stopped via POST cancel; finished
  // builds live on disk, so instead of a fake delete we say where the file is.
  async function rowAction(b: BuildSummary) {
    if (pendingId !== null) return;
    if (isRunning(b.phase)) {
      setPendingId(b.id);
      setActionError(null);
      try {
        await postCancel(b.id);
        onRefresh();
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setPendingId(null);
      }
    } else {
      setNoteForId(b.id);
    }
  }

  return (
    <div className="history">
      <button
        type="button"
        className="btn btn--ghost btn--s"
        ref={toggleRef}
        onClick={() => {
          if (!open) onRefresh();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        History
        {builds.length > 0 && <span className="tab-count">{builds.length}</span>}
      </button>

      {open && (
        <>
          <div className="history-backdrop" aria-hidden="true" />
          <div className="history-panel" ref={panelRef} role="dialog" aria-label="Build history">
            <div className="history-head">
              <span>Build history</span>
              <span className="history-head-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={onRefresh}
                  aria-label="Refresh history"
                  title="Refresh"
                >
                  <svg width="12" height="12" viewBox="0 0 13 13" aria-hidden="true">
                    <path
                      d="M11 6.5a4.5 4.5 0 1 1-1.3-3.2M11 1v2.6H8.4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <button type="button" className="icon-btn" onClick={closePanel} aria-label="Close history" title="Close">
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            </div>

            <div className="history-search">
              <svg className="history-search-icon" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <circle cx="5.5" cy="5.5" r="3.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
                <path d="M8.3 8.3 11.5 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                className="history-search-input"
                type="text"
                placeholder="Search builds..."
                aria-label="Search builds"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(-1);
                }}
                onKeyDown={onSearchKeyDown}
              />
              {query && (
                <button
                  type="button"
                  className="icon-btn history-search-clear"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => {
                    setQuery('');
                    setActiveIdx(-1);
                    searchRef.current?.focus();
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>

            {loading && <p className="muted history-msg">Loading...</p>}
            {!loading && error && (
              <p className="history-msg inline-error" role="alert">
                {error}
              </p>
            )}
            {!loading && !error && !hasBuilds && (
              <p className="muted history-msg">No builds yet. Describe your first site and it will show up here.</p>
            )}
            {noMatches && <p className="muted history-msg">No builds match &quot;{query.trim()}&quot;.</p>}
            {actionError && (
              <p className="history-msg inline-error" role="alert">
                {actionError}
              </p>
            )}

            {listReady && (
              <VirtualList
                ref={listRef}
                items={rows}
                rowHeight={ROW_HEIGHT}
                overscan={6}
                className="history-list"
                role="listbox"
                ariaLabel="Recent builds"
                tabIndex={0}
                ariaActiveDescendant={
                  activeIdx >= 0 && activeIdx < filtered.length
                    ? `history-option-${filtered[activeIdx].id}`
                    : undefined
                }
                onKeyDown={onListKeyDown}
                getKey={(r) => r.key}
                render={(r) => {
                  if (r.kind === 'header') {
                    return (
                      <div className="history-group" role="presentation" style={{ height: '100%' }}>
                        <span className="history-group-label">{r.label}</span>
                        <span className="history-group-count muted">{r.count}</span>
                      </div>
                    );
                  }
                  const b = r.build;
                  const current = b.id === currentId;
                  const running = isRunning(b.phase);
                  const busy = pendingId === b.id;
                  const time = formatTime(b.createdAt);
                  return (
                    <div
                      role="option"
                      id={`history-option-${b.id}`}
                      aria-selected={current}
                      aria-setsize={filtered.length}
                      aria-posinset={r.option + 1}
                      aria-busy={busy || undefined}
                      aria-label={`${b.phase.toLowerCase()} build: ${b.brief || 'no brief'}${time ? `, ${time}` : ''}`}
                      className={`history-item${current ? ' is-current' : ''}${r.option === activeIdx ? ' is-active' : ''}`}
                      style={{ height: '100%', background: r.option === activeIdx && !current ? 'var(--bg-3)' : undefined }}
                      onClick={() => openBuild(b.id)}
                      onMouseMove={() => {
                        if (r.option !== activeIdx) setActiveIdx(r.option);
                      }}
                    >
                      <PhaseDot phase={b.phase} />
                      <span className="history-brief" title={b.brief}>
                        {b.brief || '(no brief)'}
                      </span>
                      {time && (
                        <span className="history-time muted" title={fullTimestamp(b.createdAt)}>
                          {time}
                        </span>
                      )}
                      <button
                        type="button"
                        className={`history-del icon-btn${busy ? ' is-busy' : ''}`}
                        aria-label={
                          running ? `Stop build: ${b.brief || b.id}` : `Remove from history: ${b.brief || b.id}`
                        }
                        title={running ? 'Stop this build' : 'Remove from history'}
                        disabled={pendingId !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void rowAction(b);
                        }}
                      >
                        {running ? (
                          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                            <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" fill="currentColor" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                            <path
                              d="M2 3h8M4.5 3V1.9a.4.4 0 0 1 .4-.4h2.2a.4.4 0 0 1 .4.4V3M3.2 3.3l.5 6.4a.8.8 0 0 0 .8.8h3a.8.8 0 0 0 .8-.8l.5-6.4M5 5.4v3.2M7 5.4v3.2"
                              stroke="currentColor"
                              strokeWidth="1.1"
                              fill="none"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    </div>
                  );
                }}
              />
            )}

            {noteForId && (
              <div className="history-note" role="status">
                <span>
                  Finished builds stay on disk in the server data folder (data/builds/{noteForId}.json). Delete the
                  file there and refresh to remove this entry.
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Dismiss note"
                  title="Dismiss"
                  onClick={() => setNoteForId(null)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
