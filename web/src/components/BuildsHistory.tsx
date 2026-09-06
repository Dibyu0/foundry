import { useEffect, useRef, useState } from 'react';
import type { BuildSummary, Phase } from '../types';
import { formatTime } from '../format';

export function PhaseBadge({ phase }: { phase: Phase }) {
  return <span className={`phase-badge phase--${phase.toLowerCase()}`}>{phase}</span>;
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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (items.length === 0) return;
    const active = document.activeElement;
    const idx = items.findIndex((el) => el === active);
    let next = 0;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
    if (e.key === 'ArrowUp') next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = items.length - 1;
    items[next]?.focus();
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

          {!loading && !error && builds.length > 0 && (
            <ul className="history-list" role="listbox" aria-label="Recent builds" onKeyDown={onListKeyDown}>
              {builds.map((b, i) => (
                <li key={b.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={b.id === currentId}
                    className={`history-item${b.id === currentId ? ' is-current' : ''}`}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onClick={() => openBuild(b.id)}
                  >
                    <span className="history-brief" title={b.brief}>
                      {b.brief || '(no brief)'}
                    </span>
                    <span className="history-meta">
                      <PhaseBadge phase={b.phase} />
                      <span className="muted">{formatTime(b.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
