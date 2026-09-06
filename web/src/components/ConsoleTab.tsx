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

const LEVEL_COLOR: Record<RowLevel, string> = {
  log: 'var(--text-2)',
  warn: 'var(--warn)',
  error: 'var(--err)',
};

function LevelIcon({ row }: { row: ConsoleRow }) {
  const color = LEVEL_COLOR[row.level];
  if (row.kind === 'network') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ color, flexShrink: 0 }}>
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
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ color, flexShrink: 0 }}>
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

const toolbarBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border-0)',
  borderRadius: 'var(--radius-s)',
  color: 'var(--text-1)',
  font: 'inherit',
  cursor: 'pointer',
};

interface ConsoleTabProps {
  buildId: string;
  onCountChange?: (count: number) => void;
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
    onCountChange?.(rows.length);
  }, [rows.length, onCountChange]);

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
      showToast('ok', 'Sent to the team — the builder will attempt a fix.');
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 12, color: 'var(--text-1)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border-0)',
          flexWrap: 'wrap',
        }}
      >
        <div role="group" aria-label="Filter console entries" style={{ display: 'flex', gap: 4 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              style={{
                ...toolbarBtnStyle,
                ...(filter === f.id ? { borderColor: 'var(--accent)', color: 'var(--text-0)' } : null),
              }}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id !== 'all' && (
                <span style={{ color: 'var(--text-2)', marginLeft: 4 }}>
                  {rows.filter((r) => rowMatchesFilter(r, f.id)).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {paused && dropped > 0 && <span style={{ color: 'var(--warn)' }}>paused — {dropped} dropped</span>}
        <button
          type="button"
          style={toolbarBtnStyle}
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
          style={toolbarBtnStyle}
          disabled={rows.length === 0}
          onClick={() => {
            setRows([]);
            setExpanded(new Set());
          }}
        >
          Clear
        </button>
      </div>

      <div role="log" aria-label="Preview console" style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {visible.length === 0 ? (
          <p style={{ padding: '12px', margin: 0, color: 'var(--text-2)' }}>
            {rows.length === 0
              ? 'Console output, page errors and network requests from the preview appear here.'
              : 'No entries match this filter.'}
          </p>
        ) : (
          visible.map((row) => {
            const isOpen = expanded.has(row.id);
            return (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                  padding: '4px 10px',
                  borderBottom: '1px solid var(--border-0)',
                  background: row.level === 'error' ? 'color-mix(in srgb, var(--err) 8%, transparent)' : undefined,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <span style={{ marginTop: 2, display: 'inline-flex' }}>
                  <LevelIcon row={row} />
                </span>
                <span style={{ color: 'var(--text-2)', flexShrink: 0 }}>{formatTime(row.ts)}</span>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <span style={{ color: row.level === 'error' ? 'var(--err)' : row.level === 'warn' ? 'var(--warn)' : 'var(--text-0)' }}>
                    {row.kind === 'network' && (
                      <span style={{ color: 'var(--text-2)' }}>
                        {row.method} {row.status !== undefined ? `${row.status} ` : ''}
                      </span>
                    )}
                    {row.kind === 'network' ? row.url : row.text}
                  </span>
                  {row.file && (
                    <span style={{ color: 'var(--text-2)' }}>
                      {' '}
                      {row.file}
                      {row.line !== undefined ? `:${row.line}` : ''}
                    </span>
                  )}
                  {row.details !== undefined && (
                    <>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        style={{ ...toolbarBtnStyle, marginLeft: 6, padding: '0 6px', fontSize: 11 }}
                        onClick={() => toggleExpanded(row.id)}
                      >
                        {isOpen ? 'Hide details' : 'Show details'}
                      </button>
                      {isOpen && (
                        <pre
                          style={{
                            margin: '4px 0 0',
                            padding: 8,
                            background: 'var(--bg-2)',
                            borderRadius: 'var(--radius-s)',
                            overflowX: 'auto',
                            color: 'var(--text-1)',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {row.details}
                        </pre>
                      )}
                    </>
                  )}
                </div>
                {row.level === 'error' && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--s"
                    style={{ flexShrink: 0 }}
                    disabled={fixingId !== null}
                    onClick={() => fixError(row)}
                  >
                    {fixingId === row.id ? 'Sending…' : 'Fix this error'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {toast && (
        <p
          role="status"
          style={{
            margin: 0,
            padding: '6px 10px',
            borderTop: '1px solid var(--border-0)',
            color: toast.kind === 'ok' ? 'var(--ok)' : 'var(--err)',
          }}
        >
          {toast.text}
        </p>
      )}
    </div>
  );
}
