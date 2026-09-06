import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyStyleToPreview,
  createInspectMode,
  isInspectSelectMessage,
  subscribePreview,
  type InspectedElement,
  type InspectModeController,
} from '../previewBridge';
import {
  applyVisualChange,
  clearVisualBatch,
  visualBatchToInstruction,
  type VisualEditBatch,
} from '../lib/pure';

/* ------------------------------------------------------------------ */
/* The bridge (web/src/previewBridge.ts) sends typed messages:         */
/*   { kind: 'inspect-select', element: InspectedElement }             */
/* and confirms live edits via applyStyleToPreview's style-applied.    */
/* InspectedElement.xpath is an xpath-lite locator, not a CSS          */
/* selector — xpathToCss converts it so applyStyle can resolve it.     */
/* Text edits have no live-apply command in the bridge protocol; they  */
/* collect into the batch and ship with the instruction instead.       */
/* ------------------------------------------------------------------ */

export interface ElementInfo {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  styles: Record<string, string>;
  /** CSS selector derived from the bridge xpath; null when it cannot be converted. */
  cssSelector: string | null;
}

/**
 * Convert the bridge's xpath-lite ('/html[1]/body[1]/div[2]' or '/#hero')
 * into the equivalent CSS selector ('html > body > div:nth-of-type(2)').
 * Returns null when a segment cannot be parsed — callers must treat the
 * element as not live-editable rather than guess.
 */
export function xpathToCss(xpath: string): string | null {
  if (xpath === '' || !xpath.startsWith('/')) return null;
  const segments = xpath.slice(1).split('/');
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith('#')) {
      const id = segment.slice(1);
      if (!/^[A-Za-z][\w-]*$/.test(id)) return null;
      parts.push(`#${id}`);
      break; // xpath-lite stops at the first id ancestor
    }
    const m = /^([a-z][a-z0-9-]*)\[(\d+)\]$/.exec(segment);
    if (!m) return null;
    const tag = m[1] as string;
    const index = Number(m[2] as string);
    parts.push(index === 1 ? tag : `${tag}:nth-of-type(${index})`);
  }
  return parts.length > 0 ? parts.join(' > ') : null;
}

export function elementFromInspected(el: InspectedElement): ElementInfo {
  return {
    tag: el.tag,
    id: el.id,
    classes: el.classes,
    text: el.text,
    styles: { ...el.styles },
    cssSelector: xpathToCss(el.xpath),
  };
}

/** Short chip label: tag#id or tag.class-a.class-b (capped). */
export function describeElement(el: ElementInfo): string {
  let label = el.tag;
  if (el.id) label += `#${el.id}`;
  if (el.classes.length > 0) label += `.${el.classes.slice(0, 3).join('.')}`;
  return label;
}

/** Read a style value tolerating camelCase or kebab-case keys. */
function styleOf(el: ElementInfo, prop: string): string {
  const kebab = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return el.styles[prop] ?? el.styles[kebab] ?? '';
}

/** Normalize a length input: bare numbers become px, empty stays empty. */
function toLength(v: string): string {
  const t = v.trim();
  if (t === '') return '';
  return /^-?\d+(\.\d+)?$/.test(t) ? `${t}px` : t;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/* ------------------------------------------------------------------ */
/* Inspect mode hook: wraps the bridge's createInspectMode controller  */
/* (Escape to disarm, re-arm on preview reload) for React.             */
/* ------------------------------------------------------------------ */

export function useInspectMode(iframeRef: React.RefObject<HTMLIFrameElement | null>): {
  active: boolean;
  toggle: () => void;
} {
  const controllerRef = useRef<InspectModeController | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const controller = createInspectMode(() => iframeRef.current);
    controllerRef.current = controller;
    const unsub = controller.subscribe(setActive);
    return () => {
      unsub();
      controller.destroy();
      controllerRef.current = null;
    };
  }, [iframeRef]);

  const toggle = useCallback(() => {
    controllerRef.current?.toggle();
  }, []);

  return { active, toggle };
}

/* ------------------------------------------------------------------ */
/* Inspect toggle (lives in the preview toolbar)                       */
/* ------------------------------------------------------------------ */

export function InspectToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="seg-btn"
      aria-pressed={active}
      aria-label="Inspect elements in the preview"
      title="Inspect — click an element in the preview to edit it visually (Esc to exit)"
      onClick={onToggle}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <path
          d="M2.5 1.5 11 5.3 7.3 6.4 9.6 10.4 8 11.2 5.8 7.2 2.9 9.4Z"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Visual editor panel                                                 */
/* ------------------------------------------------------------------ */

interface VisualEditorPanelProps {
  buildId: string;
  active: boolean;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Changes when the iframe reloads or the build switches — resets live edits. */
  frameEpoch: string;
  /** Called after a batch was sent as an edit instruction (host reloads the preview). */
  onEditSaved: () => void;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  bottom: 8,
  width: 264,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  overflowY: 'auto',
  background: 'color-mix(in srgb, var(--bg-1) 94%, transparent)',
  border: '1px solid var(--border-1)',
  borderRadius: 'var(--radius-m)',
  fontSize: 12,
  color: 'var(--text-1)',
  zIndex: 5,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '10px 0 6px',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
};

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, color: 'var(--text-2)' };

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border-0)',
  borderRadius: 'var(--radius-s)',
  color: 'var(--text-0)',
  font: 'inherit',
};

const rowStyle: React.CSSProperties = { display: 'flex', gap: 6 };

const BOX_SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

export function VisualEditorPanel({ buildId, active, iframeRef, frameEpoch, onEditSaved }: VisualEditorPanelProps) {
  const [selected, setSelected] = useState<ElementInfo | null>(null);
  const [batch, setBatch] = useState<VisualEditBatch>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const statusTimer = useRef<number | undefined>(undefined);

  // Selection and live edits die with the iframe document.
  useEffect(() => {
    setSelected(null);
    setBatch(clearVisualBatch());
    setStatus(null);
  }, [frameEpoch, buildId]);

  useEffect(() => {
    const unsub = subscribePreview((msg) => {
      if (isInspectSelectMessage(msg)) setSelected(elementFromInspected(msg.element));
    });
    return unsub;
  }, []);

  useEffect(
    () => () => {
      if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current);
    },
    [],
  );

  const showStatus = useCallback((kind: 'ok' | 'err', text: string) => {
    setStatus({ kind, text });
    if (statusTimer.current !== undefined) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 8000);
  }, []);

  const addToBatch = useCallback((el: ElementInfo, selector: string, property: string, value: string, previousValue: string) => {
    setBatch((b) =>
      applyVisualChange(b, {
        id: `${selector}::${property}`,
        selector,
        label: describeElement(el),
        property,
        value,
        previousValue,
      }),
    );
  }, []);

  const applyEdit = useCallback(
    (property: string, value: string) => {
      if (!selected) return;
      const selector = selected.cssSelector;
      if (!selector) return;
      const el = selected;
      const previousValue = property === 'text' ? el.text : styleOf(el, property);

      // Optimistically reflect the edit in the panel's local element copy.
      setSelected((s) => {
        if (!s) return s;
        if (property === 'text') return { ...s, text: value };
        return { ...s, styles: { ...s.styles, [property]: value } };
      });

      if (property === 'text') {
        // The bridge protocol has no live text command — batch-only.
        addToBatch(el, selector, property, value, previousValue);
        return;
      }

      applyStyleToPreview(iframeRef.current, { selector, prop: property, value })
        .then((reply) => {
          if (reply.ok) {
            addToBatch(el, selector, property, value, previousValue);
          } else {
            showStatus('err', `Preview rejected ${property}: ${reply.error ?? 'unknown error'}`);
          }
        })
        .catch((e: unknown) => {
          showStatus('err', e instanceof Error ? e.message : 'The preview did not confirm the style.');
        });
    },
    [selected, iframeRef, addToBatch, showStatus],
  );

  const canEdit = selected !== null && selected.cssSelector !== null;
  const isTextBearing = selected !== null && selected.text.length > 0;

  async function copyChip() {
    if (!selected) return;
    const text = selected.cssSelector ?? describeElement(selected);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      showStatus('err', 'Copy failed — clipboard is not available.');
    }
  }

  async function saveBatch() {
    if (batch.length === 0 || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/builds/${encodeURIComponent(buildId)}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: visualBatchToInstruction(batch) }),
      });
      if (!res.ok) {
        let message = `Edit request failed (${res.status})`;
        try {
          const body: unknown = await res.json();
          const err = rec(body)?.error;
          if (typeof err === 'string' && err) message = err;
        } catch {
          /* keep status-based message */
        }
        throw new Error(message);
      }
      setBatch(clearVisualBatch());
      showStatus('ok', 'Sent as an edit instruction — the team is applying it.');
      onEditSaved();
    } catch (e) {
      showStatus('err', e instanceof Error ? e.message : 'Edit request failed.');
    } finally {
      setSaving(false);
    }
  }

  if (!active) return null;

  return (
    <aside style={panelStyle} role="region" aria-label="Visual editor">
      {!selected ? (
        <p style={{ margin: 0, color: 'var(--text-2)' }}>Click an element in the preview to edit it.</p>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--ghost btn--s"
            style={{ alignSelf: 'flex-start', fontFamily: 'var(--font-mono)' }}
            title="Click to copy the element selector"
            aria-label={`Copy selector for ${describeElement(selected)}`}
            onClick={copyChip}
          >
            {describeElement(selected)}
            {copied ? ' — copied' : ''}
          </button>

          {!canEdit && (
            <p style={{ margin: 0, color: 'var(--warn)' }}>
              This element has no usable selector, so live edits are unavailable for it.
            </p>
          )}

          <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, padding: 0, display: 'contents' }}>
            {isTextBearing && (
              <section aria-label="Text">
                <h4 style={sectionTitleStyle}>Text</h4>
                <label style={labelStyle}>
                  Content
                  <textarea
                    style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }}
                    defaultValue={selected.text}
                    key={`text-${selected.cssSelector ?? ''}`}
                    rows={2}
                    onBlur={(e) => {
                      if (e.target.value !== selected.text) applyEdit('text', e.target.value);
                    }}
                  />
                </label>
                <span style={{ color: 'var(--text-2)' }}>Text edits ship with the instruction; they cannot preview live.</span>
              </section>
            )}

            <section aria-label="Color">
              <h4 style={sectionTitleStyle}>Color</h4>
              <div style={rowStyle}>
                {(['color', 'backgroundColor'] as const).map((prop) => {
                  const current = styleOf(selected, prop);
                  const swatch = /^#[0-9a-fA-F]{6}$/.test(current)
                    ? current
                    : prop === 'color'
                      ? '#e8edf3'
                      : '#161b23';
                  return (
                    <label key={prop} style={{ ...labelStyle, flex: 1 }}>
                      {prop === 'color' ? 'Text' : 'Background'}
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="color"
                          aria-label={`${prop} swatch`}
                          value={swatch}
                          style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--border-0)', background: 'none' }}
                          onChange={(e) => applyEdit(prop, e.target.value)}
                        />
                        <input
                          style={inputStyle}
                          key={`${prop}-${selected.cssSelector ?? ''}`}
                          defaultValue={current}
                          aria-label={`${prop} value`}
                          onBlur={(e) => {
                            if (e.target.value !== styleOf(selected, prop)) applyEdit(prop, e.target.value);
                          }}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>

            <section aria-label="Typography">
              <h4 style={sectionTitleStyle}>Typography</h4>
              <div style={rowStyle}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Font size
                  <input
                    style={inputStyle}
                    key={`fs-${selected.cssSelector ?? ''}`}
                    defaultValue={styleOf(selected, 'fontSize')}
                    placeholder="16px"
                    onBlur={(e) => {
                      const v = toLength(e.target.value);
                      if (v && v !== styleOf(selected, 'fontSize')) applyEdit('fontSize', v);
                    }}
                  />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Weight
                  <select
                    style={inputStyle}
                    value={styleOf(selected, 'fontWeight') || '400'}
                    aria-label="Font weight"
                    onChange={(e) => applyEdit('fontWeight', e.target.value)}
                  >
                    {['300', '400', '500', '600', '700', '800'].map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section aria-label="Box">
              <h4 style={sectionTitleStyle}>Box</h4>
              {(['margin', 'padding'] as const).map((base) => (
                <div key={base} style={{ marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-2)' }}>
                    {base}
                    {styleOf(selected, base) ? ` (${styleOf(selected, base)})` : ''}
                  </span>
                  <div style={{ ...rowStyle, marginTop: 3 }}>
                    {BOX_SIDES.map((side) => {
                      const prop = `${base}${side}`;
                      return (
                        <input
                          key={`${prop}-${selected.cssSelector ?? ''}`}
                          style={{ ...inputStyle, width: 0, flex: 1, textAlign: 'center' }}
                          defaultValue={styleOf(selected, prop)}
                          aria-label={`${base} ${side.toLowerCase()}`}
                          title={`${base}-${side.toLowerCase()}`}
                          placeholder="0"
                          onBlur={(e) => {
                            const v = toLength(e.target.value);
                            if (v && v !== styleOf(selected, prop)) applyEdit(prop, v);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              <label style={labelStyle}>
                Corner radius
                <input
                  style={inputStyle}
                  key={`br-${selected.cssSelector ?? ''}`}
                  defaultValue={styleOf(selected, 'borderRadius')}
                  placeholder="0"
                  onBlur={(e) => {
                    const v = toLength(e.target.value);
                    if (v && v !== styleOf(selected, 'borderRadius')) applyEdit('borderRadius', v);
                  }}
                />
              </label>
            </section>
          </fieldset>
        </>
      )}

      {batch.length > 0 && (
        <div
          role="group"
          aria-label="Pending visual changes"
          style={{
            marginTop: 'auto',
            paddingTop: 10,
            borderTop: '1px solid var(--border-0)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <span style={{ color: 'var(--text-0)' }}>
            {batch.length} visual {batch.length === 1 ? 'change' : 'changes'}
          </span>
          <div style={rowStyle}>
            <button type="button" className="btn btn--primary btn--s" disabled={saving} onClick={saveBatch}>
              {saving ? 'Sending…' : 'Save as instruction'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--s"
              disabled={saving}
              onClick={() => setBatch(clearVisualBatch())}
            >
              Discard
            </button>
          </div>
          <span style={{ color: 'var(--text-2)' }}>Reloading the preview resets unsaved visual tweaks.</span>
        </div>
      )}

      {status && (
        <p role="status" style={{ margin: 0, color: status.kind === 'ok' ? 'var(--ok)' : 'var(--err)' }}>
          {status.text}
        </p>
      )}
    </aside>
  );
}
