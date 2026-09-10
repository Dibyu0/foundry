import { useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
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
    // storage can be unavailable (private mode); the card simply reappears
  }
}

/** Show the setup card while the server is on the offline mock provider.
 *  buildCount no longer gates the card; it is kept for call-site compatibility. */
export function shouldShowOnboarding(_buildCount: number, provider: string | null | undefined): boolean {
  return provider === 'mock';
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

interface OnboardingProps {
  config: ServerConfig | null;
  /** reload server config after a provider is saved */
  onConfigSaved: () => void;
  /** called after the onboarded flag is persisted; parent should unmount the card */
  onDone: () => void;
}

/** Compact provider-setup card for the home hero flow. Inline, dismissible,
 *  never a modal: render it below the hero while provider === 'mock'. */
export function Onboarding({ config, onConfigSaved, onDone }: OnboardingProps) {
  const [presetId, setPresetId] = useState('kimi');
  const [endpoint, setEndpoint] = useState(PRESETS[0].endpoint);
  const [model, setModel] = useState(PRESETS[0].model);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState(false);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const keyRequired = preset.needsKey && !(config?.hasKey ?? false);
  const canSave =
    !saving &&
    endpoint.trim().length > 0 &&
    model.trim().length > 0 &&
    (!keyRequired || apiKey.trim().length > 0);

  function dismiss() {
    markOnboarded();
    onDone();
  }

  function onCardKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dismiss();
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
    <section className="onboard-card" aria-labelledby="onboard-title" onKeyDown={onCardKeyDown}>
      <div className="onboard-card-icon" aria-hidden="true">
        <Logo size={18} />
      </div>

      <div className="onboard-card-body">
        <p className="onboard-kicker">Offline demo mode</p>
        <h2 className="onboard-title" id="onboard-title">
          Connect a model to build for real
        </h2>
        <p className="onboard-note muted">
          Foundry is running on the mock provider: it demos the flow - describe the site, answer a few
          questions, watch the team build - but generates no real sites. Pick a provider to go live, or
          keep exploring the demo.
        </p>

        {providerSaved ? (
          <div className="onboard-success">
            <span className="saved-indicator" role="status">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 6.5 5 9.5 10 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              </svg>
              Connected - you are ready to build
            </span>
            <button type="button" className="btn btn--primary btn--s" onClick={dismiss}>
              Start building
            </button>
          </div>
        ) : (
          <form className="onboard-form" onSubmit={saveProvider}>
            <div className="onboard-form-grid">
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
            <div className="onboard-actions">
              <button type="submit" className="btn btn--primary btn--s" disabled={!canSave}>
                {saving ? 'Saving...' : 'Save and connect'}
              </button>
              <button type="button" className="btn btn--ghost btn--s" onClick={dismiss}>
                Keep the demo
              </button>
            </div>
          </form>
        )}
      </div>

      <button
        type="button"
        className="onboard-dismiss icon-btn"
        onClick={dismiss}
        aria-label="Dismiss provider setup"
        title="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </section>
  );
}
