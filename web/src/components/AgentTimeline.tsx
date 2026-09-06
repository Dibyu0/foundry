import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, Phase, ReviewIssue, RoleId, RoleState, SiteFile } from '../types';
import { ROLE_IDS, ROLE_LABELS, asRoleId } from '../types';
import { formatBytes } from '../format';

const ROLE_PHASE: Record<RoleId, Phase> = {
  planner: 'INTAKE',
  design: 'BUILDING',
  copy: 'BUILDING',
  builder: 'BUILDING',
  reviewer: 'REVIEW',
};

const PHASE_ORDER: readonly Phase[] = ['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW', 'DONE'];

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

const STATE_LABELS: Record<RoleState, string> = {
  idle: 'idle',
  active: 'working',
  done: 'done',
  error: 'error',
};

interface AgentTimelineProps {
  activity: Record<string, ActivityEvent>;
  phase: Phase | undefined;
  files: SiteFile[];
  issues: ReviewIssue[];
  running: boolean;
  cancelling: boolean;
  onCancel: () => void;
}

export function AgentTimeline({ activity, phase, files, issues, running, cancelling, onCancel }: AgentTimelineProps) {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);
  const feedRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  useEffect(() => {
    if (!running) setConfirming(false);
  }, [running]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

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

  const known = new Set<string>(ROLE_IDS);
  const extraRoles = Object.keys(activity)
    .filter((r) => !known.has(r.toLowerCase()))
    .sort();

  function rowState(role: string): { state: RoleState; note?: string } {
    const ev = activity[role];
    if (ev) return ev;
    const id = asRoleId(role);
    return { state: id ? phaseHint(phase, id) : 'idle' };
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
            {cancelling ? 'Cancelling…' : confirming ? 'Confirm cancel' : 'Cancel build'}
          </button>
        )}
      </div>

      {open && (
        <div className="timeline-body" id="timeline-body">
          <ul className="roles">
            {ROLE_IDS.map((role) => {
              const { state, note } = rowState(role);
              return (
                <li key={role} className={`role-row role--${state}`}>
                  <span className="role-dot" aria-hidden="true" />
                  <span className="role-name">{ROLE_LABELS[role]}</span>
                  <span className="role-note" title={note}>
                    {note ?? ''}
                  </span>
                  <span className="role-state">{STATE_LABELS[state]}</span>
                </li>
              );
            })}
            {extraRoles.map((role) => {
              const { state, note } = rowState(role);
              return (
                <li key={role} className={`role-row role--${state}`}>
                  <span className="role-dot" aria-hidden="true" />
                  <span className="role-name">{role}</span>
                  <span className="role-note" title={note}>
                    {note ?? ''}
                  </span>
                  <span className="role-state">{STATE_LABELS[state]}</span>
                </li>
              );
            })}
          </ul>

          <div className="file-feed" ref={feedRef} onScroll={onFeedScroll} aria-label="Files written">
            {files.length === 0 ? (
              <p className="muted ff-empty">Files the team writes land here as they happen.</p>
            ) : (
              files.map((f) => (
                <div className="ff-row" key={f.path}>
                  <span className="ff-path" title={f.path}>
                    {f.path}
                  </span>
                  <span className="ff-bytes">{formatBytes(f.bytes)}</span>
                </div>
              ))
            )}
          </div>

          {issues.length > 0 && (
            <ul className="issues" aria-label="Review findings">
              {issues.map((issue, i) => (
                <li key={`${issue.severity}-${i}`} className={`issue issue--${issue.severity}`}>
                  <span className="issue-badge" aria-hidden="true">
                    {issue.severity === 'error' ? '✕' : issue.severity === 'warn' ? '!' : 'i'}
                  </span>
                  <span className="issue-text">{issue.text}</span>
                  {issue.file && (
                    <span className="chip" title={issue.file}>
                      {issue.file}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
