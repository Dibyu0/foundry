import { useEffect, useState } from 'react';
import type { Plan, PlanStep } from '../types';
import { baseName } from '../format';

interface PlanViewProps {
  plan: Plan;
  editable: boolean;
  busy: boolean;
  onApprove: (plan: Plan) => void;
}

function clonePlan(plan: Plan): Plan {
  return {
    summary: plan.summary,
    designDirection: plan.designDirection,
    steps: plan.steps.map((s) => ({ title: s.title, files: [...s.files], done: s.done })),
  };
}

export function PlanView({ plan, editable, busy, onApprove }: PlanViewProps) {
  const [draft, setDraft] = useState<Plan>(() => clonePlan(plan));

  useEffect(() => {
    setDraft(clonePlan(plan));
  }, [plan]);

  function updateStep(index: number, patch: Partial<PlanStep>) {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  }

  function removeStep(index: number) {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
  }

  return (
    <section className="plan-view" aria-label="Build plan">
      <div className="q-kicker">Proposed plan</div>
      <p className="plan-summary">{draft.summary}</p>
      {draft.designDirection && <p className="plan-design">{draft.designDirection}</p>}

      <ol className="plan-steps">
        {draft.steps.map((step, i) => (
          <li key={i} className={`plan-step${step.done ? ' is-done' : ''}`}>
            {editable ? (
              <>
                <input
                  type="checkbox"
                  className="step-check"
                  checked={step.done}
                  onChange={(e) => updateStep(i, { done: e.target.checked })}
                  aria-label={`Mark step ${i + 1} done`}
                />
                <div className="step-body">
                  <input
                    type="text"
                    className="step-title-input"
                    value={step.title}
                    onChange={(e) => updateStep(i, { title: e.target.value })}
                    aria-label={`Step ${i + 1} title`}
                  />
                  {step.files.length > 0 && (
                    <span className="step-files">
                      {step.files.map((f) => (
                        <span key={f} className="chip" title={f}>
                          {baseName(f)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="icon-btn step-remove"
                  onClick={() => removeStep(i)}
                  aria-label={`Remove step ${i + 1}`}
                  title="Remove step"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                <span className={`step-static-check${step.done ? ' on' : ''}`} aria-hidden="true">
                  {step.done ? '✓' : ''}
                </span>
                <div className="step-body">
                  <span className="step-title">{step.title}</span>
                  {step.files.length > 0 && (
                    <span className="step-files">
                      {step.files.map((f) => (
                        <span key={f} className="chip" title={f}>
                          {baseName(f)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
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
            disabled={busy || draft.steps.length === 0}
            onClick={() => onApprove(draft)}
          >
            {busy ? 'Approving…' : 'Approve plan & build'}
          </button>
          <span className="muted">Edit steps above, or approve as-is.</span>
        </div>
      )}
    </section>
  );
}
