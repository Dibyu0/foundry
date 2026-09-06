import { useEffect, useRef, useState } from 'react';
import type { BuildState } from '../types';
import { isRunning } from '../types';
import { downloadUrl, previewUrl } from '../api';
import { CodeViewer } from './CodeViewer';
import { Logo } from './Logo';

type Tab = 'preview' | 'code';
type Device = 'mobile' | 'tablet' | 'desktop';

const DEVICES: { id: Device; label: string; hint: string }[] = [
  { id: 'mobile', label: '390', hint: 'Mobile — 390px' },
  { id: 'tablet', label: '768', hint: 'Tablet — 768px' },
  { id: 'desktop', label: '100%', hint: 'Desktop — full width' },
];

interface WorkspaceProps {
  build: BuildState | null;
  loading: boolean;
  onNewBuild: () => void;
}

export function Workspace({ build, loading, onNewBuild }: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>('preview');
  const [device, setDevice] = useState<Device>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const buildId = build?.id;

  useEffect(() => {
    setFrameLoaded(false);
  }, [buildId]);

  function onTabKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next: Tab = tab === 'preview' ? 'code' : 'preview';
    setTab(next);
    (next === 'preview' ? previewTabRef : codeTabRef).current?.focus();
  }

  if (loading) {
    return (
      <div className="workspace">
        <div className="empty-state">
          <p>Loading build…</p>
        </div>
      </div>
    );
  }

  if (!build) {
    return (
      <div className="workspace">
        <div className="empty-state empty-hero">
          <Logo size={44} />
          <h2>Forge a website from a sentence</h2>
          <p>
            Describe the site you want in the composer. The team will ask a few questions, show you a plan,
            then build a real site you can preview, inspect and download.
          </p>
        </div>
      </div>
    );
  }

  const running = isRunning(build.phase);
  const url = previewUrl(build.id, build.siteUrl);
  const canPreview = build.files.length > 0 || build.siteUrl !== undefined;

  return (
    <div className="workspace">
      <div className="workspace-bar">
        <div className="tabs" role="tablist" aria-label="Result workspace" onKeyDown={onTabKeyDown}>
          <button
            type="button"
            role="tab"
            id="tab-preview"
            aria-selected={tab === 'preview'}
            aria-controls="panel-preview"
            tabIndex={tab === 'preview' ? 0 : -1}
            ref={previewTabRef}
            className="tab"
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            id="tab-code"
            aria-selected={tab === 'code'}
            aria-controls="panel-code"
            tabIndex={tab === 'code' ? 0 : -1}
            ref={codeTabRef}
            className="tab"
            onClick={() => setTab('code')}
          >
            Code
            {build.files.length > 0 && <span className="tab-count">{build.files.length}</span>}
          </button>
        </div>

        <div className="workspace-actions">
          <a
            className={`btn btn--primary btn--s${build.files.length === 0 ? ' is-disabled' : ''}`}
            href={build.files.length === 0 ? undefined : downloadUrl(build.id)}
            aria-disabled={build.files.length === 0}
            onClick={build.files.length === 0 ? (e) => e.preventDefault() : undefined}
          >
            Download .zip
          </a>
          <button type="button" className="btn btn--ghost btn--s" onClick={onNewBuild}>
            New build
          </button>
        </div>
      </div>

      <div
        role="tabpanel"
        id="panel-preview"
        aria-labelledby="tab-preview"
        hidden={tab !== 'preview'}
        className="tabpanel"
      >
        <div className="preview-toolbar">
          <div className="seg" role="group" aria-label="Preview width">
            {DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                className="seg-btn"
                aria-pressed={device === d.id}
                title={d.hint}
                onClick={() => setDevice(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Reload preview"
            aria-label="Reload preview"
            disabled={!canPreview}
            onClick={() => {
              setFrameLoaded(false);
              setReloadKey((k) => k + 1);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
              <path
                d="M11 6.5a4.5 4.5 0 1 1-1.3-3.2M11 1v2.6H8.4"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <a
            className="icon-btn"
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open preview in a new tab"
            aria-label="Open preview in a new tab"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
              <path
                d="M5 2H2.5v9H11V8M7.5 2H11v3.5M11 2 6 7"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </a>
          <span className="muted preview-url" title={url}>
            {url}
          </span>
        </div>

        {canPreview ? (
          <div className={`preview-stage w--${device}`}>
            {!frameLoaded && <div className="preview-loading muted">Loading preview…</div>}
            <iframe
              key={`${build.id}-${reloadKey}`}
              className="preview-frame"
              title="Built site preview"
              /* opaque origin: the generated site runs scripts but cannot
                 reach the Foundry API or app origin */
              sandbox="allow-scripts"
              src={`${url}${url.includes('?') ? '&' : '?'}r=${reloadKey}`}
              onLoad={() => setFrameLoaded(true)}
            />
          </div>
        ) : (
          <div className="empty-state">
            <p>
              {running
                ? 'The preview appears as soon as the team writes the first files.'
                : 'This build produced no files to preview.'}
            </p>
          </div>
        )}
      </div>

      <div
        role="tabpanel"
        id="panel-code"
        aria-labelledby="tab-code"
        hidden={tab !== 'code'}
        className="tabpanel"
      >
        <CodeViewer files={build.files} running={running} />
      </div>
    </div>
  );
}
