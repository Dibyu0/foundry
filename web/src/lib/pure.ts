/**
 * Shared pure logic for the Foundry web UI -- import from here instead of
 * re-implementing. No DOM, no React, no imports: every function is a pure
 * reducer or mapper so it can be unit-tested and reused across components
 * (ChatColumn/ChatComposer, VisualEditorPanel, ConsoleTab, Workspace,
 * BuildsHistory). All reducers are immutable: they return the SAME reference
 * on a no-op so React can bail out of renders, and a new reference otherwise.
 */

/* ------------------------------------------------------------------ */
/* Prompt queue: prompts typed while a build is running wait in line;  */
/* when the build finishes the UI drains one at a time.                */
/* ------------------------------------------------------------------ */

export interface QueuedPrompt {
  id: string;
  text: string;
}

export interface PromptQueue {
  items: readonly QueuedPrompt[];
  paused: boolean;
}

export function createPromptQueue(): PromptQueue {
  return { items: [], paused: false };
}

/** Blank text or an already-queued id is a no-op (idempotent double-submit). */
export function enqueuePrompt(queue: PromptQueue, prompt: QueuedPrompt): PromptQueue {
  if (prompt.text.trim() === '') return queue;
  if (queue.items.some((p) => p.id === prompt.id)) return queue;
  return { ...queue, items: [...queue.items, prompt] };
}

export function removeQueuedPrompt(queue: PromptQueue, id: string): PromptQueue {
  if (!queue.items.some((p) => p.id === id)) return queue;
  return { ...queue, items: queue.items.filter((p) => p.id !== id) };
}

/** Moves the prompt with `id` to `toIndex`, clamped into range. */
export function reorderQueuedPrompt(queue: PromptQueue, id: string, toIndex: number): PromptQueue {
  const from = queue.items.findIndex((p) => p.id === id);
  if (from < 0) return queue;
  const to = Math.max(0, Math.min(Math.trunc(toIndex), queue.items.length - 1));
  if (to === from) return queue;
  const items = [...queue.items];
  const moved = items[from];
  if (moved === undefined) return queue;
  items.splice(from, 1);
  items.splice(to, 0, moved);
  return { ...queue, items };
}

/**
 * Pops the head prompt for sending. Paused or empty queues drain nothing and
 * return the same reference so callers can tell "nothing to send" apart.
 */
export function drainOnePrompt(queue: PromptQueue): { queue: PromptQueue; next: QueuedPrompt | null } {
  if (queue.paused || queue.items.length === 0) return { queue, next: null };
  const [next, ...rest] = queue.items;
  return { queue: { ...queue, items: rest }, next: next ?? null };
}

export function setPromptQueuePaused(queue: PromptQueue, paused: boolean): PromptQueue {
  if (queue.paused === paused) return queue;
  return { ...queue, paused };
}

/* ------------------------------------------------------------------ */
/* Mention chips: "@role" / "@file" tokens inside composer text. A     */
/* token only counts at the start of the text or right after           */
/* whitespace, so emails (foo@bar.com) are left alone.                 */
/* ------------------------------------------------------------------ */

export interface MentionParse {
  /** Mention tokens without the '@', first occurrence wins, in order. */
  mentions: string[];
  /** The text with mention tokens removed and whitespace collapsed. */
  restText: string;
}

const MENTION_RE = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9._/-]*)/g;

export function parseMentions(text: string): MentionParse {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const rest = text.replace(MENTION_RE, (_match, token: string) => {
    // A trailing '.' or '/' is sentence punctuation or a dangling path sep.
    const cleaned = token.replace(/[./]+$/g, '');
    if (cleaned !== '') {
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push(cleaned);
      }
    }
    return ' ';
  });
  return { mentions, restText: rest.replace(/\s+/g, ' ').trim() };
}

/* ------------------------------------------------------------------ */
/* Visual edit batch: point-and-click changes accumulate, then ship    */
/* as one natural-language instruction to POST /api/builds/:id/edit.   */
/* ------------------------------------------------------------------ */

export interface VisualEditChange {
  id: string;
  /** CSS selector (or element path) of the edited element. */
  selector: string;
  /** Human-readable element name, e.g. "Hero title". */
  label?: string;
  /** 'text'/'textContent' for copy edits, otherwise a CSS property. */
  property: string;
  value: string;
  previousValue?: string;
}

export type VisualEditBatch = readonly VisualEditChange[];

/**
 * Latest change wins per (selector, property) -- re-editing the same
 * element's color replaces the earlier edit instead of stacking, so the
 * instruction sent to the agent never contradicts itself.
 */
export function applyVisualChange(batch: VisualEditBatch, change: VisualEditChange): VisualEditBatch {
  const byId = batch.findIndex((c) => c.id === change.id);
  if (byId >= 0) return batch.map((c, i) => (i === byId ? change : c));
  const sameTarget = batch.findIndex((c) => c.selector === change.selector && c.property === change.property);
  if (sameTarget >= 0) return batch.map((c, i) => (i === sameTarget ? change : c));
  return [...batch, change];
}

export function removeVisualChange(batch: VisualEditBatch, id: string): VisualEditBatch {
  if (!batch.some((c) => c.id === id)) return batch;
  return batch.filter((c) => c.id !== id);
}

export function clearVisualBatch(): VisualEditBatch {
  return [];
}

/** Renders the batch as one numbered instruction; '' when there is nothing to send. */
export function visualBatchToInstruction(batch: VisualEditBatch): string {
  if (batch.length === 0) return '';
  const lines = batch.map((c, i) => {
    const target = c.label !== undefined && c.label !== '' ? `${c.label} (${c.selector})` : c.selector;
    const what = c.property === 'text' || c.property === 'textContent' ? 'text' : c.property;
    const prev = c.previousValue !== undefined ? ` (was "${c.previousValue}")` : '';
    return `${i + 1}. ${target}: set ${what} to "${c.value}"${prev}.`;
  });
  return `Apply these visual edits to the site:\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Console feed: preview console messages stream in over the bridge.   */
/* Repeats collapse into a count badge; the feed is capped so a noisy  */
/* page cannot grow memory without bound.                              */
/* ------------------------------------------------------------------ */

export const CONSOLE_FEED_CAP = 500;

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntryInput {
  id: string;
  level: ConsoleLevel;
  text: string;
  ts: number;
  source?: string;
  line?: number;
}

export interface ConsoleEntry extends ConsoleEntryInput {
  /** 1 + number of repeats collapsed into this entry. */
  count: number;
  signature: string;
}

export interface ConsoleFeed {
  entries: readonly ConsoleEntry[];
  /** While paused, incoming entries are dropped (the feed freezes as shown). */
  paused: boolean;
  /** How many entries the cap has dropped so far -- shown honestly in the UI. */
  truncated: number;
}

/** Newline-joined so no field combination can collide with another. */
export function consoleSignature(level: string, text: string, source?: string, line?: number): string {
  return `${level}\n${source ?? ''}\n${line ?? ''}\n${text}`;
}

export function createConsoleFeed(): ConsoleFeed {
  return { entries: [], paused: false, truncated: 0 };
}

/**
 * Appends one entry. A repeat (same signature) instead bumps the existing
 * entry's count, refreshes its ts, and moves it to the end -- the feed stays
 * ordered by last occurrence and the original id keeps its React key stable.
 */
export function appendConsoleEntry(feed: ConsoleFeed, input: ConsoleEntryInput): ConsoleFeed {
  if (feed.paused) return feed;
  const signature = consoleSignature(input.level, input.text, input.source, input.line);
  const existing = feed.entries.findIndex((e) => e.signature === signature);
  let entries: ConsoleEntry[];
  if (existing >= 0) {
    const prev = feed.entries[existing];
    if (prev === undefined) return feed;
    const bumped: ConsoleEntry = { ...prev, count: prev.count + 1, ts: input.ts };
    entries = [...feed.entries.slice(0, existing), ...feed.entries.slice(existing + 1), bumped];
  } else {
    entries = [...feed.entries, { ...input, count: 1, signature }];
  }
  let truncated = feed.truncated;
  if (entries.length > CONSOLE_FEED_CAP) {
    const overflow = entries.length - CONSOLE_FEED_CAP;
    entries = entries.slice(overflow);
    truncated += overflow;
  }
  return { ...feed, entries, truncated };
}

export function setConsoleFeedPaused(feed: ConsoleFeed, paused: boolean): ConsoleFeed {
  if (feed.paused === paused) return feed;
  return { ...feed, paused };
}

/** Clears entries and the truncated counter; the pause state survives. */
export function clearConsoleFeed(feed: ConsoleFeed): ConsoleFeed {
  if (feed.entries.length === 0 && feed.truncated === 0) return feed;
  return { ...feed, entries: [], truncated: 0 };
}

/* ------------------------------------------------------------------ */
/* Device widths: preview-stage presets. The pixel values mirror the   */
/* .w--* rules in styles.css -- change both together. null = fluid.    */
/* ------------------------------------------------------------------ */

export type DeviceId = 'mobile' | 'tablet' | 'desktop';

export const DEVICE_IDS: readonly DeviceId[] = ['mobile', 'tablet', 'desktop'];

export const DEVICE_WIDTHS: Readonly<Record<DeviceId, number | null>> = {
  mobile: 390,
  tablet: 768,
  desktop: null,
};

export function isDeviceId(value: unknown): value is DeviceId {
  return value === 'mobile' || value === 'tablet' || value === 'desktop';
}

export function deviceWidth(id: DeviceId): number | null {
  return DEVICE_WIDTHS[id];
}

export function deviceStageClass(id: DeviceId): string {
  return `w--${id}`;
}

/** Bucket boundaries for classifying an arbitrary viewport width. */
const MOBILE_MAX_PX = 639;
const TABLET_MAX_PX = 1099;

export function deviceForWidth(px: number): DeviceId {
  if (!Number.isFinite(px) || px <= MOBILE_MAX_PX) return 'mobile';
  if (px <= TABLET_MAX_PX) return 'tablet';
  return 'desktop';
}
