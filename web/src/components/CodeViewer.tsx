import { useEffect, useMemo, useState } from 'react';
import type { SiteFile } from '../types';
import { baseName, folderOf, formatBytes } from '../format';
import { highlightLines, langFor } from '../highlight';

const MAX_LINES = 6000;

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

interface CodeViewerProps {
  files: SiteFile[];
  running: boolean;
}

export function CodeViewer({ files, running }: CodeViewerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  const groups = useMemo(() => groupFiles(files), [files]);
  const file = files.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (selected && files.some((f) => f.path === selected)) return;
    setSelected(files[0]?.path ?? null);
  }, [files, selected]);

  useEffect(() => {
    setCopied('idle');
  }, [selected]);

  const lines = useMemo(() => {
    if (!file || file.content === undefined) return null;
    const all = highlightLines(file.content, langFor(file.path));
    return all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all;
  }, [file]);

  const truncated = file?.content !== undefined && lines !== null && file.content.split('\n').length > MAX_LINES;

  async function copyContent() {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied('ok');
      return;
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = file.content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(ok ? 'ok' : 'failed');
    } catch {
      setCopied('failed');
    }
  }

  if (files.length === 0) {
    return (
      <div className="empty-state">
        <p>No files yet{running ? ' — the team is still working.' : '.'}</p>
      </div>
    );
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
                    className={`tree-file${f.path === selected ? ' is-selected' : ''}`}
                    onClick={() => setSelected(f.path)}
                    aria-current={f.path === selected ? 'true' : undefined}
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

      <div className="code-view">
        {file ? (
          <>
            <div className="code-head">
              <span className="code-path" title={file.path}>
                {file.path}
              </span>
              <span className="muted">{formatBytes(file.bytes)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--s"
                onClick={copyContent}
                disabled={!file.content}
              >
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
              </button>
            </div>
            {file.content === undefined ? (
              <div className="empty-state">
                <p>
                  The stream only carried this file&apos;s metadata — its content will appear when the build
                  finishes.
                </p>
              </div>
            ) : (
              <pre className="code-scroll" tabIndex={0} aria-label={`Contents of ${file.path}`}>
                <code>
                  {lines?.map((line, i) => (
                    <span className="code-line" key={i}>
                      <span className="ln" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="lc">
                        {line.map((t, k) =>
                          t.cls ? (
                            <span key={k} className={t.cls}>
                              {t.text}
                            </span>
                          ) : (
                            t.text
                          ),
                        )}
                        {line.length === 0 ? ' ' : ''}
                      </span>
                    </span>
                  ))}
                  {truncated && (
                    <span className="code-line">
                      <span className="ln" aria-hidden="true" />
                      <span className="lc muted">… truncated — download the zip to see the full file.</span>
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
      </div>
    </div>
  );
}
