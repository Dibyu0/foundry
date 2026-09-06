import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import type { ReactNode } from 'react';

interface ChatColumnProps {
  hasBuild: boolean;
  running: boolean;
  messages: ChatMessage[];
  sending: boolean;
  onSend: (brief: string) => Promise<boolean>;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  /** changes when inline cards (question/plan) appear or disappear */
  feedKey: string;
  children?: ReactNode;
}

const SUGGESTIONS = [
  'A landing page for a small coffee roastery with a menu and a contact form',
  'A portfolio site for a freelance illustrator with a project gallery',
  'A docs-style site for a CLI tool with a sidebar and code examples',
];

export function ChatColumn({ hasBuild, running, messages, sending, onSend, composerRef, feedKey, children }: ChatColumnProps) {
  const [brief, setBrief] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, feedKey]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  const canSend = brief.trim().length > 0 && !sending && !running;

  async function send() {
    if (!canSend) return;
    const text = brief.trim();
    const ok = await onSend(text);
    if (ok) setBrief('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="chat-inner">
      <div className="messages" ref={listRef} onScroll={onListScroll} aria-label="Conversation" aria-live="polite">
        {!hasBuild && messages.length === 0 && (
          <div className="welcome">
            <p className="welcome-lede">What should we build?</p>
            <ul className="suggestions">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    className="suggestion"
                    disabled={sending || running}
                    onClick={() => {
                      setBrief(s);
                      composerRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>
            {m.role === 'agent' && <div className="msg-meta">{m.agent ?? 'foundry'}</div>}
            <div className="msg-text">{m.text}</div>
          </div>
        ))}

        {children}
      </div>

      <div className="composer">
        <textarea
          ref={composerRef}
          className="composer-input"
          placeholder={running ? 'A build is running…' : 'Describe the website you want…'}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running || sending}
          rows={3}
          aria-label="Website brief"
        />
        <div className="composer-bar">
          <span className="muted composer-hint">
            {running ? 'Cancel or wait for the build to finish' : 'Ctrl+Enter to send'}
          </span>
          <button type="button" className="btn btn--primary" disabled={!canSend} onClick={() => void send()}>
            {sending ? 'Starting…' : 'Build it'}
          </button>
        </div>
      </div>
    </div>
  );
}
