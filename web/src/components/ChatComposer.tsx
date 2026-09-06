import { useEffect, useMemo, useRef, useState } from 'react';
import type { MentionItem } from '../types';
import { enhancePrompt } from '../api';
import { errorMessage } from '../format';
import {
  createPromptQueue,
  drainOnePrompt,
  enqueuePrompt,
  removeQueuedPrompt,
  reorderQueuedPrompt,
  setPromptQueuePaused,
  type PromptQueue,
  type QueuedPrompt,
} from '../lib/pure';

/* ------------------------------------------------------------------ */
/* Pure helpers local to the composer. The prompt-queue reducers come */
/* from web/src/lib/pure.ts (WEBTYPES); these mention helpers are     */
/* composer-specific and stay here until pure.ts grows equivalents.   */
/* ------------------------------------------------------------------ */

export const QUEUE_CAP = 20;
export const QUEUE_PREVIEW_COUNT = 5;
export const MENTION_LIMIT = 8;

/** 'site' and 'preview' always exist, even before the build has files. */
export const MENTION_SPECIALS: readonly MentionItem[] = [
  { kind: 'site', label: 'site' },
  { kind: 'preview', label: 'preview' },
];

export interface MentionTrigger {
  /** Index of the '@' in the text. */
  start: number;
  /** Text between '@' and the caret (the partial mention being typed). */
  query: string;
}

/**
 * The '@' token currently being typed, if any: an '@' preceded by start or
 * whitespace, with only non-whitespace between it and the caret.
 */
export function activeMention(text: string, caret: number): MentionTrigger | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let i = pos;
  while (i > 0) {
    const ch = text.charAt(i - 1);
    if (ch === '@') {
      if (i - 1 === 0 || /\s/.test(text.charAt(i - 2))) {
        return { start: i - 1, query: text.slice(i, pos) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/** Specials first, then matching file paths, capped for the popover. */
export function mentionCandidates(files: readonly string[], query: string, limit = MENTION_LIMIT): MentionItem[] {
  const q = query.trim().toLowerCase();
  const uniqueFiles = [...new Set(files)].map((label): MentionItem => ({ kind: 'file', label }));
  const all = [...MENTION_SPECIALS, ...uniqueFiles];
  const matched = q === '' ? all : all.filter((item) => item.label.toLowerCase().includes(q));
  return matched.slice(0, limit);
}

/** The text actually sent: the draft plus one 'See <path>' line per mention. */
export function withMentions(draft: string, chips: readonly MentionItem[]): string {
  const base = draft.trim();
  if (chips.length === 0) return base;
  const refs = chips.map((c) => `See ${c.label}`).join('\n');
  return base === '' ? refs : `${base}\n\n${refs}`;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

interface ChatComposerProps {
  running: boolean;
  sending: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  /** File paths of the current build, offered as @-mentions. */
  mentionFiles: string[];
  onSend: (text: string) => Promise<boolean>;
  /** Cancel the running build, then send immediately. Enables 'Send now'. */
  onSendNow?: (text: string) => Promise<boolean>;
  /** Sender for auto-drained queued prompts (e.g. follow-up edit). Defaults to onSend. */
  onSendQueued?: (text: string) => Promise<boolean>;
  /** Extra gate for auto-draining (e.g. phase === 'DONE'); defaults to !running. */
  canDrain?: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement>;
}

export function ChatComposer({
  running,
  sending,
  draft,
  onDraftChange,
  mentionFiles,
  onSend,
  onSendNow,
  onSendQueued,
  canDrain,
  composerRef,
}: ChatComposerProps) {
  const [chips, setChips] = useState<MentionItem[]>([]);
  const [mention, setMention] = useState<{ query: string; active: number } | null>(null);
  const [queue, setQueue] = useState<PromptQueue>(createPromptQueue);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const queueIdRef = useRef(0);
  /** Mutex: a drain or interrupt send is in flight — do not start another. */
  const drainingRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);

  /* ------------------------- queue auto-drain ------------------------ */

  const drainAllowed = !running && !queue.paused && !sending && (canDrain ?? !running);

  useEffect(() => {
    if (!drainAllowed || drainingRef.current) return;
    const { queue: rest, next } = drainOnePrompt(queue);
    if (next === null) return;
    drainingRef.current = true;
    setQueue(rest);
    const sender = onSendQueued ?? onSend;
    void sender(next.text)
      .then((ok) => {
        if (!ok) {
          // Nothing may be lost: put the prompt back and stop draining so a
          // failing send cannot spin. The user resumes when ready.
          setQueue((q) => ({ ...q, items: [next, ...q.items], paused: true }));
          setComposerError('A queued prompt could not be sent — it is back at the front and the queue is paused.');
        }
      })
      .finally(() => {
        drainingRef.current = false;
      });
  }, [drainAllowed, queue, onSend, onSendQueued]);

  /* ----------------------------- mentions ---------------------------- */

  const mentionQuery = mention?.query ?? null;
  const candidates = useMemo(
    () => (mentionQuery === null ? [] : mentionCandidates(mentionFiles, mentionQuery)),
    [mentionQuery, mentionFiles],
  );

  useEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret !== null) {
      pendingCaretRef.current = null;
      composerRef.current?.setSelectionRange(caret, caret);
    }
  }, [draft, composerRef]);

  function refreshMention(text: string, caret: number) {
    const trig = activeMention(text, caret);
    setMention(trig ? { query: trig.query, active: 0 } : null);
  }

  function pickMention(item: MentionItem) {
    const ta = composerRef.current;
    const caret = ta?.selectionStart ?? draft.length;
    const trig = activeMention(draft, caret);
    setMention(null);
    if (!trig) return;
    setChips((c) => (c.some((x) => x.label === item.label) ? c : [...c, item]));
    pendingCaretRef.current = trig.start;
    onDraftChange(draft.slice(0, trig.start) + draft.slice(trig.start + 1 + trig.query.length));
    ta?.focus();
  }

  function removeChip(label: string) {
    setChips((c) => c.filter((x) => x.label !== label));
    composerRef.current?.focus();
  }

  /* ----------------------------- sending ----------------------------- */

  const hasContent = draft.trim() !== '' || chips.length > 0;
  const canPrimary = hasContent && !sending && !enhancing && !interrupting;

  function enqueue(text: string) {
    if (queue.items.length >= QUEUE_CAP) {
      setComposerError(`The queue is full (${QUEUE_CAP} prompts). Wait for it to drain or remove one.`);
      return;
    }
    queueIdRef.current += 1;
    setQueue((q) => enqueuePrompt(q, { id: `q${queueIdRef.current}`, text }));
    setComposerError(null);
    onDraftChange('');
    setChips([]);
  }

  async function primary() {
    if (!canPrimary) return;
    const text = withMentions(draft, chips);
    if (running) {
      enqueue(text);
      return;
    }
    setComposerError(null);
    const ok = await onSend(text);
    if (ok) {
      onDraftChange('');
      setChips([]);
    }
  }

  /** 'Send now': cancel the running build and send immediately (via the host). */
  async function interruptWith(text: string, onDone: (ok: boolean) => void) {
    if (!onSendNow || drainingRef.current) return;
    drainingRef.current = true;
    setInterrupting(true);
    setComposerError(null);
    try {
      const ok = await onSendNow(text);
      onDone(ok);
      if (!ok) setComposerError('Could not interrupt the build. Nothing was sent or removed.');
    } finally {
      drainingRef.current = false;
      setInterrupting(false);
    }
  }

  function sendDraftNow() {
    const text = withMentions(draft, chips);
    if (text === '' || !onSendNow) return;
    void interruptWith(text, (ok) => {
      if (ok) {
        onDraftChange('');
        setChips([]);
      }
    });
  }

  function sendQueuedNow(item: QueuedPrompt) {
    if (!onSendNow) return;
    void interruptWith(item.text, (ok) => {
      if (ok) setQueue((q) => removeQueuedPrompt(q, item.id));
    });
  }

  /* ------------------------------ enhance ---------------------------- */

  async function enhance() {
    const text = draft.trim();
    if (text === '' || enhancing || sending) return;
    setEnhancing(true);
    setComposerError(null);
    try {
      onDraftChange(await enhancePrompt(text));
      composerRef.current?.focus();
    } catch (e) {
      // Honest failure: the draft stays exactly as the user wrote it.
      setComposerError(errorMessage(e));
    } finally {
      setEnhancing(false);
    }
  }

  /* ------------------------------ keyboard --------------------------- */

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMention((m) =>
          m ? { ...m, active: (m.active + step + candidates.length) % candidates.length } : m,
        );
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        const choice = candidates[mention.active];
        if (choice) pickMention(choice);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (mention !== null) {
        e.preventDefault();
        setMention(null);
      }
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void primary();
      return;
    }
    if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      e.preventDefault();
      setChips((c) => c.slice(0, -1));
    }
  }

  function onQueueItemKeyDown(e: React.KeyboardEvent<HTMLLIElement>, id: string) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setQueue((q) => {
        const idx = q.items.findIndex((p) => p.id === id);
        if (idx < 0) return q;
        return reorderQueuedPrompt(q, id, idx + (e.key === 'ArrowUp' ? -1 : 1));
      });
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setQueue((q) => removeQueuedPrompt(q, id));
    }
  }

  /* ------------------------------- render ---------------------------- */

  const visibleQueue = queueExpanded ? queue.items : queue.items.slice(0, QUEUE_PREVIEW_COUNT);
  const hint = running
    ? `Build running — Ctrl+Enter queues the prompt (${queue.items.length}/${QUEUE_CAP})`
    : 'Ctrl+Enter to send — @ to mention files';

  return (
    <div className="composer">
      {chips.length > 0 && (
        <div className="composer-chips" role="group" aria-label="Attached mentions">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="mention-chip chip"
              tabIndex={0}
              aria-label={`Mention ${chip.label} — press Delete to remove`}
              onKeyDown={(e) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  removeChip(chip.label);
                }
              }}
            >
              @{chip.label}
              <button
                type="button"
                className="icon-btn mention-chip-x"
                aria-label={`Remove mention ${chip.label}`}
                onClick={() => removeChip(chip.label)}
                tabIndex={-1}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {mention !== null && (
        <ul className="mention-pop" role="listbox" aria-label="Mention a file" id="mention-listbox">
          {candidates.length === 0 && <li className="mention-empty muted">No matches</li>}
          {candidates.map((c, i) => (
            <li
              key={c.label}
              id={`mention-opt-${i}`}
              role="option"
              aria-selected={i === mention.active}
              className={`mention-option${i === mention.active ? ' mention-option--active' : ''}`}
              // mousedown so the textarea keeps focus and does not blur first
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(c);
              }}
            >
              <span className="mention-label">@{c.label}</span>
              {c.kind !== 'file' && (
                <span className="muted mention-hint">{c.kind === 'site' ? 'the whole site' : 'the live preview'}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={composerRef}
        className="composer-input"
        placeholder={running ? 'Queue a follow-up while the build runs…' : 'Describe the website you want…'}
        value={draft}
        onChange={(e) => {
          onDraftChange(e.target.value);
          setComposerError(null);
          refreshMention(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => refreshMention(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setMention(null)}
        onKeyDown={onKeyDown}
        disabled={sending}
        rows={3}
        aria-label="Website brief"
        aria-expanded={mention !== null}
        aria-controls={mention !== null ? 'mention-listbox' : undefined}
        aria-activedescendant={mention !== null && candidates.length > 0 ? `mention-opt-${mention.active}` : undefined}
      />

      {queue.items.length > 0 && (
        <div className="queue-panel" aria-label="Queued prompts">
          <div className="queue-head">
            <span className="muted">
              Queued {queue.items.length}/{QUEUE_CAP}
              {queue.paused ? ' — paused' : ''}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--s queue-toggle"
              onClick={() => setQueue((q) => setPromptQueuePaused(q, !q.paused))}
              aria-pressed={queue.paused}
            >
              {queue.paused ? 'Resume queue' : 'Pause queue'}
            </button>
          </div>
          <ul className="queue-list">
            {visibleQueue.map((item, i) => (
              <li
                key={item.id}
                className="queue-item"
                tabIndex={0}
                aria-label={`Queued prompt ${i + 1}: ${item.text}`}
                title="Alt+ArrowUp/Down to reorder, Delete to remove"
                onKeyDown={(e) => onQueueItemKeyDown(e, item.id)}
              >
                <span className="queue-text">{item.text}</span>
                {onSendNow && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--s queue-send-now"
                    disabled={interrupting || sending}
                    title="Cancel the running build and send this now"
                    onClick={() => sendQueuedNow(item)}
                  >
                    Send now
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn queue-remove"
                  aria-label={`Remove queued prompt ${i + 1}`}
                  onClick={() => setQueue((q) => removeQueuedPrompt(q, item.id))}
                >
                  x
                </button>
              </li>
            ))}
          </ul>
          {queue.items.length > QUEUE_PREVIEW_COUNT && (
            <button
              type="button"
              className="btn btn--ghost btn--s queue-more"
              onClick={() => setQueueExpanded((x) => !x)}
              aria-expanded={queueExpanded}
            >
              {queueExpanded ? 'Show fewer' : `Show all ${queue.items.length} queued`}
            </button>
          )}
        </div>
      )}

      <div className="composer-bar">
        <span className="muted composer-hint">{hint}</span>
        <div className="composer-actions">
          <button
            type="button"
            className="btn btn--ghost btn--s composer-wand"
            disabled={draft.trim() === '' || enhancing || sending}
            onClick={() => void enhance()}
            aria-label="Enhance prompt with AI"
            title="Enhance prompt with AI"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M2 14 L10 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              <path d="M11 1 l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="currentColor" />
            </svg>
            {enhancing ? 'Enhancing…' : 'Enhance'}
          </button>
          {running && onSendNow && (
            <button
              type="button"
              className="btn btn--ghost btn--s"
              disabled={!canPrimary}
              title="Cancel the running build and send this now"
              onClick={() => sendDraftNow()}
            >
              Send now
            </button>
          )}
          <button type="button" className="btn btn--primary" disabled={!canPrimary} onClick={() => void primary()}>
            {sending ? 'Starting…' : running ? 'Queue' : 'Build it'}
          </button>
        </div>
      </div>

      {composerError !== null && (
        <p className="composer-error inline-error" role="alert">
          {composerError}
        </p>
      )}
    </div>
  );
}
