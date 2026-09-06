import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import type { ReactNode } from 'react';
import { ChatComposer } from './ChatComposer';

interface ChatColumnProps {
  hasBuild: boolean;
  running: boolean;
  messages: ChatMessage[];
  sending: boolean;
  onSend: (brief: string) => Promise<boolean>;
  /** Cancel the running build, then send immediately. Enables 'Send now' on queued items and the draft. */
  onSendNow?: (brief: string) => Promise<boolean>;
  /** Sender for auto-drained queued prompts (e.g. a follow-up edit). Defaults to onSend. */
  onSendQueued?: (text: string) => Promise<boolean>;
  /** Extra gate for queue auto-draining (e.g. phase === 'DONE'); defaults to !running. */
  canDrain?: boolean;
  /** File paths of the current build, offered as @-mentions in the composer. */
  mentionFiles?: string[];
  composerRef: React.RefObject<HTMLTextAreaElement>;
  /** changes when inline cards (question/plan) appear or disappear */
  feedKey: string;
  children?: ReactNode;
}

const NO_FILES: string[] = [];

const SUGGESTIONS = [
  'A landing page for a small coffee roastery with a menu and a contact form',
  'A portfolio site for a freelance illustrator with a project gallery',
  'A docs-style site for a CLI tool with a sidebar and code examples',
];

export function ChatColumn({
  hasBuild,
  running,
  messages,
  sending,
  onSend,
  onSendNow,
  onSendQueued,
  canDrain,
  mentionFiles = NO_FILES,
  composerRef,
  feedKey,
  children,
}: ChatColumnProps) {
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
                    disabled={sending}
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

      <ChatComposer
        running={running}
        sending={sending}
        draft={brief}
        onDraftChange={setBrief}
        mentionFiles={mentionFiles}
        onSend={onSend}
        onSendNow={onSendNow}
        onSendQueued={onSendQueued}
        canDrain={canDrain}
        composerRef={composerRef}
      />
    </div>
  );
}
