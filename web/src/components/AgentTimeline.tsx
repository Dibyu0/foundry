import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, Phase, ReviewIssue, RoleId, RoleState, SiteFile } from '../types';
import { ROLE_IDS, ROLE_LABELS, asRoleId } from '../types';
import { baseName, formatBytes } from '../format';
import { highlightLines, langFor } from '../highlight';

const ROLE_PHASE: Record<RoleId, Phase> = {
  planner: 'INTAKE',
  design: 'BUILDING',
  copy: 'BUILDING',
  builder: 'BUILDING',
  reviewer: 'REVIEW',
};

const PHASE_ORDER: readonly Phase[] = ['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW', 'DONE'];

/** Lines of source shown in an expanded file card. */
export const PREVIEW_LINES = 12;

/** Window event dispatched when the user asks to see a file in the Code tab.
 *  The onOpenFile prop takes precedence when the integrator wires it. */
export const OPEN_FILE_EVENT = 'foundry:open-file';

/* ------------------------------------------------------------------
 * Pure presentation helpers - candidates for web/src/lib/pure.ts once
 * WEBTYPES lands it (see the integrator note in the wave report).
 * ------------------------------------------------------------------ */

/** Per-agent accent colors. styles.css has no per-role palette yet (POLISH
 *  owns it), so until then these are applied inline. */
export const ROLE_COLORS: Record<RoleId, string> = {
  planner: '#5ea8ff',
  design: '#b98cff',
  copy: '#f5c542',
  builder: '#ff7a45',
  reviewer: '#3fce8b',
};

const EXTRA_ROLE_PALETTE = ['#5ea8ff', '#b98cff', '#f5c542', '#ff7a45', '#3fce8b', '#f0616d'];

/** Color for any role name; unknown (custom) roles hash deterministically
 *  into the palette so their cards and tags always match. */
export function roleColor(role: string): string {
  const id = asRoleId(role);
  if (id) return ROLE_COLORS[id];
  let h = 0;
  for (let i = 0; i < role.length; i += 1) h = (h * 31 + role.charCodeAt(i)) >>> 0;
  return EXTRA_ROLE_PALETTE[h % EXTRA_ROLE_PALETTE.length];
}

export type DisplayState = 'queued' | 'active' | 'done' | 'skipped' | 'error';

/** Fallback hint derived from the build phase; explicit SSE activity events
 *  for a role always win over this. */
function phaseHint(phase: Phase | undefined, role: RoleId): RoleState {
  if (!phase) return 'idle';
  if (phase === 'DONE') return 'done';
  if (phase === 'ERROR' || phase === 'CANCELLED') return 'idle';
  const pi = PHASE_ORDER.indexOf(phase);
  const ri = PHASE_ORDER.indexOf(ROLE_PHASE[role]);
  if (pi < 0 || ri < 0 || pi < ri) return 'idle';
  return pi > ri ? 'done' : 'active';
}

/** Precise row state for a role. Activity events are the source of truth; a
 *  role with no event by the time a live build reaches a terminal phase was
 *  skipped. Builds loaded from history carry no activity, so a terminal
 *  phase falls back to the phase hint (DONE implies the pipeline ran). */
export function roleDisplay(
  role: string,
  activity: Record<string, ActivityEvent>,
  phase: Phase | undefined,
): { state: DisplayState; note?: string } {
  const ev = activity[role];
  if (ev) {
    const s = ev.state;
    if (s === 'idle') return { state: 'queued' };
    return { state: s, ...(ev.note !== undefined ? { note: ev.note } : {}) };
  }
  if (!phase) return { state: 'queued' };
  const terminal = phase === 'DONE' || phase === 'ERROR' || phase === 'CANCELLED';
  if (terminal) {
    if (Object.keys(activity).length > 0) return { state: 'skipped' };
    return { state: phase === 'DONE' ? 'done' : 'skipped' };
  }
  const id = asRoleId(role);
  const hint = id ? phaseHint(phase, id) : 'idle';
  if (hint === 'active') return { state: 'active' };
  if (hint === 'done') return { state: 'done' };
  return { state: 'queued' };
}

/** Fixed file ownership of the pipeline (README role table); used only when
 *  no live activity can explain a write. */
const EXT_ROLE: Record<string, string> = {
  css: 'design',
  html: 'copy',
  htm: 'copy',
  js: 'builder',
  mjs: 'builder',
  cjs: 'builder',
};

/** First-writer attribution for a file, from best to worst evidence: an
 *  active role whose note names the file, then the single active role, then
 *  the pipeline's fixed ownership. Null means unknown - neutral border. */
export function attributeFile(path: string, activity: Record<string, ActivityEvent>): string | null {
  const base = baseName(path).toLowerCase();
  const actives = Object.entries(activity).filter(([, e]) => e.state === 'active');
  const named = actives.find(([, e]) => (e.note ?? '').toLowerCase().includes(base));
  if (named) return named[0];
  if (actives.length === 1) return actives[0][0];
  const dot = base.lastIndexOf('.');
  const ext = dot < 0 ? '' : base.slice(dot + 1);
  return EXT_ROLE[ext] ?? null;
}

/** Compact clock for durations: 12s, 1m 05s, 2h 03m. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const STATE_LABELS: Record<DisplayState, string> = {
  queued: 'queued',
  active: 'active',
  done: 'done',
  skipped: 'skipped',
  error: 'error',
};

const SEV_COLORS: Record<ReviewIssue['severity'], string> = {
  info: 'var(--info)',
  warn: 'var(--warn)',
  error: 'var(--err)',
};

const EXT_ICON_COLORS: Record<string, string> = {
  html: 'var(--accent)',
  htm: 'var(--accent)',
  svg: 'var(--accent)',
  css: 'var(--info)',
  js: 'var(--warn)',
  mjs: 'var(--warn)',
  cjs: 'var(--warn)',
  json: 'var(--ok)',
  md: 'var(--ok)',
  txt: 'var(--ok)',
  png: 'var(--ok)',
  jpg: 'var(--ok)',
  jpeg: 'var(--ok)',
  gif: 'var(--ok)',
  webp: 'var(--ok)',
  ico: 'var(--ok)',
  woff: 'var(--ok)',
  woff2: 'var(--ok)',
};

function capFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function writerLabel(role: string): string {
  const id = asRoleId(role);
  return id ? ROLE_LABELS[id] : role;
}

function FileIcon({ path }: { path: string }) {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  const ext = dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
  const color = EXT_ICON_COLORS[ext] ?? 'var(--text-2)';
  return (
    <span
      className="ff-icon"
      title={ext !== '' ? `.${ext}` : 'file'}
      aria-hidden="true"
      style={{ display: 'inline-flex', flex: '0 0 auto', color }}
    >
      <svg width="11" height="13" viewBox="0 0 12 14">
        <path
          d="M2.5 1h4.2L10 4.2V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M6.7 1v3.2H10" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

interface RoleTiming {
  startedAt?: number;
  finishedAt?: number;
}

interface AgentTimelineProps {
  activity: Record<string, ActivityEvent>;
  phase: Phase | undefined;
  files: SiteFile[];
  issues: ReviewIssue[];
  running: boolean;
  cancelling: boolean;
  onCancel: () => void;
  /** Build start (epoch ms), e.g. current.createdAt - keeps the elapsed
   *  clock honest across history loads. Falls back to first observed run. */
  startedAt?: number;
  /** Jump-to-Code handler. When absent, an OPEN_FILE_EVENT window event is
   *  dispatched instead (Workspace/integrator listens for it). */
  onOpenFile?: (path: string) => void;
}

export function AgentTimeline({
  activity,
  phase,
  files,
  issues,
  running,
  cancelling,
  onCancel,
  startedAt,
  onOpenFile,
}: AgentTimelineProps) {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [elapsedMs, setElapsedMs] = useState(0);
  const confirmTimer = useRef<number | undefined>(undefined);
  const feedRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const timingsRef = useRef(new Map<string, RoleTiming>());
  const attributionRef = useRef(new Map<string, string | null>());
  const startRef = useRef<number | undefined>(undefined);
  const frozenRef = useRef<number | undefined>(undefined);
  const prevPhaseRef = useRef<Phase | undefined>(undefined);

  useEffect(() => {
    if (!running) setConfirming(false);
  }, [running]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  /* Per-role work intervals, derived from activity events. The wire events
   * may carry startedAt/finishedAt; otherwise event arrival time is used. */
  useEffect(() => {
    const map = timingsRef.current;
    const entries = Object.entries(activity);
    if (entries.length === 0) {
      map.clear();
      return;
    }
    const now = Date.now();
    for (const [role, ev] of entries) {
      const wire = ev as ActivityEvent & RoleTiming;
      const rec = map.get(role) ?? {};
      if (ev.state === 'active') {
        if (rec.startedAt === undefined) rec.startedAt = wire.startedAt ?? now;
        rec.finishedAt = undefined; // re-activated (builder fix round): clock runs again
      } else if (ev.state === 'done' || ev.state === 'error') {
        if (rec.startedAt === undefined) rec.startedAt = wire.startedAt ?? now;
        rec.finishedAt = wire.finishedAt ?? rec.finishedAt ?? now;
      }
      map.set(role, rec);
    }
  }, [activity]);

  /* First-writer attribution per file. The activity map only resets when the
   * build changes, so an empty map invalidates old-build attributions. */
  useEffect(() => {
    const map = attributionRef.current;
    if (Object.keys(activity).length === 0 && map.size > 0) map.clear();
    const paths = new Set(files.map((f) => f.path));
    for (const key of [...map.keys()]) {
      if (!paths.has(key)) map.delete(key);
    }
    for (const f of files) {
      if (!map.has(f.path)) map.set(f.path, attributeFile(f.path, activity));
    }
  }, [files, activity]);

  /* Elapsed clock. The startedAt prop (build creation) wins; otherwise the
   * clock starts when a run is first observed and freezes at the terminal
   * phase. A running build that jumps back to INTAKE is a different build. */
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === undefined) {
      startRef.current = undefined;
      frozenRef.current = undefined;
      setElapsedMs(0);
      return undefined;
    }
    if (running) {
      if (phase === 'INTAKE' && prev !== 'INTAKE') {
        startRef.current = undefined;
        frozenRef.current = undefined;
      }
      const start = startedAt ?? startRef.current ?? Date.now();
      startRef.current = start;
      frozenRef.current = undefined;
      setElapsedMs(Date.now() - start);
      const t = window.setInterval(() => setElapsedMs(Date.now() - start), 1000);
      return () => window.clearInterval(t);
    }
    if (frozenRef.current === undefined && startRef.current !== undefined) {
      frozenRef.current = Date.now() - startRef.current;
    }
    if (frozenRef.current !== undefined) setElapsedMs(frozenRef.current);
    return undefined;
  }, [running, phase, startedAt]);

  useEffect(() => {
    const el = feedRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [files.length]);

  function onFeedScroll() {
    const el = feedRef.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }

  function clickCancel() {
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onCancel();
  }

  function toggleExpand(path: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function openInCode(path: string) {
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
    window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: { path } }));
  }

  const known = new Set<string>(ROLE_IDS);
  const extraRoles = Object.keys(activity)
    .filter((r) => !known.has(r.toLowerCase()))
    .sort();
  const showElapsed = running || elapsedMs > 0;

  function renderRole(role: string, label: string) {
    const { state, note } = roleDisplay(role, activity, phase);
    const timing = timingsRef.current.get(role);
    let duration: string | null = null;
    if (state === 'active' && timing?.startedAt !== undefined) {
      duration = formatClock(Date.now() - timing.startedAt);
    } else if (
      (state === 'done' || state === 'error') &&
      timing?.startedAt !== undefined &&
      timing.finishedAt !== undefined
    ) {
      duration = formatClock(timing.finishedAt - timing.startedAt);
    }
    return (
      <li key={role} className="role-item" style={state === 'skipped' ? { opacity: 0.55 } : undefined}>
        <div className={`role-row role--${state}`}>
          <span className="role-dot" aria-hidden="true" />
          <span className="role-name">{label}</span>
          <span
            className="role-duration"
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-2)',
            }}
          >
            {duration ?? ''}
          </span>
          <span className="role-state">{STATE_LABELS[state]}</span>
        </div>
        {state === 'active' && note !== undefined && (
          <div
            className="role-activity"
            title={note}
            style={{
              padding: '0 var(--sp-2) 4px 26px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              color: 'var(--text-1)',
            }}
          >
            {capFirst(note)}
            <span aria-hidden="true" style={{ animation: 'pulse 1.1s ease-in-out infinite' }}>
              ...
            </span>
          </div>
        )}
      </li>
    );
  }

  function renderFile(f: SiteFile) {
    // The persisted first-writer attribution wins; fall back to a live
    // computation so cards are attributed on the very first render too.
    const writer = attributionRef.current.get(f.path) ?? attributeFile(f.path, activity);
    const accent = writer !== null ? roleColor(writer) : null;
    const isOpen = expanded.has(f.path);
    const totalLines = f.content === undefined ? 0 : f.content.split('\n').length;
    return (
      <div
        className="ff-card"
        key={f.path}
        style={{
          border: '1px solid var(--border-0)',
          borderLeft: `2px solid ${accent ?? 'var(--border-1)'}`,
          borderRadius: 'var(--radius-s)',
          background: 'var(--bg-1)',
          marginBottom: 'var(--sp-1)',
          animation: 'ff-flash 900ms ease-out',
        }}
      >
        <div
          className="ff-card-head"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '3px var(--sp-2) 3px 4px' }}
        >
          <button
            type="button"
            className="ff-main"
            onClick={() => toggleExpand(f.path)}
            aria-expanded={isOpen}
            title={isOpen ? 'Collapse preview' : `Preview first ${PREVIEW_LINES} lines`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: '1 1 auto',
              minWidth: 0,
              padding: '2px 0',
              border: 'none',
              background: 'none',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 10 10"
              aria-hidden="true"
              className={`chev${isOpen ? ' open' : ''}`}
              style={{ flex: '0 0 auto', color: 'var(--text-2)' }}
            >
              <path d="M3 1.5 6.5 5 3 8.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
            </svg>
            <FileIcon path={f.path} />
            <span className="ff-path">{f.path}</span>
          </button>
          {writer !== null && (
            <span
              className="ff-role"
              title={`Written by ${writerLabel(writer)}`}
              style={{
                flex: '0 0 auto',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: accent ?? undefined,
              }}
            >
              {writerLabel(writer)}
            </span>
          )}
          {f.bytes !== undefined && (
            <span
              className="ff-add"
              title="Bytes written"
              style={{
                flex: '0 0 auto',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 99,
                background: 'rgba(63, 206, 139, 0.12)',
                color: 'var(--ok)',
              }}
            >
              +{formatBytes(f.bytes)}
            </span>
          )}
        </div>
        {isOpen && (
          <div className="ff-detail" style={{ borderTop: '1px solid var(--border-0)', padding: 'var(--sp-2)' }}>
            {f.content === undefined ? (
              <p className="muted" style={{ margin: 0, fontFamily: 'var(--font-sans)' }}>
                The stream only carried this file&apos;s metadata - content appears when the build finishes.
              </p>
            ) : (
              <pre
                className="ff-preview"
                style={{
                  margin: 0,
                  maxHeight: 252,
                  overflow: 'auto',
                  background: 'var(--bg-0)',
                  borderRadius: 'var(--radius-s)',
                  padding: 'var(--sp-1) 0',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}
                aria-label={`First ${PREVIEW_LINES} lines of ${f.path}`}
              >
                <code>
                  {highlightLines(f.content, langFor(f.path))
                    .slice(0, PREVIEW_LINES)
                    .map((line, i) => (
                      <span className="code-line" key={i}>
                        <span className="ln" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span className="lc">
                          {line.map((t, k) => (t.cls ? <span key={k} className={t.cls}>{t.text}</span> : t.text))}
                          {line.length === 0 ? ' ' : ''}
                        </span>
                      </span>
                    ))}
                </code>
              </pre>
            )}
            <div
              className="ff-detail-foot"
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}
            >
              <button type="button" className="btn btn--ghost btn--s" onClick={() => openInCode(f.path)}>
                Open in Code
              </button>
              {f.content !== undefined && totalLines > PREVIEW_LINES && (
                <span className="muted" style={{ fontSize: 11 }}>
                  showing first {PREVIEW_LINES} of {totalLines} lines
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="timeline" aria-label="Agent team">
      <div className="timeline-head">
        <button
          type="button"
          className="timeline-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="timeline-body"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={`chev${open ? ' open' : ''}`}
          >
            <path d="M3 1.5 6.5 5 3 8.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
          Agent team
        </button>
        {phase !== undefined && (
          <span className="tl-banner" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <span className={`phase-badge phase--${phase.toLowerCase()}`}>{phase}</span>
            {showElapsed && (
              <span
                className="tl-elapsed"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}
              >
                {formatClock(elapsedMs)}
              </span>
            )}
          </span>
        )}
        <span className="muted file-count" aria-live="polite">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        {running && (
          <button
            type="button"
            className={`btn btn--s ${confirming ? 'btn--danger' : 'btn--ghost'}`}
            onClick={clickCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling...' : confirming ? 'Confirm cancel' : 'Cancel build'}
          </button>
        )}
      </div>

      {open && (
        <div className="timeline-body" id="timeline-body">
          <ul className="roles">
            {ROLE_IDS.map((role) => renderRole(role, ROLE_LABELS[role]))}
            {extraRoles.map((role) => renderRole(role, role))}
          </ul>

          <div className="file-feed" ref={feedRef} onScroll={onFeedScroll} aria-label="Files written">
            {files.length === 0 ? (
              <p className="muted ff-empty">Files the team writes land here as they happen.</p>
            ) : (
              files.map(renderFile)
            )}
          </div>

          {issues.length > 0 && (
            <ul className="issues" aria-label="Review findings">
              {issues.map((issue, i) => {
                const file = issue.file;
                const linked = file !== undefined && files.some((f) => f.path === file);
                return (
                  <li key={`${issue.severity}-${i}`} className={`issue issue--${issue.severity}`}>
                    <span className="issue-badge" aria-hidden="true">
                      {issue.severity === 'error' ? 'x' : issue.severity === 'warn' ? '!' : 'i'}
                    </span>
                    <span
                      className={`issue-sev issue-sev--${issue.severity}`}
                      style={{
                        flex: '0 0 auto',
                        width: 36,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.07em',
                        textTransform: 'uppercase',
                        color: SEV_COLORS[issue.severity],
                      }}
                    >
                      {issue.severity}
                    </span>
                    <span className="issue-text" title={issue.text}>
                      {issue.text}
                    </span>
                    {file !== undefined &&
                      (linked ? (
                        <button
                          type="button"
                          className="chip issue-file"
                          title={`Open ${file} in the Code tab`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => openInCode(file)}
                        >
                          {file}
                        </button>
                      ) : (
                        <span className="chip" title={`${file} is not in the current file list`}>
                          {file}
                        </span>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
