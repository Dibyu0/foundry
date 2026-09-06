import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Plan, PlanStep } from '../types';
import { baseName } from '../format';

interface PlanViewProps {
  plan: Plan;
  editable: boolean;
  busy: boolean;
  onApprove: (plan: Plan) => void;
}

export function clonePlan(plan: Plan): Plan {
  return {
    summary: plan.summary,
    designDirection: plan.designDirection,
    steps: plan.steps.map((s) => ({ title: s.title, files: [...s.files], done: s.done })),
  };
}

export function countPlanFiles(plan: Plan): number {
  const files = new Set<string>();
  for (const step of plan.steps) for (const f of step.files) files.add(f);
  return files.size;
}

export function approveButtonLabel(plan: Plan, busy: boolean): string {
  if (busy) return 'Approving…';
  const steps = plan.steps.length;
  const files = countPlanFiles(plan);
  return `Approve — ${steps} ${steps === 1 ? 'step' : 'steps'}, ${files} ${files === 1 ? 'file' : 'files'}`;
}

export interface PlanHistory {
  past: Plan[];
  present: Plan;
  future: Plan[];
}

export function planHistoryInit(plan: Plan): PlanHistory {
  return { past: [], present: clonePlan(plan), future: [] };
}

export function planHistoryCommit(h: PlanHistory, next: Plan): PlanHistory {
  return { past: [...h.past, h.present], present: next, future: [] };
}

export function planHistoryUndo(h: PlanHistory): PlanHistory {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function planHistoryRedo(h: PlanHistory): PlanHistory {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

// New visual elements below carry classNames for the stylesheet plus inline
// fallback styles so they render correctly before those classes are styled.
const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 'var(--sp-2)',
};

const TOOLBAR_STYLE: CSSProperties = { display: 'flex', gap: 'var(--sp-1)' };

const STEP_TITLE_STYLE: CSSProperties = {
  width: '100%',
  padding: '1px var(--sp-1)',
  border: 'none',
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'text',
};

const EDITOR_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  padding: '6px 8px',
  border: '1px solid var(--border-1)',
  borderRadius: 'var(--radius-s)',
  background: 'var(--bg-0)',
  color: 'var(--text-0)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.45,
};

const EDITOR_ACTIONS_STYLE: CSSProperties = { display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-1)' };

const DESIGN_LABEL_STYLE: CSSProperties = {
  display: 'block',
  marginBottom: 2,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
};

const COLLAPSE_TOGGLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  width: '100%',
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--text-0)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
};

export function PlanView({ plan, editable, busy, onApprove }: PlanViewProps) {
  const [history, setHistory] = useState<PlanHistory>(() => planHistoryInit(plan));
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const draft = history.present;
  const stepCount = draft.steps.length;
  const doneCount = draft.steps.filter((s) => s.done).length;

  useEffect(() => {
    setHistory(planHistoryInit(plan));
    setEditing(null);
  }, [plan]);

  useEffect(() => {
    if (editing === null) return;
    const el = editorRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  function startEdit(index: number) {
    if (busy) return;
    setEditing(index);
    setEditText(draft.steps[index].title);
  }

  function cancelEdit() {
    setEditing(null);
    setEditText('');
  }

  function saveEdit() {
    if (editing === null) return;
    const index = editing;
    const title = editText.trim();
    setEditing(null);
    setEditText('');
    if (!title) return;
    setHistory((h) => {
      const step = h.present.steps[index];
      if (!step || step.title === title) return h;
      return planHistoryCommit(h, {
        ...h.present,
        steps: h.present.steps.map((s, i) => (i === index ? { ...s, title } : s)),
      });
    });
  }

  function removeStep(index: number) {
    setEditing(null);
    setHistory((h) =>
      planHistoryCommit(h, { ...h.present, steps: h.present.steps.filter((_, i) => i !== index) }),
    );
  }

  function undo() {
    setEditing(null);
    setHistory(planHistoryUndo);
  }

  function redo() {
    setEditing(null);
    setHistory(planHistoryRedo);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (!editable || !(e.ctrlKey || e.metaKey)) return;
    // Inside text fields the native text undo keeps precedence over plan history.
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      redo();
    }
  }

  function handleEditorKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveEdit();
    }
  }

  function fileChips(step: PlanStep) {
    if (step.files.length === 0) return null;
    return (
      <span className="step-files">
        {step.files.map((f) => (
          <span key={f} className="chip" title={f}>
            {baseName(f)}
          </span>
        ))}
      </span>
    );
  }

  if (!editable && !expanded) {
    return (
      <section className="plan-view plan-view--collapsed" aria-label="Build plan">
        <button
          type="button"
          className="plan-collapse-toggle"
          style={COLLAPSE_TOGGLE_STYLE}
          onClick={() => setExpanded(true)}
          aria-expanded={false}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3.5 1.5L7 5l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            Plan ({stepCount} {stepCount === 1 ? 'step' : 'steps'})
          </span>
          {doneCount > 0 && (
            <span className="muted" style={{ marginLeft: 'auto', fontWeight: 400 }}>
              {doneCount}/{stepCount} done
            </span>
          )}
        </button>
      </section>
    );
  }

  return (
    <section className="plan-view" aria-label="Build plan" tabIndex={-1} style={{ outline: 'none' }} onKeyDown={handleKeyDown}>
      <div className="plan-head" style={HEAD_STYLE}>
        <div className="q-kicker" style={{ marginBottom: 0 }}>
          {editable ? 'Proposed plan' : 'Plan'}
        </div>
        {editable ? (
          <div className="plan-toolbar" style={TOOLBAR_STYLE} role="group" aria-label="Plan edit history">
            <button
              type="button"
              className="icon-btn"
              onClick={undo}
              disabled={busy || history.past.length === 0}
              aria-label="Undo plan edit"
              title="Undo (Ctrl+Z)"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4.5 2L1.5 5l3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M1.5 5h5a3.25 3.25 0 0 1 0 6.5H5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={redo}
              disabled={busy || history.future.length === 0}
              aria-label="Redo plan edit"
              title="Redo (Ctrl+Shift+Z)"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M7.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10.5 5h-5a3.25 3.25 0 0 0 0 6.5H7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setExpanded(false)}
            aria-label="Collapse plan"
            title="Collapse plan"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 3.5L5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      <p className="plan-summary">{draft.summary}</p>
      {draft.designDirection && (
        <div className="plan-design plan-design-card">
          <span className="plan-design-label" style={DESIGN_LABEL_STYLE}>
            Design direction
          </span>
          <p className="plan-design-text" style={{ margin: 0 }}>
            {draft.designDirection}
          </p>
        </div>
      )}

      <ol className="plan-steps">
        {draft.steps.map((step, i) => (
          <li key={i} className={`plan-step${step.done ? ' is-done' : ''}`}>
            <span
              className={`step-static-check${step.done && !editable ? ' on' : ''}`}
              style={step.done && !editable ? undefined : { color: 'var(--text-2)' }}
              aria-hidden="true"
            >
              {step.done && !editable ? '✓' : i + 1}
            </span>
            {editable && editing === i ? (
              <div className="step-body">
                <textarea
                  ref={editorRef}
                  className="step-editor"
                  style={EDITOR_STYLE}
                  value={editText}
                  rows={Math.min(8, Math.max(2, editText.split('\n').length))}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  aria-label={`Step ${i + 1} text`}
                  disabled={busy}
                />
                <div className="step-editor-actions" style={EDITOR_ACTIONS_STYLE}>
                  <button
                    type="button"
                    className="btn btn--primary btn--s"
                    onClick={saveEdit}
                    disabled={busy || !editText.trim()}
                  >
                    Save
                  </button>
                  <button type="button" className="btn btn--ghost btn--s" onClick={cancelEdit} disabled={busy}>
                    Cancel
                  </button>
                </div>
                {fileChips(step)}
              </div>
            ) : (
              <>
                <div className="step-body">
                  {editable ? (
                    <button
                      type="button"
                      className="step-title step-title-btn"
                      style={STEP_TITLE_STYLE}
                      onClick={() => startEdit(i)}
                      disabled={busy}
                      title="Click to edit step"
                    >
                      {step.title}
                    </button>
                  ) : (
                    <span className="step-title">{step.title}</span>
                  )}
                  {fileChips(step)}
                </div>
                {editable && (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => startEdit(i)}
                      disabled={busy}
                      aria-label={`Edit step ${i + 1}`}
                      title="Edit step"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path
                          d="M1.8 8.2l.4-1.7L6.9 1.8a.8.8 0 0 1 1.1 0l.2.2a.8.8 0 0 1 0 1.1L3.5 7.8l-1.7.4z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.1"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="icon-btn step-remove"
                      onClick={() => removeStep(i)}
                      disabled={busy}
                      aria-label={`Remove step ${i + 1}`}
                      title="Remove step"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    </button>
                  </>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      {editable && (
        <div className="plan-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || stepCount === 0}
            onClick={() => onApprove(draft)}
          >
            {approveButtonLabel(draft, busy)}
          </button>
          <span className="muted">Click a step to edit it. Ctrl+Z / Ctrl+Shift+Z to undo and redo.</span>
        </div>
      )}
    </section>
  );
}
