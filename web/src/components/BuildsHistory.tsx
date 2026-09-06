import { useEffect, useRef, useState } from 'react';
import type { BuildSummary, Phase } from '../types';
import { formatTime } from '../format';
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

/** Matches the two-line .history-item layout (padding 2x8 + gap 4 + ~17/~16 line heights). */
const ROW_HEIGHT = 54;

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
  const [activeIdx, setActiveIdx] = useState(-1);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const initedRef = useRef(false);

  const listReady = open && !loading && !error && builds.length > 0;

  useEffect(() => {
    if (open) return;
    initedRef.current = false;
    setActiveIdx(-1);
  }, [open]);

  // Once per panel opening: focus the listbox and select the currently open build.
  // Deliberately not re-run on later `builds` refreshes, which would steal focus mid-navigation.
  useEffect(() => {
    if (!listReady || initedRef.current) return;
    initedRef.current = true;
    const cur = currentId ? builds.findIndex((b) => b.id === currentId) : -1;
    setActiveIdx(cur);
    listRef.current?.focus();
    if (cur >= 0) listRef.current?.scrollToIndex(cur);
  }, [listReady, currentId, builds]);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    function onDocClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) && e.target !== toggleRef.current) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onDocDown, true);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onDocDown, true);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open]);

  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const n = builds.length;
    if (n === 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = activeIdx < 0 ? 0 : Math.min(n - 1, activeIdx + 1);
    else if (e.key === 'ArrowUp') next = activeIdx < 0 ? n - 1 : Math.max(0, activeIdx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      if (activeIdx >= 0 && activeIdx < n) {
        e.preventDefault();
        openBuild(builds[activeIdx].id);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    setActiveIdx(next);
    listRef.current?.scrollToIndex(next);
  }

  function openBuild(id: string) {
    setOpen(false);
    toggleRef.current?.focus();
    onOpen(id);
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
        aria-haspopup="listbox"
      >
        History
        {builds.length > 0 && <span className="tab-count">{builds.length}</span>}
      </button>

      {open && (
        <div className="history-panel" ref={panelRef}>
          <div className="history-head">
            <span>Recent builds</span>
            <button type="button" className="icon-btn" onClick={onRefresh} aria-label="Refresh history" title="Refresh">
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
          </div>

          {loading && <p className="muted history-msg">Loading…</p>}
          {!loading && error && (
            <p className="history-msg inline-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !error && builds.length === 0 && <p className="muted history-msg">No builds yet.</p>}

          {listReady && (
            <VirtualList
              ref={listRef}
              items={builds}
              rowHeight={ROW_HEIGHT}
              overscan={6}
              className="history-list"
              role="listbox"
              ariaLabel="Recent builds"
              tabIndex={0}
              ariaActiveDescendant={
                activeIdx >= 0 && activeIdx < builds.length ? `history-option-${builds[activeIdx].id}` : undefined
              }
              onKeyDown={onListKeyDown}
              getKey={(b) => b.id}
              render={(b, i) => {
                const current = b.id === currentId;
                return (
                  <button
                    type="button"
                    role="option"
                    id={`history-option-${b.id}`}
                    tabIndex={-1}
                    aria-selected={current}
                    aria-setsize={builds.length}
                    aria-posinset={i + 1}
                    className={`history-item${current ? ' is-current' : ''}`}
                    style={{ height: '100%', background: i === activeIdx && !current ? 'var(--bg-3)' : undefined }}
                    onClick={() => openBuild(b.id)}
                    onMouseMove={() => {
                      if (i !== activeIdx) setActiveIdx(i);
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
                      <PhaseDot phase={b.phase} />
                      <span className="history-brief" title={b.brief}>
                        {b.brief || '(no brief)'}
                      </span>
                    </span>
                    <span className="history-meta">
                      <span className={`phase--${b.phase.toLowerCase()}`} style={{ fontWeight: 600 }}>
                        {b.phase}
                      </span>
                      <span className="muted" title={fullTimestamp(b.createdAt)}>
                        {formatTime(b.createdAt)}
                      </span>
                    </span>
                  </button>
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
