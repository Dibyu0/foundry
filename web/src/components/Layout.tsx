import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { BuildState, BuildSummary, Phase, ServerConfig, StreamStatus } from '../types';
import { formatTime } from '../format';
import { useEscape, useFocusReturn, useFocusTrap } from '../a11y';
import { Logo } from './Logo';
import { PhaseBadge } from './BuildsHistory';
import { ChatComposer } from './ChatComposer';
import { TemplatesGallery } from './TemplatesGallery';
import { VirtualList } from './VirtualList';
import type { VirtualListHandle } from './VirtualList';

/* ------------------------------------------------------------------ */
/* Foundry app shell. Two modes driven by App's state machine:        */
/*  - home: centered hero composer (the brief is the product) with    */
/*    template chips and a compact recent-builds grid                 */
/*  - work: chat left / workspace right under a proper top bar        */
/* Build history is a slide-over from the left (overlay, Escape       */
/* closes, focus returns to the toggle). All motion is CSS-only via   */
/* the .view--* / .drawer* classes so prefers-reduced-motion stays a  */
/* stylesheet concern; this file adds no JS animation.                */
/* ------------------------------------------------------------------ */

const NO_FILES: string[] = [];

/** Matches the two-line .drawer-item layout (same rhythm as history rows). */
const DRAWER_ROW_HEIGHT = 54;

/** Recent builds shown on the home grid; the drawer holds the full list. */
const HOME_RECENTS_CAP = 6;

export interface LayoutProps {
  mode: 'home' | 'work';

  /* current build + stream */
  build: BuildState | null;
  buildLoading: boolean;
  streamStatus: StreamStatus;
  onReconnect: () => void;

  /* provider status / setup */
  config: ServerConfig | null;
  configLoading: boolean;
  configError: string | null;
  setupNeeded: boolean;
  onOpenSetup: () => void;

  /* build history */
  builds: BuildSummary[];
  buildsLoading: boolean;
  buildsError: string | null;
  onOpenBuild: (id: string) => void;
  onRefreshBuilds: () => void;

  /* hero composer (home) */
  sending: boolean;
  onSendBrief: (brief: string) => Promise<boolean>;
  composerRef: RefObject<HTMLTextAreaElement>;

  /* work-view chrome */
  chatCollapsed: boolean;
  onToggleChat: () => void;
  onNewBuild: () => void;

  /* slots owned by App */
  setupCard: ReactNode;
  chat: ReactNode;
  timeline: ReactNode;
  workspace: ReactNode;

  notice: { kind: 'info' | 'error'; text: string } | null;
}

/** Compact status light; color comes from the shared .phase--* classes. */
function PhaseDot({ phase }: { phase: Phase }) {
  return (
    <span
      className={`phase--${phase.toLowerCase()}`}
      aria-hidden="true"
      style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }}
    />
  );
}

function fullTimestamp(ts: number | undefined): string | undefined {
  if (!ts) return undefined;
  return new Date(ts > 1e12 ? ts : ts * 1000).toLocaleString();
}

const RUNNING_PHASES = new Set(['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW']);

function Elapsed({ since, active }: { since: number; active: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  const secs = Math.max(0, Math.floor((now - (since > 1e12 ? since : since * 1000)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const text = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return (
    <span className="elapsed" title="Time since the build started">
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Provider status pill (top bar)                                     */
/* ------------------------------------------------------------------ */

function ProviderPill({ p }: { p: LayoutProps }) {
  let state: 'loading' | 'error' | 'warn' | 'ok' = 'ok';
  let label = 'Provider';
  let title = 'Open provider settings';
  if (p.configLoading) {
    state = 'loading';
    label = 'Connecting...';
    title = 'Checking the provider configuration';
  } else if (p.configError !== null) {
    state = 'error';
    label = 'Provider unreachable';
    title = p.configError;
  } else if (p.setupNeeded) {
    state = 'warn';
    label = 'Setup needed';
    title = 'The model provider needs configuration - open setup';
  } else if (p.config !== null) {
    label = p.config.provider;
    title = `${p.config.provider} - ${p.config.model} - open provider settings`;
  }
  return (
    <button
      type="button"
      className={`provider-pill provider-pill--${state}`}
      onClick={p.onOpenSetup}
      title={title}
      aria-label={`Provider status: ${label}. Open provider settings.`}
    >
      <span className="provider-pill-dot" aria-hidden="true" />
      <span className="provider-pill-label">{label}</span>
      {state === 'ok' && p.config !== null && <span className="provider-pill-model">{p.config.model}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar                                                            */
/* ------------------------------------------------------------------ */

interface TopBarProps {
  p: LayoutProps;
  historyOpen: boolean;
  historyToggleRef: RefObject<HTMLButtonElement>;
  onToggleHistory: () => void;
}

function TopBar({ p, historyOpen, historyToggleRef, onToggleHistory }: TopBarProps) {
  const build = p.build;
  return (
    <header className="topbar">
      <div className="topbar-side">
        <button
          type="button"
          className="topbar-brand"
          onClick={p.onNewBuild}
          title="Foundry - start a new build"
          aria-label="Foundry - start a new build"
        >
          <Logo />
          <span className="topbar-brand-name">Foundry</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--s"
          ref={historyToggleRef}
          onClick={onToggleHistory}
          aria-expanded={historyOpen}
          aria-haspopup="dialog"
          aria-controls="history-drawer"
        >
          <svg width="12" height="12" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
            <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <path
              d="M6.5 3.8v2.7l1.9 1.1"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          History
          {p.builds.length > 0 && <span className="tab-count">{p.builds.length}</span>}
        </button>
      </div>

      {p.mode === 'work' && (
        <div className="topbar-context">
          {build ? (
            <>
              <span className="topbar-title" title={build.brief}>
                {build.brief || 'Untitled build'}
              </span>
              <PhaseBadge phase={build.phase} />
              <Elapsed since={build.createdAt} active={RUNNING_PHASES.has(build.phase)} />
            </>
          ) : (
            <span className="topbar-title muted">Loading build...</span>
          )}

          {p.streamStatus !== 'idle' && (
            <span className={`stream-status stream--${p.streamStatus}`}>
              <span className="dot" aria-hidden="true" />
              {p.streamStatus === 'live'
                ? 'live'
                : p.streamStatus === 'lost'
                  ? 'connection lost'
                  : p.streamStatus}
            </span>
          )}
          {p.streamStatus === 'lost' && (
            <button type="button" className="btn btn--ghost btn--s" onClick={p.onReconnect}>
              Reconnect
            </button>
          )}
          {build !== null && build.error !== undefined && build.phase === 'ERROR' && (
            <span className="header-error" title={build.error}>
              {build.error}
            </span>
          )}
        </div>
      )}

      <div className="topbar-actions">
        <ProviderPill p={p} />
        {p.mode === 'work' && (
          <button
            type="button"
            className="btn btn--ghost btn--s"
            onClick={p.onToggleChat}
            aria-expanded={!p.chatCollapsed}
          >
            {p.chatCollapsed ? 'Show chat' : 'Hide chat'}
          </button>
        )}
        <button type="button" className="btn btn--primary btn--s" onClick={p.onNewBuild}>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          New build
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* History slide-over                                                 */
/* ------------------------------------------------------------------ */

interface HistoryDrawerProps {
  p: LayoutProps;
  open: boolean;
  onClose: () => void;
}

function HistoryDrawer({ p, open, onClose }: HistoryDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const initedRef = useRef(false);
  const { builds, buildsLoading: loading, buildsError: error, build } = p;
  const currentId = build?.id;

  const listReady = open && !loading && error === null && builds.length > 0;

  /* Escape closes; focus is trapped while open and returns to the toggle. */
  useEscape(onClose, open);
  useFocusTrap(panelRef, open);
  useFocusReturn(open);

  useEffect(() => {
    if (open) return;
    initedRef.current = false;
    setActiveIdx(-1);
  }, [open]);

  // Once per opening: focus the listbox and select the currently open build.
  // Deliberately not re-run on later `builds` refreshes, which would steal focus.
  useEffect(() => {
    if (!listReady || initedRef.current) return;
    initedRef.current = true;
    const cur = currentId !== undefined ? builds.findIndex((b) => b.id === currentId) : -1;
    setActiveIdx(cur);
    listRef.current?.focus();
    if (cur >= 0) listRef.current?.scrollToIndex(cur);
  }, [listReady, currentId, builds]);

  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const n = builds.length;
    if (n === 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = activeIdx < 0 ? 0 : Math.min(n - 1, activeIdx + 1);
    else if (e.key === 'ArrowUp') next = activeIdx < 0 ? n - 1 : Math.max(0, activeIdx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      if (activeIdx >= 0 && activeIdx < n) {
        e.preventDefault();
        openBuild(builds[activeIdx].id);
      }
      return;
    } else {
      return;
    }
    e.preventDefault();
    setActiveIdx(next);
    listRef.current?.scrollToIndex(next);
  }

  function openBuild(id: string) {
    onClose();
    p.onOpenBuild(id);
  }

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Build history"
        id="history-drawer"
        ref={panelRef}
      >
        <div className="drawer-head">
          <span className="drawer-title">Recent builds</span>
          <div className="drawer-head-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={p.onRefreshBuilds}
              aria-label="Refresh history"
              title="Refresh"
            >
              <svg width="12" height="12" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
                <path
                  d="M11 6.5a4.5 4.5 0 1 1-1.3-3.2M11 1v2.6H8.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close history" title="Close">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {loading && <p className="muted drawer-msg">Loading...</p>}
        {!loading && error !== null && (
          <p className="drawer-msg inline-error" role="alert">
            {error}
          </p>
        )}
        {!loading && error === null && builds.length === 0 && (
          <p className="muted drawer-msg">No builds yet. Describe a website to start your first build.</p>
        )}

        {listReady && (
          <VirtualList
            ref={listRef}
            items={builds}
            rowHeight={DRAWER_ROW_HEIGHT}
            overscan={6}
            className="drawer-list"
            role="listbox"
            ariaLabel="Recent builds"
            tabIndex={0}
            ariaActiveDescendant={
              activeIdx >= 0 && activeIdx < builds.length ? `drawer-option-${builds[activeIdx].id}` : undefined
            }
            onKeyDown={onListKeyDown}
            getKey={(b) => b.id}
            render={(b, i) => {
              const isCurrent = b.id === currentId;
              return (
                <button
                  type="button"
                  role="option"
                  id={`drawer-option-${b.id}`}
                  tabIndex={-1}
                  aria-selected={isCurrent}
                  aria-setsize={builds.length}
                  aria-posinset={i + 1}
                  className={`drawer-item${isCurrent ? ' is-current' : ''}${i === activeIdx && !isCurrent ? ' is-active' : ''}`}
                  onClick={() => openBuild(b.id)}
                  onMouseMove={() => {
                    if (i !== activeIdx) setActiveIdx(i);
                  }}
                >
                  <span className="drawer-item-top">
                    <PhaseDot phase={b.phase} />
                    <span className="drawer-brief" title={b.brief}>
                      {b.brief || '(no brief)'}
                    </span>
                  </span>
                  <span className="drawer-meta">
                    <span className={`phase--${b.phase.toLowerCase()}`} style={{ fontWeight: 600 }}>
                      {b.phase}
                    </span>
                    <span className="muted" title={fullTimestamp(b.createdAt)}>
                      {formatTime(b.createdAt)}
                    </span>
                  </span>
                </button>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Home view: hero composer + templates + recent builds               */
/* ------------------------------------------------------------------ */

function HomeView({ p, onShowHistory }: { p: LayoutProps; onShowHistory: () => void }) {
  const [draft, setDraft] = useState('');

  /* The brief is the product: land the caret in the composer. */
  useEffect(() => {
    p.composerRef.current?.focus();
  }, [p.composerRef]);

  const recents = p.builds.slice(0, HOME_RECENTS_CAP);
  const showRecents = p.buildsLoading || p.buildsError !== null || p.builds.length > 0;

  return (
    <main className="home">
      <div className="home-inner">
        <h1 className="home-title">Describe the website you want.</h1>
        <p className="home-sub">
          A small team of agents plans, designs and builds a real site from your brief - preview it live, inspect
          the code, and download the result.
        </p>

        {p.setupCard}

        <div className="home-composer">
          <ChatComposer
            running={false}
            sending={p.sending}
            draft={draft}
            onDraftChange={setDraft}
            mentionFiles={NO_FILES}
            onSend={p.onSendBrief}
            composerRef={p.composerRef}
          />
        </div>

        <div className="home-templates">
          <TemplatesGallery
            disabled={p.sending}
            onPick={(brief) => {
              setDraft(brief);
              p.composerRef.current?.focus();
            }}
          />
        </div>

        {showRecents && (
          <section className="home-recents" aria-labelledby="recents-title">
            <div className="recents-head">
              <h2 className="recents-title" id="recents-title">Recent builds</h2>
              {p.builds.length > HOME_RECENTS_CAP && (
                <button type="button" className="btn btn--ghost btn--s" onClick={onShowHistory}>
                  View all {p.builds.length}
                </button>
              )}
            </div>

            {p.buildsLoading && <p className="muted recents-msg">Loading...</p>}
            {!p.buildsLoading && p.buildsError !== null && (
              <p className="recents-msg inline-error" role="alert">
                {p.buildsError}{' '}
                <button type="button" className="btn btn--ghost btn--s" onClick={p.onRefreshBuilds}>
                  Retry
                </button>
              </p>
            )}
            {!p.buildsLoading && p.buildsError === null && (
              <ul className="recents-grid">
                {recents.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="recent-card"
                      onClick={() => p.onOpenBuild(b.id)}
                      title={b.brief || '(no brief)'}
                    >
                      <span className="recent-top">
                        <PhaseDot phase={b.phase} />
                        <span className={`recent-phase phase--${b.phase.toLowerCase()}`}>{b.phase}</span>
                        <span className="recent-time muted">{formatTime(b.createdAt)}</span>
                      </span>
                      <span className="recent-brief">{b.brief || '(no brief)'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Work view: chat left, workspace right                              */
/* ------------------------------------------------------------------ */

function WorkView({ p }: { p: LayoutProps }) {
  return (
    <div className="work">
      {!p.chatCollapsed && (
        <aside className="work-chat" aria-label="Conversation">
          {p.setupCard}
          {p.chat}
        </aside>
      )}
      <main className="work-main">
        {p.timeline}
        {p.workspace}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                              */
/* ------------------------------------------------------------------ */

export function Layout(p: LayoutProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggleRef = useRef<HTMLButtonElement>(null);

  function toggleHistory() {
    if (!historyOpen) p.onRefreshBuilds();
    setHistoryOpen((o) => !o);
  }

  return (
    <div className="shell" data-mode={p.mode}>
      <TopBar
        p={p}
        historyOpen={historyOpen}
        historyToggleRef={historyToggleRef}
        onToggleHistory={toggleHistory}
      />

      <div className={`view view--${p.mode}`} key={p.mode}>
        {p.mode === 'home' ? <HomeView p={p} onShowHistory={toggleHistory} /> : <WorkView p={p} />}
      </div>

      <HistoryDrawer p={p} open={historyOpen} onClose={() => setHistoryOpen(false)} />

      {p.notice !== null && (
        <div className={`notice notice--${p.notice.kind}`} role="status">
          {p.notice.text}
        </div>
      )}
    </div>
  );
}
