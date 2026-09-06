import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SiteFile } from '../types';
import { baseName, folderOf, formatBytes } from '../format';
import { highlightLines, langFor } from '../highlight';

/** Render at most ~this many lines around the viewport; the rest is spacers. */
const WINDOW_MAX = 2000;
/** Fallbacks until the real values are measured from the DOM. */
const FALLBACK_LINE_H = 19.2;
const FALLBACK_VIEWPORT_H = 600;
/** Keep tab memory for the most recent builds only. */
const MEMORY_LIMIT = 50;

interface FileGroup {
  folder: string;
  files: SiteFile[];
}

function groupFiles(files: SiteFile[]): FileGroup[] {
  const map = new Map<string, SiteFile[]>();
  for (const f of files) {
    const folder = folderOf(f.path);
    const list = map.get(folder) ?? [];
    list.push(f);
    map.set(folder, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, group]) => ({
      folder,
      files: [...group].sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

interface TabMemory {
  open: string[];
  active: string | null;
  /** true when the user deliberately closed every tab — do not auto-reopen. */
  sealed: boolean;
}

/** Open tabs + active file per build id, surviving unmount/remount. */
const tabMemory = new Map<string, TabMemory>();

/** Pure — candidate for web/src/lib/pure.ts (WEBTYPES) if tests want it. */
export function computeWindow(
  total: number,
  scrollTop: number,
  viewportH: number,
  lineH: number,
): { start: number; end: number } {
  if (total <= WINDOW_MAX || lineH <= 0) return { start: 0, end: total };
  const visible = Math.max(1, Math.ceil(viewportH / lineH));
  const overscan = Math.max(40, Math.floor((WINDOW_MAX - visible) / 2));
  const size = visible + overscan * 2;
  let start = Math.max(0, Math.floor(scrollTop / lineH) - overscan);
  const end = Math.min(total, start + size);
  if (end - start < size) start = Math.max(0, end - size);
  return { start, end };
}

/** Pure — candidate for web/src/lib/pure.ts (WEBTYPES) if tests want it. */
export function findMatches(lines: string[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const tabStripStyle: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  gap: 2,
  padding: '4px 6px 0',
  overflowX: 'auto',
  borderBottom: '1px solid var(--border-0)',
  background: 'var(--bg-1)',
};

function tabWrapStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    flex: '0 0 auto',
    border: `1px solid ${active ? 'var(--border-0)' : 'transparent'}`,
    borderBottom: active ? '1px solid var(--bg-0)' : '1px solid transparent',
    borderRadius: 'var(--radius-m) var(--radius-m) 0 0',
    background: active ? 'var(--bg-0)' : 'transparent',
    color: active ? 'var(--text-0)' : 'var(--text-2)',
  };
}

const tabButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '3px 2px 3px 10px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const tabCloseStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-2)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1,
  padding: '2px 8px 2px 6px',
  cursor: 'pointer',
};

const searchBarStyle: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-2) var(--sp-3)',
  borderBottom: '1px solid var(--border-0)',
  background: 'var(--bg-1)',
};

const menuStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 60,
  minWidth: 150,
  padding: 4,
  border: '1px solid var(--border-1)',
  borderRadius: 'var(--radius-m)',
  background: 'var(--bg-2)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
};

const menuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  border: 'none',
  borderRadius: 'var(--radius-s)',
  background: 'transparent',
  color: 'var(--text-0)',
  font: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  padding: '5px var(--sp-3)',
  cursor: 'pointer',
};

interface CodeViewerProps {
  files: SiteFile[];
  running: boolean;
  buildId?: string;
}

export function CodeViewer({ files, running, buildId }: CodeViewerProps) {
  const buildKey = buildId ?? '';
  const [openTabs, setOpenTabs] = useState<string[]>(() => tabMemory.get(buildKey)?.open ?? []);
  const [active, setActive] = useState<string | null>(() => tabMemory.get(buildKey)?.active ?? null);
  const [sealed, setSealed] = useState<boolean>(() => tabMemory.get(buildKey)?.sealed ?? false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT_H);
  const [lineH, setLineH] = useState(FALLBACK_LINE_H);
  const scrollRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number | null>(null);
  const skipPersist = useRef(false);

  const groups = useMemo(() => groupFiles(files), [files]);
  const file = files.find((f) => f.path === active) ?? null;

  // Load the remembered tab state when switching builds.
  useEffect(() => {
    const entry = tabMemory.get(buildKey);
    skipPersist.current = true;
    setOpenTabs(entry?.open ?? []);
    setActive(entry?.active ?? null);
    setSealed(entry?.sealed ?? false);
  }, [buildKey]);

  // Persist tab state so it survives unmount/remount for this build id.
  useEffect(() => {
    if (skipPersist.current) {
      // the build-key load above already holds this build's remembered state
      skipPersist.current = false;
      return;
    }
    tabMemory.set(buildKey, { open: openTabs, active, sealed });
    if (tabMemory.size > MEMORY_LIMIT) {
      const oldest = tabMemory.keys().next().value;
      if (oldest !== undefined && oldest !== buildKey) tabMemory.delete(oldest);
    }
  }, [buildKey, openTabs, active, sealed]);

  // Drop tabs whose file vanished from the build.
  useEffect(() => {
    setOpenTabs((prev) => {
      const valid = prev.filter((p) => files.some((f) => f.path === p));
      return valid.length === prev.length ? prev : valid;
    });
  }, [files]);

  // Keep the active tab pointing at an open tab.
  useEffect(() => {
    if (active !== null && openTabs.includes(active)) return;
    setActive(openTabs[openTabs.length - 1] ?? null);
  }, [openTabs, active]);

  // Open the first file by default — unless the user closed every tab on purpose.
  useEffect(() => {
    if (openTabs.length === 0 && !sealed && files.length > 0) {
      setOpenTabs([files[0].path]);
      setActive(files[0].path);
    }
  }, [openTabs, sealed, files]);

  const rawLines = useMemo(() => (file?.content !== undefined ? file.content.split('\n') : null), [file]);
  const highlighted = useMemo(
    () => (file?.content !== undefined && file ? highlightLines(file.content, langFor(file.path)) : null),
    [file],
  );

  // Find-in-file searches the FULL content, never just the rendered window.
  const matches = useMemo(() => (query && rawLines ? findMatches(rawLines, query) : []), [rawLines, query]);
  const filtering = query.length > 0;
  const total = filtering ? matches.length : (highlighted?.length ?? 0);
  const win = useMemo(
    () => computeWindow(total, scrollTop, viewportH, lineH),
    [total, scrollTop, viewportH, lineH],
  );

  useEffect(() => {
    setCopied('idle');
  }, [active]);

  useEffect(() => {
    if (copied === 'idle') return;
    const t = window.setTimeout(() => setCopied('idle'), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Measure the real line height / viewport once lines are on screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight || FALLBACK_VIEWPORT_H);
    const row = el.querySelector('.code-line');
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h > 0) setLineH(h);
    }
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight || FALLBACK_VIEWPORT_H));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, file?.content]);

  // New file: jump back to the top.
  useEffect(() => {
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [active]);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [searchOpen]);

  // Keep the current hit in range and centered in the viewport.
  useEffect(() => {
    if (matches.length > 0 && hit >= matches.length) setHit(0);
  }, [matches.length, hit]);

  useEffect(() => {
    if (!searchOpen || !filtering || matches.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, hit * lineH - viewportH / 2);
    el.scrollTop = target;
    setScrollTop(target);
    el.querySelector('[data-hit="current"]')?.scrollIntoView({ block: 'center' });
  }, [hit, filtering, searchOpen, matches.length, lineH, viewportH]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  function activateFile(path: string) {
    setSealed(false);
    if (!openTabs.includes(path)) setOpenTabs([...openTabs, path]);
    setActive(path);
  }

  function closeTab(path: string) {
    const idx = openTabs.indexOf(path);
    if (idx === -1) return;
    const next = [...openTabs.slice(0, idx), ...openTabs.slice(idx + 1)];
    setOpenTabs(next);
    if (next.length === 0) setSealed(true);
    if (active === path) setActive(next[idx] ?? next[idx - 1] ?? null);
  }

  function openContextMenu(e: React.MouseEvent, path: string) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path });
  }

  async function copyContent() {
    if (!file?.content) return;
    setCopied((await copyText(file.content)) ? 'ok' : 'failed');
  }

  async function copyPath(path: string) {
    setMenu(null);
    const ok = await copyText(path);
    setNotice(ok ? `Copied path: ${path}` : 'Copy failed — the clipboard is unavailable.');
  }

  function openSearch() {
    setSearchOpen(true);
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    setHit(0);
    scrollRef.current?.focus();
  }

  function stepHit(dir: 1 | -1) {
    if (matches.length === 0) return;
    setHit((h) => (h + dir + matches.length) % matches.length);
  }

  function onCodeKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openSearch();
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  }

  function onScroll() {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }

  if (files.length === 0) {
    return (
      <div className="empty-state">
        <p>No files yet{running ? ' — the team is still working.' : '.'}</p>
      </div>
    );
  }

  const rows = [];
  if (highlighted) {
    for (let k = win.start; k < win.end; k += 1) {
      const lineIdx = filtering ? matches[k] : k;
      const line = highlighted[lineIdx] ?? [];
      const isHit = filtering && k === hit;
      rows.push(
        <span
          className="code-line"
          key={lineIdx}
          data-hit={isHit ? 'current' : undefined}
          style={isHit ? { background: 'var(--bg-3)' } : undefined}
        >
          <span className="ln" aria-hidden="true">
            {lineIdx + 1}
          </span>
          <span className="lc">
            {line.map((t, i) =>
              t.cls ? (
                <span key={i} className={t.cls}>
                  {t.text}
                </span>
              ) : (
                t.text
              ),
            )}
            {line.length === 0 ? ' ' : ''}
          </span>
        </span>,
      );
    }
  }

  return (
    <div className="code-pane">
      <nav className="file-tree" aria-label="Site files">
        {groups.map((g) => (
          <div className="tree-group" key={g.folder || '(root)'}>
            {g.folder && (
              <div className="tree-folder" title={g.folder}>
                {g.folder}/
              </div>
            )}
            <ul>
              {g.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className={`tree-file${f.path === active ? ' is-selected' : ''}`}
                    onClick={() => activateFile(f.path)}
                    onContextMenu={(e) => openContextMenu(e, f.path)}
                    aria-current={f.path === active ? 'true' : undefined}
                    title={f.path}
                  >
                    <span className="tree-file-name">{baseName(f.path)}</span>
                    <span className="tree-file-bytes">{formatBytes(f.bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="code-view" onKeyDown={onCodeKeyDown}>
        {openTabs.length > 0 && (
          <div style={tabStripStyle} role="tablist" aria-label="Open files">
            {openTabs.map((p) => {
              const name = baseName(p);
              const isActive = p === active;
              return (
                <div key={p} style={tabWrapStyle(isActive)} onContextMenu={(e) => openContextMenu(e, p)}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={p}
                    style={tabButtonStyle}
                    onClick={() => activateFile(p)}
                    onAuxClick={(e) => {
                      if (e.button === 1) closeTab(p);
                    }}
                  >
                    {name}
                  </button>
                  <button
                    type="button"
                    style={tabCloseStyle}
                    aria-label={`Close ${name}`}
                    title="Close"
                    onClick={() => closeTab(p)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {file ? (
          <>
            <div className="code-head">
              <span className="code-path" title={file.path}>
                {file.path}
              </span>
              {notice ? (
                <span className="muted" role="status">
                  {notice}
                </span>
              ) : (
                <span className="muted">{formatBytes(file.bytes)}</span>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--s"
                onClick={openSearch}
                disabled={!file.content}
                aria-label="Find in file"
                title="Find in file (Ctrl+F)"
              >
                Find
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--s"
                onClick={copyContent}
                disabled={!file.content}
              >
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
              </button>
            </div>

            {searchOpen && (
              <div style={searchBarStyle} role="search">
                <input
                  ref={inputRef}
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={query}
                  placeholder="Filter lines in this file"
                  aria-label="Filter lines in this file"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHit(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
                <span className="muted" role="status" aria-live="polite" style={{ whiteSpace: 'nowrap' }}>
                  {filtering
                    ? matches.length > 0
                      ? `${Math.min(hit + 1, matches.length)} of ${matches.length} ${
                          matches.length === 1 ? 'match' : 'matches'
                        }`
                      : 'No matches'
                    : 'Type to filter'}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Previous match"
                  title="Previous match (Shift+Enter)"
                  disabled={matches.length === 0}
                  onClick={() => stepHit(-1)}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                    <path
                      d="M2.5 7 5.5 4 8.5 7"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Next match"
                  title="Next match (Enter)"
                  disabled={matches.length === 0}
                  onClick={() => stepHit(1)}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                    <path
                      d="M2.5 4 5.5 7 8.5 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button type="button" className="icon-btn" aria-label="Close search" title="Close (Esc)" onClick={closeSearch}>
                  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                    <path d="M2.5 2.5 8.5 8.5M8.5 2.5 2.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}

            {file.content === undefined ? (
              <div className="empty-state">
                <p>
                  The stream only carried this file&apos;s metadata — its content will appear when the build
                  finishes.
                </p>
              </div>
            ) : (
              <pre
                className="code-scroll"
                tabIndex={0}
                aria-label={`Contents of ${file.path}`}
                ref={scrollRef}
                onScroll={onScroll}
              >
                <code>
                  {win.start > 0 && <span style={{ display: 'block', height: win.start * lineH }} aria-hidden="true" />}
                  {rows}
                  {win.end < total && (
                    <span style={{ display: 'block', height: (total - win.end) * lineH }} aria-hidden="true" />
                  )}
                  {filtering && matches.length === 0 && (
                    <span className="code-line">
                      <span className="ln" aria-hidden="true" />
                      <span className="lc muted">No lines match — clear the filter to see the whole file.</span>
                    </span>
                  )}
                </code>
              </pre>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Select a file to view its source.</p>
          </div>
        )}

        {menu && (
          <div
            role="menu"
            aria-label={`Actions for ${menu.path}`}
            style={{
              ...menuStyle,
              left: Math.min(menu.x, window.innerWidth - 170),
              top: Math.min(menu.y, window.innerHeight - 60),
            }}
          >
            <button type="button" role="menuitem" style={menuItemStyle} onClick={() => copyPath(menu.path)}>
              Copy path
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
