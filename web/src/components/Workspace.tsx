import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { BuildState, Phase } from '../types';
import { isRunning } from '../types';
import { downloadUrl, previewUrl } from '../api';
import { formatBytes } from '../format';
import { CodeViewer } from './CodeViewer';
import { ConsoleTab } from './ConsoleTab';
import type { ConsoleCounts } from './ConsoleTab';
import { InspectToggle, VisualEditorPanel, useInspectMode } from './VisualEditorPanel';
import { Logo } from './Logo';

type Tab = 'preview' | 'code' | 'console';
type Device = 'mobile' | 'tablet' | 'desktop';

const TAB_ICONS: Record<Tab, ReactElement> = {
  preview: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="tab-icon">
      <rect x="1.5" y="2" width="10" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M1.5 4.4h10" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  ),
  code: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="tab-icon">
      <path
        d="M4.4 4.1 1.9 6.5l2.5 2.4M8.6 4.1l2.5 2.4-2.5 2.4"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  console: (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="tab-icon">
      <rect x="1.5" y="2" width="10" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path
        d="M3.6 4.9 5.4 6.5 3.6 8.1M6.3 8.3h2.6"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

const DEVICES: { id: Device; hint: string; icon: ReactElement }[] = [
  {
    id: 'mobile',
    hint: 'Mobile - 390px',
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <rect x="3.75" y="1.5" width="5.5" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
        <path d="M5.75 9.9h1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'tablet',
    hint: 'Tablet - 768px',
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <rect x="2.25" y="1.75" width="8.5" height="9.5" rx="1.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
        <path d="M5.75 9.6h1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'desktop',
    hint: 'Desktop - full width',
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <rect x="1.5" y="2" width="10" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
        <path d="M5 11h3M6.5 9v2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    ),
  },
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
  const [cardDismissed, setCardDismissed] = useState(false);
  const [consoleCounts, setConsoleCounts] = useState<ConsoleCounts>({ total: 0, errors: 0, warnings: 0 });
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const consoleTabRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const doneOpenRef = useRef<HTMLButtonElement>(null);
  const inspect = useInspectMode(iframeRef);
  const buildId = build?.id;
  const phase = build?.phase;
  const prevPhaseRef = useRef<Phase | undefined>(phase);
  const canPreview = build !== null && (build.files.length > 0 || build.siteUrl !== undefined);
  const doneCardVisible = phase === 'DONE' && !cardDismissed && canPreview;

  useEffect(() => {
    setFrameLoaded(false);
    setCardDismissed(false);
  }, [buildId]);

  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === 'DONE' && prev !== 'DONE') {
      setTab('preview');
      previewTabRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (!doneCardVisible) return;
    doneOpenRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCardDismissed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doneCardVisible]);

  function onTabKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const order: Tab[] = ['preview', 'code', 'console'];
    const i = order.indexOf(tab);
    const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
    setTab(next);
    (next === 'preview' ? previewTabRef : next === 'code' ? codeTabRef : consoleTabRef).current?.focus();
  }

  if (loading) {
    return (
      <div className="workspace">
        <div className="empty-state">
          <span className="empty-spinner" aria-hidden="true" />
          <p>Loading build...</p>
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
  const totalBytes = build.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  const consoleAlerts = consoleCounts.errors + consoleCounts.warnings;

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
            {TAB_ICONS.preview}
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
            {TAB_ICONS.code}
            Code
            {build.files.length > 0 && <span className="tab-count">{build.files.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            id="tab-console"
            aria-selected={tab === 'console'}
            aria-controls="panel-console"
            tabIndex={tab === 'console' ? 0 : -1}
            ref={consoleTabRef}
            className="tab"
            onClick={() => setTab('console')}
          >
            {TAB_ICONS.console}
            Console
            {consoleAlerts > 0 && (
              <span
                className={`tab-count ${consoleCounts.errors > 0 ? 'tab-count--err' : 'tab-count--warn'}`}
                aria-label={`${consoleAlerts} console errors or warnings`}
              >
                {consoleAlerts}
              </span>
            )}
          </button>
        </div>

        <div className="workspace-actions">
          <a
            className={`btn btn--primary btn--s${build.files.length === 0 ? ' is-disabled' : ''}`}
            href={build.files.length === 0 ? undefined : downloadUrl(build.id)}
            aria-disabled={build.files.length === 0}
            onClick={build.files.length === 0 ? (e) => e.preventDefault() : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="btn-icon">
              <path
                d="M6 1.5v6M3.6 5.3 6 7.7l2.4-2.4M2 9.6v0.9h8v-0.9"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
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
        {canPreview ? (
          <div className={`preview-stage w--${device}`}>
            {!frameLoaded && <div className="preview-loading muted">Loading preview...</div>}
            <div className="preview-browser">
              <div className="preview-chrome">
                <span className="chrome-dots" aria-hidden="true">
                  <span className="chrome-dot" />
                  <span className="chrome-dot" />
                  <span className="chrome-dot" />
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title="Reload preview"
                  aria-label="Reload preview"
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
                <span className="preview-url" title={url}>
                  <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" className="url-lock">
                    <rect x="2.75" y="5" width="6.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
                    <path
                      d="M4.25 5V3.9a1.75 1.75 0 0 1 3.5 0V5"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="url-text">{url}</span>
                </span>
                <div className="chrome-tools">
                  <div className="seg seg--chrome" role="group" aria-label="Preview width">
                    {DEVICES.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className="seg-btn"
                        aria-pressed={device === d.id}
                        aria-label={d.hint}
                        title={d.hint}
                        onClick={() => setDevice(d.id)}
                      >
                        {d.icon}
                      </button>
                    ))}
                  </div>
                  <InspectToggle active={inspect.active} onToggle={inspect.toggle} />
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
                </div>
              </div>
              <iframe
                key={`${build.id}-${reloadKey}`}
                ref={iframeRef}
                className="preview-frame"
                title="Built site preview"
                /* opaque origin: the generated site runs scripts but cannot
                   reach the Foundry API or app origin */
                sandbox="allow-scripts"
                src={`${url}${url.includes('?') ? '&' : '?'}r=${reloadKey}`}
                onLoad={() => setFrameLoaded(true)}
              />
            </div>

            <VisualEditorPanel
              buildId={build.id}
              active={inspect.active}
              iframeRef={iframeRef}
              frameEpoch={`${build.id}-${reloadKey}`}
              onEditSaved={() => {
                setFrameLoaded(false);
                setReloadKey((k) => k + 1);
              }}
            />

            {doneCardVisible && (
              <div className="done-overlay">
                <div className="done-card" role="group" aria-label="Build summary">
                  <button
                    type="button"
                    className="icon-btn done-close"
                    aria-label="Dismiss build summary"
                    title="Dismiss (Esc)"
                    onClick={() => setCardDismissed(true)}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                      <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span className="done-kicker">
                    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" fill="none" />
                      <path
                        d="M4.4 7.3 6.2 9.1 9.6 5.1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Build complete
                  </span>
                  <h3 className="done-title">Your site is ready</h3>
                  <div className="done-stats">
                    <span className="done-stat">
                      <span className="done-stat-value">{build.files.length}</span>
                      <span className="done-stat-label">{build.files.length === 1 ? 'file' : 'files'}</span>
                    </span>
                    <span className="done-stat">
                      <span className="done-stat-value">{formatBytes(totalBytes)}</span>
                      <span className="done-stat-label">total size</span>
                    </span>
                  </div>
                  <div className="done-actions">
                    <button
                      type="button"
                      className="btn btn--primary done-open"
                      ref={doneOpenRef}
                      onClick={() => setCardDismissed(true)}
                    >
                      Open Preview
                    </button>
                    <div className="done-actions-row">
                      <a className="btn btn--ghost btn--s" href={downloadUrl(build.id)}>
                        Download .zip
                      </a>
                      <button type="button" className="btn btn--ghost btn--s" onClick={onNewBuild}>
                        New build
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : running ? (
          <div className="pv-skeleton" aria-label="The team is writing the first files">
            <div className="pv-skel-browser" aria-hidden="true">
              <div className="pv-skel-bar">
                <i /><i /><i />
                <span className="pv-skel-url" />
              </div>
              <div className="pv-skel-page">
                <div className="pv-skel-hero" />
                <div className="pv-skel-lines">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="pv-skel-row">
                  <div className="pv-skel-card" />
                  <div className="pv-skel-card" />
                  <div className="pv-skel-card" />
                </div>
              </div>
            </div>
            <p className="pv-skel-note">
              The team is writing the first files — the live preview lands here. Progress streams in the chat.
            </p>
          </div>
        ) : (
          <div className="empty-state empty-hint">
            <svg className="empty-icon" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
              <rect x="4" y="7" width="28" height="22" rx="2.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path d="M4 12.5h28" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="8" cy="9.8" r="0.9" fill="currentColor" />
              <circle cx="11.5" cy="9.8" r="0.9" fill="currentColor" />
              <path
                d="M10 20h10M10 24h7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                opacity="0.55"
              />
            </svg>
            <p>This build produced no files to preview.</p>
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

      <div
        role="tabpanel"
        id="panel-console"
        aria-labelledby="tab-console"
        hidden={tab !== 'console'}
        className="tabpanel"
      >
        <ConsoleTab buildId={build.id} onCountChange={setConsoleCounts} />
      </div>
    </div>
  );
}
