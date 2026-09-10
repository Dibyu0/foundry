import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isBufferMessage,
  isPreviewEntry,
  subscribePreview,
  type ConsoleEntry as BridgeConsoleEntry,
  type ErrorEntry,
  type NetworkEntry,
  type PreviewEntry,
} from '../previewBridge';
import { CONSOLE_FEED_CAP } from '../lib/pure';

/* ------------------------------------------------------------------ */
/* Console feed for the preview bridge. The bridge streams typed       */
/* entries (console / error / network) plus 'buffer' replays; we map   */
/* them into rows. Error rows offer "Fix this error" -> POST           */
/* /api/builds/:id/fixError {message, file?, line?}.                   */
/* ------------------------------------------------------------------ */

export type RowLevel = 'log' | 'warn' | 'error';

export interface ConsoleRow {
  id: number;
  kind: 'console' | 'error' | 'network';
  level: RowLevel;
  text: string;
  ts: number;
  file?: string;
  line?: number;
  method?: string;
  url?: string;
  status?: number;
  /** Pretty-printable details (stack trace or JSON payload), when available. */
  details?: string;
}

/** Severity tallies reported to the workspace tab badge. */
export interface ConsoleCounts {
  total: number;
  errors: number;
  warnings: number;
}

export type ConsoleFilter = 'all' | 'log' | 'warn' | 'error' | 'network';

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Pretty-print a string when it holds a JSON object/array; null otherwise. */
export function jsonDetails(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

let nextRowId = 1;

function consoleRow(entry: BridgeConsoleEntry): ConsoleRow {
  const row: ConsoleRow = { id: nextRowId++, kind: 'console', level: entry.level, text: entry.text, ts: entry.ts };
  const details = jsonDetails(entry.text);
  if (details !== null) row.details = details;
  return row;
}

function errorRow(entry: ErrorEntry): ConsoleRow {
  const row: ConsoleRow = { id: nextRowId++, kind: 'error', level: 'error', text: entry.message, ts: entry.ts };
  if (entry.file) row.file = entry.file;
  if (entry.line !== undefined) row.line = entry.line;
  if (entry.stack) row.details = entry.stack;
  return row;
}

function networkRow(entry: NetworkEntry): ConsoleRow {
  const failed = !entry.ok || (entry.status !== undefined && entry.status >= 400);
  const row: ConsoleRow = {
    id: nextRowId++,
    kind: 'network',
    level: failed ? 'error' : 'log',
    text: `${entry.method} ${entry.url}`,
    ts: entry.ts,
    method: entry.method,
    url: entry.url,
  };
  if (entry.status !== undefined) row.status = entry.status;
  if (entry.error) row.details = entry.error;
  return row;
}

/** Map a typed bridge feed entry onto a render row. */
export function rowFromEntry(entry: PreviewEntry): ConsoleRow {
  if (entry.kind === 'console') return consoleRow(entry);
  if (entry.kind === 'error') return errorRow(entry);
  return networkRow(entry);
}

/** Buckets a row belongs to for the severity filter. */
export function rowMatchesFilter(row: ConsoleRow, filter: ConsoleFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'network') return row.kind === 'network';
  if (row.kind === 'network') return filter === 'error' && row.level === 'error';
  return row.level === filter;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function LevelIcon({ row }: { row: ConsoleRow }) {
  if (row.kind === 'network') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="console-row-icon">
        <path
          d="M1.5 4h7M7 2.5 8.5 4 7 5.5M10.5 8h-7M5 6.5 3.5 8 5 9.5"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="console-row-icon">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
      {row.level === 'error' ? (
        <path d="M4.2 4.2 7.8 7.8M7.8 4.2 4.2 7.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      ) : row.level === 'warn' ? (
        <path d="M6 3.4v3M6 8.4v.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      ) : (
        <path d="M6 5.4v3M6 3.4v.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

const FILTERS: { id: ConsoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'log', label: 'Logs' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
  { id: 'network', label: 'Network' },
];

interface ConsoleTabProps {
  buildId: string;
  onCountChange?: (counts: ConsoleCounts) => void;
}

export function ConsoleTab({ buildId, onCountChange }: ConsoleTabProps) {
  const [rows, setRows] = useState<ConsoleRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [dropped, setDropped] = useState(0);
  const [filter, setFilter] = useState<ConsoleFilter>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [fixingId, setFixingId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const pausedRef = useRef(paused);
  const toastTimer = useRef<number | undefined>(undefined);
  pausedRef.current = paused;

  useEffect(() => {
    setRows([]);
    setDropped(0);
    setToast(null);
  }, [buildId]);

  useEffect(() => {
    const push = (entry: PreviewEntry) => {
      if (pausedRef.current) {
        setDropped((d) => d + 1);
        return;
      }
      const row = rowFromEntry(entry);
      setRows((list) =>
        list.length >= CONSOLE_FEED_CAP ? [...list.slice(list.length - CONSOLE_FEED_CAP + 1), row] : [...list, row],
      );
    };
    const unsub = subscribePreview((msg) => {
      if (isPreviewEntry(msg)) push(msg);
      else if (isBufferMessage(msg)) for (const entry of msg.entries) push(entry);
    });
    return unsub;
  }, []);

  useEffect(() => {
    let errors = 0;
    let warnings = 0;
    for (const row of rows) {
      if (row.level === 'error') errors += 1;
      else if (row.level === 'warn') warnings += 1;
    }
    onCountChange?.({ total: rows.length, errors, warnings });
  }, [rows, onCountChange]);

  useEffect(
    () => () => {
      if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 8000);
  }, []);

  async function fixError(row: ConsoleRow) {
    if (fixingId !== null) return;
    setFixingId(row.id);
    try {
      const body: Record<string, unknown> = { message: row.text };
      if (row.file) body.file = row.file;
      if (row.line !== undefined) body.line = row.line;
      const res = await fetch(`/api/builds/${encodeURIComponent(buildId)}/fixError`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Fix request failed (${res.status})`;
        try {
          const parsed: unknown = await res.json();
          const err = rec(parsed)?.error;
          if (typeof err === 'string' && err) message = err;
        } catch {
          /* keep status-based message */
        }
        throw new Error(message);
      }
      showToast('ok', 'Sent to the team - the builder will attempt a fix.');
    } catch (e) {
      showToast('err', e instanceof Error ? e.message : 'Fix request failed.');
    } finally {
      setFixingId(null);
    }
  }

  function toggleExpanded(id: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visible = rows.filter((r) => rowMatchesFilter(r, filter));

  return (
    <div className="console">
      <div className="console-toolbar">
        <div className="console-filters" role="group" aria-label="Filter console entries">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="console-filter"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id !== 'all' && (
                <span className="console-filter-count">{rows.filter((r) => rowMatchesFilter(r, f.id)).length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="console-actions">
          {paused && dropped > 0 && <span className="console-paused-note">paused - {dropped} dropped</span>}
          <button
            type="button"
            className="console-action"
            aria-pressed={paused}
            onClick={() => {
              setPaused((p) => !p);
              setDropped(0);
            }}
          >
            {paused ? 'Resume capture' : 'Pause capture'}
          </button>
          <button
            type="button"
            className="console-action"
            disabled={rows.length === 0}
            onClick={() => {
              setRows([]);
              setExpanded(new Set());
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="console-log" role="log" aria-label="Preview console">
        {visible.length === 0 ? (
          <div className="console-empty">
            <svg className="empty-icon" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <rect x="4" y="6" width="26" height="22" rx="2.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path
                d="M9 13.5 13 17l-4 3.5M15.5 21h6"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p>
              {rows.length === 0
                ? 'Console output, page errors and network requests from the preview appear here.'
                : 'No entries match this filter.'}
            </p>
            {rows.length === 0 && (
              <p className="empty-sub">Interact with the preview and events stream in live.</p>
            )}
          </div>
        ) : (
          visible.map((row) => {
            const isOpen = expanded.has(row.id);
            return (
              <div key={row.id} className={`console-row console-row--${row.level}`}>
                <LevelIcon row={row} />
                <span className="console-row-time">{formatTime(row.ts)}</span>
                <div className="console-row-body">
                  <span className="console-row-text">
                    {row.kind === 'network' && (
                      <span className="console-row-meta">
                        {row.method}
                        {row.status !== undefined ? ` ${row.status}` : ''}
                      </span>
                    )}
                    {row.kind === 'network' ? row.url : row.text}
                  </span>
                  {row.file && (
                    <span className="console-row-loc">
                      {row.file}
                      {row.line !== undefined ? `:${row.line}` : ''}
                    </span>
                  )}
                  {row.details !== undefined && (
                    <>
                      <button
                        type="button"
                        className="console-details-btn"
                        aria-expanded={isOpen}
                        onClick={() => toggleExpanded(row.id)}
                      >
                        {isOpen ? 'Hide details' : 'Show details'}
                      </button>
                      {isOpen && <pre className="console-details">{row.details}</pre>}
                    </>
                  )}
                </div>
                {row.level === 'error' && (
                  <button
                    type="button"
                    className="console-fix"
                    disabled={fixingId !== null}
                    onClick={() => fixError(row)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" className="console-fix-icon">
                      <path
                        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                        stroke="currentColor"
                        strokeWidth="2"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {fixingId === row.id ? 'Sending...' : 'Fix this error'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {toast && (
        <p role="status" className={`console-toast console-toast--${toast.kind}`}>
          {toast.text}
        </p>
      )}
    </div>
  );
}
