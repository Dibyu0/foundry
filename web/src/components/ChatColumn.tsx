import { Children, isValidElement, memo, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { ROLE_LABELS, asRoleId } from '../types';
import type { ReactNode } from 'react';
import { formatTime } from '../format';
import { ChatComposer } from './ChatComposer';
import { QuestionCard } from './QuestionCard';
import { Logo } from './Logo';

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
  /** Role currently working (from SSE activity, e.g. 'builder'); shown in the activity rail. */
  activeRole?: string | null;
  /** What the active role is doing (e.g. 'writing styles.css'); shown in the activity rail. */
  activityNote?: string | null;
  /** Card pinned above the thread (e.g. the pending question). When provided, the
   *  auto-hoist of QuestionCard children into the pinned region is disabled. */
  pinned?: ReactNode;
  children?: ReactNode;
}

const NO_FILES: string[] = [];

/** Distance from the bottom (px) within which the thread stays glued to latest. */
const STICK_THRESHOLD_PX = 56;

const SUGGESTIONS = [
  'A landing page for a small coffee roastery with a menu and a contact form',
  'A portfolio site for a freelance illustrator with a project gallery',
  'A docs-style site for a CLI tool with a sidebar and code examples',
];

/* ------------------------------------------------------------------ */
/* Pure view helpers                                                    */
/* ------------------------------------------------------------------ */

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToBottom(el: HTMLDivElement, smooth: boolean): void {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
}

/** Fallback cap for a programmatic smooth-scroll. The flag is also released
 *  by the scroll event that lands at the bottom, so this timer only matters
 *  when no landing event ever arrives (e.g. the list could not scroll). */
export const PROGRAM_SCROLL_FALLBACK_MS = 600;

/** How one scroll event may change the stuck-to-bottom flag. `stuck: null`
 *  means the event is ignored: it is an intermediate frame of our own
 *  smooth-scroll animation, not user intent. `release` ends the programmatic
 *  scroll - either it landed, or a user gesture took over mid-flight. */
export function resolveScrollStuck(input: {
  atBottom: boolean;
  programmatic: boolean;
  gesture: boolean;
}): { stuck: boolean | null; release: boolean } {
  if (input.programmatic && !input.gesture) {
    return { stuck: null, release: input.atBottom };
  }
  return { stuck: input.atBottom, release: input.programmatic };
}

/** Keys that scroll the focused list. Only they count as a keyboard scroll
 *  gesture - Tab/Enter inside inline cards must not. */
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** ChatMessage.ts may be seconds or milliseconds (format.ts has the same rule). */
function toISO(ts: number): string {
  return new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
}

/** Display label for an agent slug: the shared role label when known, else a
 *  capitalized form of whatever the server sent. */
function roleLabel(agent: string | undefined): string {
  if (!agent) return 'Foundry';
  const id = asRoleId(agent);
  if (id) return ROLE_LABELS[id];
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function isQuestionElement(node: ReactNode): boolean {
  return isValidElement(node) && node.type === QuestionCard;
}

/* ------------------------------------------------------------------ */
/* Inline role icons (swap for ./icons once BRAND lands icons.tsx)     */
/* ------------------------------------------------------------------ */

function RoleIcon({ role }: { role: string | null }) {
  const id = role ? asRoleId(role) : null;
  const common = {
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  } as const;
  switch (id) {
    case 'planner':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M10.2 5.8 9 9l-3.2 1.2L7 7z" />
        </svg>
      );
    case 'design':
      return (
        <svg {...common}>
          <path d="M9.6 2.7l3.7 3.7-7.1 7.1H2.5V9.8z" />
          <path d="M8 4.3l3.7 3.7" />
        </svg>
      );
    case 'copy':
      return (
        <svg {...common}>
          <path d="M3 4.5h10" />
          <path d="M3 8h10" />
          <path d="M3 11.5h6" />
        </svg>
      );
    case 'builder':
      return (
        <svg {...common}>
          <path d="M6 4.5 2.5 8 6 11.5" />
          <path d="M10 4.5 13.5 8 10 11.5" />
        </svg>
      );
    case 'reviewer':
      return (
        <svg {...common}>
          <path d="M8 2.5 12.5 4v3.4c0 3-1.9 5-4.5 6.1-2.6-1.1-4.5-3.1-4.5-6.1V4z" />
          <path d="M5.9 8.1 7.4 9.6 10.2 6.8" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7z" />
        </svg>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Thread pieces                                                        */
/* ------------------------------------------------------------------ */

const ThreadMessage = memo(function ThreadMessage({ m }: { m: ChatMessage }) {
  if (m.role === 'system') {
    return (
      <div className="thread-divider">
        <span className="thread-divider-line" aria-hidden="true" />
        <span className="thread-divider-text">{m.text}</span>
        <span className="thread-divider-line" aria-hidden="true" />
      </div>
    );
  }

  if (m.role === 'user') {
    return (
      <div className="thread-row thread-row--user">
        <div className="bubble bubble--user">
          <div className="bubble-text">{m.text}</div>
          {m.ts !== undefined && (
            <div className="bubble-meta bubble-meta--end">
              <time className="bubble-time" dateTime={toISO(m.ts)}>
                {formatTime(m.ts)}
              </time>
            </div>
          )}
        </div>
      </div>
    );
  }

  const roleId = asRoleId(m.agent ?? '') ?? 'foundry';
  return (
    <div className="thread-row thread-row--agent">
      <span className="role-avatar" data-role={roleId} aria-hidden="true">
        <RoleIcon role={m.agent ?? null} />
      </span>
      <div className="bubble bubble--agent">
        <div className="bubble-meta">
          <span className="bubble-author">{roleLabel(m.agent)}</span>
          {m.ts !== undefined && (
            <time className="bubble-time" dateTime={toISO(m.ts)}>
              {formatTime(m.ts)}
            </time>
          )}
        </div>
        <div className="bubble-text">{m.text}</div>
      </div>
    </div>
  );
});

interface RailState {
  text: string;
  role: string | null;
}

/** What the slim rail above the composer announces. Explicit activity props
 *  win; while a build runs we fall back to the most recent agent speaker, and
 *  a bare 'Foundry' when nobody has spoken yet. Null when idle - the rail is
 *  hidden rather than faking progress. */
function deriveRail(
  running: boolean,
  sending: boolean,
  activeRole: string | null | undefined,
  activityNote: string | null | undefined,
  messages: readonly ChatMessage[],
): RailState | null {
  const note = activityNote?.trim() ?? '';
  if (activeRole) {
    return {
      text: note !== '' ? `${roleLabel(activeRole)} is ${note}` : `${roleLabel(activeRole)} is working`,
      role: activeRole,
    };
  }
  if (note !== '') return { text: note, role: null };
  if (running) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'agent') return { text: `${roleLabel(m.agent)} is working`, role: m.agent ?? null };
    }
    return { text: 'Foundry is working', role: null };
  }
  if (sending) return { text: 'Sending your brief', role: null };
  return null;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

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
  activeRole = null,
  activityNote = null,
  pinned,
  children,
}: ChatColumnProps) {
  const [brief, setBrief] = useState('');
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const countRef = useRef(messages.length);
  const feedRef = useRef(feedKey);
  /** True while a programmatic smooth-scroll is animating; its intermediate
   *  scroll events are animation frames, not user intent, and must not
   *  flip `stuck`. */
  const programScrollRef = useRef(false);
  /** Fallback releasing programScrollRef when no landing scroll event arrives. */
  const programTimerRef = useRef<number | undefined>(undefined);
  /** A user scroll gesture (wheel/touch/scroll-key) since the programmatic
   *  scroll began - that user takes over and may change `stuck`. */
  const scrollGestureRef = useRef(false);

  /* --------------------- auto-scroll + unread count ------------------- */

  function endProgramScroll() {
    programScrollRef.current = false;
    window.clearTimeout(programTimerRef.current);
  }

  function beginProgramScroll(el: HTMLDivElement, smooth: boolean) {
    scrollGestureRef.current = false;
    programScrollRef.current = true;
    window.clearTimeout(programTimerRef.current);
    programTimerRef.current = window.setTimeout(() => {
      programScrollRef.current = false;
    }, PROGRAM_SCROLL_FALLBACK_MS);
    scrollToBottom(el, smooth);
  }

  useEffect(() => () => window.clearTimeout(programTimerRef.current), []);

  useEffect(() => {
    const el = listRef.current;
    const prev = countRef.current;
    const feedChanged = feedRef.current !== feedKey;
    countRef.current = messages.length;
    feedRef.current = feedKey;

    if (messages.length < prev) {
      // Conversation switched or was reset: snap to latest, clear the pill.
      stuckRef.current = true;
      setStuck(true);
      setUnread(0);
      if (el) beginProgramScroll(el, false);
      return;
    }
    if (!el) return;
    if (stuckRef.current) {
      beginProgramScroll(el, messages.length > prev || feedChanged);
      if (unread !== 0) setUnread(0);
    } else if (messages.length > prev) {
      setUnread((u) => u + (messages.length - prev));
    }
  }, [messages.length, feedKey, unread]);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    const r = resolveScrollStuck({
      atBottom,
      programmatic: programScrollRef.current,
      gesture: scrollGestureRef.current,
    });
    if (r.release) endProgramScroll();
    if (r.stuck === null) return;
    stuckRef.current = r.stuck;
    setStuck(r.stuck);
    if (r.stuck) setUnread(0);
  }

  function markScrollGesture() {
    scrollGestureRef.current = true;
  }

  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (SCROLL_KEYS.has(e.key)) markScrollGesture();
  }

  function jumpToLatest() {
    const el = listRef.current;
    stuckRef.current = true;
    setStuck(true);
    setUnread(0);
    if (el) {
      beginProgramScroll(el, true);
      // The pill unmounts on click; keep keyboard focus inside the thread.
      el.focus({ preventScroll: true });
    }
  }

  /* ------------------- pinned question + thread flow ------------------ */

  // The pending-question card never scrolls away: a QuestionCard passed as a
  // child is hoisted into the pinned region. Passing the explicit `pinned`
  // prop (the integrator's preferred wiring) disables the hoist.
  const kids = Children.toArray(children);
  const pinnedProvided = pinned !== undefined && pinned !== null && typeof pinned !== 'boolean';
  const hoisted = pinnedProvided ? [] : kids.filter(isQuestionElement);
  const flow = pinnedProvided ? kids : kids.filter((k) => !isQuestionElement(k));
  const pinnedContent = pinnedProvided ? pinned : hoisted.length > 0 ? hoisted : null;

  const rail = deriveRail(running, sending, activeRole, activityNote, messages);

  return (
    <div className="chat-inner">
      {pinnedContent !== null && (
        <div className="chat-pin" role="region" aria-label="Question that needs your answer">
          <div className="chat-pin-kicker">
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8.8 1.5 3.5 9h3.1l-.8 5.5L11.1 7H8z" />
            </svg>
            Answer to keep the build moving
          </div>
          <div className="chat-pin-body">{pinnedContent}</div>
        </div>
      )}

      <div className="chat-scroll">
        <div
          className="messages"
          ref={listRef}
          onScroll={onListScroll}
          onWheel={markScrollGesture}
          onTouchStart={markScrollGesture}
          onKeyDown={onListKeyDown}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Conversation"
          tabIndex={0}
        >
          {!hasBuild && messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-mark" aria-hidden="true">
                <Logo size={30} />
              </div>
              <p className="welcome-lede">What should we build?</p>
              <p className="welcome-sub">
                Describe the site in a sentence. Foundry plans it, designs it, and ships it.
              </p>
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
            <ThreadMessage key={i} m={m} />
          ))}

          {flow}
        </div>

        {!stuck && (
          <button
            type="button"
            className="jump-latest"
            onClick={jumpToLatest}
            aria-label={
              unread > 0 ? `Jump to the latest message, ${unread} new` : 'Jump to the latest message'
            }
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 3.5v9" />
              <path d="M4.5 9 8 12.5 11.5 9" />
            </svg>
            <span className="jump-latest-label">Latest</span>
            {unread > 0 && <span className="jump-latest-count">{unread > 99 ? '99+' : unread}</span>}
          </button>
        )}
      </div>

      {rail !== null && (
        <div className="activity-rail" role="status">
          <span
            className="role-avatar role-avatar--rail"
            data-role={rail.role ? (asRoleId(rail.role) ?? 'foundry') : 'foundry'}
            aria-hidden="true"
          >
            <RoleIcon role={rail.role} />
          </span>
          <span className="activity-rail-text">{rail.text}</span>
          <span className="activity-rail-dots" aria-hidden="true">
            <span className="activity-rail-dot" />
            <span className="activity-rail-dot" />
            <span className="activity-rail-dot" />
          </span>
        </div>
      )}

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
