import { useEffect, useRef, useState } from 'react';
import { putConfig } from '../api';
import type { ServerConfig } from '../types';
import { errorMessage } from '../format';

interface ProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
}

const PROVIDERS: ProviderPreset[] = [
  { id: 'kimi', label: 'Kimi (Moonshot)', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview', needsKey: true },
  { id: 'openai-compatible', label: 'OpenAI-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', endpoint: 'http://localhost:11434', model: 'llama3.1', needsKey: false },
  { id: 'mock', label: 'Mock (offline demo)', endpoint: '', model: 'mock-model', needsKey: false },
];

interface SetupCardProps {
  config: ServerConfig | null;
  loading: boolean;
  error: string | null;
  onSaved: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export function SetupCard({ config, loading, error, onSaved, onRetry, onDismiss }: SetupCardProps) {
  const [provider, setProvider] = useState('kimi');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!config) return;
    const known = PROVIDERS.some((p) => p.id === config.provider);
    if (known) setProvider(config.provider);
    setEndpoint(config.endpoint);
    setModel(config.model);
  }, [config]);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  const preset = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const keyRequired = preset.needsKey && !(config?.hasKey ?? false);
  const canSubmit =
    !saving &&
    (preset.id === 'mock' || (endpoint.trim().length > 0 && model.trim().length > 0)) &&
    (!keyRequired || apiKey.trim().length > 0);

  function pickProvider(id: string) {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    setProvider(id);
    setEndpoint(p.endpoint);
    setModel(p.model);
    setSaved(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: { provider: string; endpoint: string; model: string; apiKey?: string } = {
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await putConfig(body);
      setApiKey('');
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 4000);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setup-card" aria-label="Provider setup">
      <div className="setup-head">
        <h2>Connect a model</h2>
        <button type="button" className="icon-btn" onClick={onDismiss} aria-label="Hide setup" title="Hide setup">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {loading && <p className="muted">Loading configuration…</p>}
      {!loading && error && (
        <div className="inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--s" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {!loading && (
        <form className="setup-form" onSubmit={submit}>
          <label className="field">
            <span className="label">Provider</span>
            <select className="input" value={provider} onChange={(e) => pickProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
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
              placeholder={preset.id === 'mock' ? 'not required for mock' : 'https://…'}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              disabled={preset.id === 'mock'}
            />
          </label>

          <label className="field">
            <span className="label">Model</span>
            <input
              className="input"
              type="text"
              spellCheck={false}
              placeholder={preset.id === 'mock' ? 'not required for mock' : 'model name'}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={preset.id === 'mock'}
            />
          </label>

          <label className="field">
            <span className="label">API key</span>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={
                !preset.needsKey
                  ? 'not required'
                  : config?.hasKey
                    ? 'stored — leave blank to keep'
                    : 'required'
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={!preset.needsKey}
            />
          </label>

          {saveError && (
            <p className="inline-error" role="alert">
              {saveError}
            </p>
          )}

          <div className="setup-actions">
            <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
              {saving ? 'Saving…' : 'Save configuration'}
            </button>
            {saved && (
              <span className="saved-indicator" role="status">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2 6.5 5 9.5 10 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
                </svg>
                Saved
              </span>
            )}
            {config?.hasKey && !saved && <span className="muted">API key stored</span>}
          </div>
        </form>
      )}
    </section>
  );
}
