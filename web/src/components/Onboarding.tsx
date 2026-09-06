import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { putConfig } from '../api';
import type { ServerConfig } from '../types';
import { errorMessage } from '../format';
import { Logo } from './Logo';

export const ONBOARDED_KEY = 'foundry.onboarded';

export function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    // storage can be unavailable (private mode); the tour simply reappears
  }
}

/** First-run rule: nothing built yet and the server is still on the offline mock. */
export function shouldShowOnboarding(buildCount: number, provider: string | null | undefined): boolean {
  return buildCount === 0 && provider === 'mock';
}

interface ProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
}

const PRESETS: ProviderPreset[] = [
  { id: 'kimi', label: 'Kimi (Moonshot)', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview', needsKey: true },
  { id: 'openai-compatible', label: 'OpenAI-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', endpoint: 'http://localhost:11434', model: 'llama3.1', needsKey: false },
];

const STEPS = [
  {
    kicker: 'Step 1 of 3',
    title: 'Describe your site',
    body: 'Tell Foundry what you want in plain words - the audience, the sections, the mood. Or start from a recipe above the composer and edit it into your own brief.',
  },
  {
    kicker: 'Step 2 of 3',
    title: 'Answer its questions',
    body: 'The planner asks a few sharp questions before anything is written, then shows a step-by-step plan. Edit the steps or approve them as they are - nothing builds until you say so.',
  },
  {
    kicker: 'Step 3 of 3',
    title: 'Watch the team build it',
    body: 'Planner, designer, copywriter, builder and reviewer work the plan live. Files stream in as they are written, the reviewer flags issues, and the preview updates when the build finishes.',
  },
] as const;

interface OnboardingProps {
  config: ServerConfig | null;
  /** reload server config after a provider is saved */
  onConfigSaved: () => void;
  /** called after the onboarded flag is persisted; parent should unmount the dialog */
  onDone: () => void;
}

export function Onboarding({ config, onConfigSaved, onDone }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [presetId, setPresetId] = useState('kimi');
  const [endpoint, setEndpoint] = useState(PRESETS[0].endpoint);
  const [model, setModel] = useState(PRESETS[0].model);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      markOnboarded();
      onDone();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const keyRequired = preset.needsKey && !(config?.hasKey ?? false);
  const canSave =
    !saving &&
    endpoint.trim().length > 0 &&
    model.trim().length > 0 &&
    (!keyRequired || apiKey.trim().length > 0);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  function finish() {
    markOnboarded();
    onDone();
  }

  function pickPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setEndpoint(p.endpoint);
    setModel(p.model);
    setSaveError(null);
    setProviderSaved(false);
  }

  async function saveProvider(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: { provider: string; endpoint: string; model: string; apiKey?: string } = {
        provider: preset.id,
        endpoint: endpoint.trim(),
        model: model.trim(),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await putConfig(body);
      setApiKey('');
      setProviderSaved(true);
      onConfigSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="onboarding">
      <div
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-title"
        ref={cardRef}
        tabIndex={-1}
      >
        <div className="ob-brand">
          <Logo size={20} />
          <span className="ob-brand-name">Foundry</span>
        </div>

        <div className="ob-dots">
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className={`ob-dot${i === step ? ' is-active' : ''}`}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <p className="ob-kicker">{current.kicker}</p>
        <h2 className="ob-title" id="ob-title">
          {current.title}
        </h2>
        <p className="ob-body">{current.body}</p>

        {step === 0 && (
          <div className="ob-sample">
            <span className="ob-sample-label">Example brief</span>
            <p className="ob-sample-brief">
              "A landing page for a small coffee roastery with a menu, a story section, and a
              contact form. Warm, craft feel, dark theme."
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="ob-sample">
            <span className="ob-sample-label">Planner asks</span>
            <p className="ob-sample-q">Who is this site mainly for?</p>
            <div className="ob-sample-opts">
              <span className="ob-sample-opt">Local customers</span>
              <span className="ob-sample-opt">Online buyers</span>
              <span className="ob-sample-opt">Something else</span>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="ob-mock" aria-hidden="true">
            <div className="ob-mock-chrome">
              <i />
              <i />
              <i />
            </div>
            <div className="ob-mock-body">
              <div className="ob-block ob-block--nav" style={{ animationDelay: '0ms' }} />
              <div className="ob-block ob-block--hero" style={{ animationDelay: '260ms' }} />
              <div className="ob-mock-cols">
                <div className="ob-block" style={{ animationDelay: '520ms' }} />
                <div className="ob-block" style={{ animationDelay: '650ms' }} />
                <div className="ob-block" style={{ animationDelay: '780ms' }} />
              </div>
              <div className="ob-block ob-block--cta" style={{ animationDelay: '960ms' }} />
            </div>
          </div>
        )}

        {last && (
          <form className="ob-provider" onSubmit={saveProvider}>
            <p className="ob-provider-title">Connect a model for real builds</p>
            <p className="ob-provider-note muted">
              You are on the offline mock, which demos the flow without generating real sites. Pick
              a provider to go live, or keep the mock for now.
            </p>

            {providerSaved ? (
              <span className="saved-indicator" role="status">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2 6.5 5 9.5 10 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
                </svg>
                Connected - you are ready to build
              </span>
            ) : (
              <>
                <div className="ob-provider-grid">
                  <label className="field">
                    <span className="label">Provider</span>
                    <select className="input" value={presetId} onChange={(e) => pickPreset(e.target.value)}>
                      {PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="ob-provider-row">
                    <label className="field">
                      <span className="label">Endpoint</span>
                      <input
                        className="input"
                        type="text"
                        inputMode="url"
                        spellCheck={false}
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span className="label">Model</span>
                      <input
                        className="input"
                        type="text"
                        spellCheck={false}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                      />
                    </label>
                  </div>
                  {preset.needsKey && (
                    <label className="field">
                      <span className="label">API key</span>
                      <input
                        className="input"
                        type="password"
                        autoComplete="off"
                        placeholder={config?.hasKey ? 'stored - leave blank to keep' : 'required'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                    </label>
                  )}
                </div>
                {saveError && (
                  <p className="inline-error" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="ob-provider-actions">
                  <button type="submit" className="btn btn--s" disabled={!canSave}>
                    {saving ? 'Saving...' : 'Save and connect'}
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        <div className="ob-actions">
          <button type="button" className="btn btn--ghost ob-skip" onClick={finish}>
            Skip tour
          </button>
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {!last && (
            <button type="button" className="btn btn--primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
          {last && (
            <button type="button" className="btn btn--primary" onClick={finish}>
              Start building
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
