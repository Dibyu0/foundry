/**
 * Parent-side channel for the Foundry preview bridge.
 *
 * Wire protocol counterpart of server/src/previewInject.ts (INJECT_SCRIPT) —
 * keep the message shapes in sync with that file. The preview iframe runs
 * sandboxed with an opaque origin, so postMessage targetOrigin is always '*'
 * and inbound events arrive with origin 'null'; authenticity comes from the
 * `source` tag plus (where it matters) `event.source === iframe.contentWindow`.
 */

export const PREVIEW_SOURCE = 'foundry-preview';
export const APP_SOURCE = 'foundry-app';
export const PREVIEW_FEED_LIMIT = 200;

export type ConsoleLevel = 'log' | 'warn' | 'error';

export interface PreviewMessageBase {
  source: typeof PREVIEW_SOURCE;
  ts: number;
}

export interface ConsoleEntry extends PreviewMessageBase {
  kind: 'console';
  level: ConsoleLevel;
  text: string;
}

export interface ErrorEntry extends PreviewMessageBase {
  kind: 'error';
  message: string;
  file?: string;
  line?: number;
  col?: number;
  stack?: string;
}

export interface NetworkEntry extends PreviewMessageBase {
  kind: 'network';
  method: string;
  url: string;
  status?: number;
  ok: boolean;
  durationMs?: number;
  error?: string;
  initiator?: string;
  via?: 'fetch' | 'xhr' | 'resource' | 'performance';
}

/** Ring-buffered feed entries: the kinds ConsoleTab renders. */
export type PreviewEntry = ConsoleEntry | ErrorEntry | NetworkEntry;

export interface InspectedStyles {
  color: string;
  backgroundColor: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  margin: string;
  padding: string;
  borderRadius: string;
}

export interface InspectedElement {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  styles: InspectedStyles;
  /** Human-readable path: /html[1]/body[1]/div[2] or /#id/... */
  xpath: string;
  /** Valid CSS selector path (nth-of-type chain) — round-trip target for applyStyle. */
  selector: string;
}

export interface ReadyMessage extends PreviewMessageBase {
  kind: 'ready';
  href: string;
}

export interface BufferMessage extends PreviewMessageBase {
  kind: 'buffer';
  entries: PreviewEntry[];
}

export interface InspectHoverMessage extends PreviewMessageBase {
  kind: 'inspect-hover';
  element: InspectedElement;
}

export interface InspectSelectMessage extends PreviewMessageBase {
  kind: 'inspect-select';
  element: InspectedElement;
}

export interface InspectStateMessage extends PreviewMessageBase {
  kind: 'inspect-state';
  armed: boolean;
}

export interface StyleAppliedMessage extends PreviewMessageBase {
  kind: 'style-applied';
  ok: boolean;
  selector: string;
  prop: string;
  value: string;
  applied?: string;
  error?: string;
  requestId?: string;
}

export type PreviewMessage =
  | PreviewEntry
  | ReadyMessage
  | BufferMessage
  | InspectHoverMessage
  | InspectSelectMessage
  | InspectStateMessage
  | StyleAppliedMessage;

export type PreviewMessageKind = PreviewMessage['kind'];

export type PreviewCommand =
  | { source: typeof APP_SOURCE; kind: 'foundry:inspect'; armed: boolean }
  | { source: typeof APP_SOURCE; kind: 'foundry:applyStyle'; selector: string; prop: string; value: string; requestId: string }
  | { source: typeof APP_SOURCE; kind: 'foundry:pull' };

// --- type guards -------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isConsoleEntry(value: unknown): value is ConsoleEntry {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'console' &&
    (value.level === 'log' || value.level === 'warn' || value.level === 'error') &&
    typeof value.text === 'string' &&
    typeof value.ts === 'number'
  );
}

export function isErrorEntry(value: unknown): value is ErrorEntry {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'error' &&
    typeof value.message === 'string' &&
    typeof value.ts === 'number'
  );
}

export function isNetworkEntry(value: unknown): value is NetworkEntry {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'network' &&
    typeof value.method === 'string' &&
    typeof value.url === 'string' &&
    typeof value.ok === 'boolean' &&
    typeof value.ts === 'number'
  );
}

export function isPreviewEntry(value: unknown): value is PreviewEntry {
  return isConsoleEntry(value) || isErrorEntry(value) || isNetworkEntry(value);
}

export function isInspectedElement(value: unknown): value is InspectedElement {
  if (!isRecord(value)) return false;
  if (typeof value.tag !== 'string' || typeof value.id !== 'string') return false;
  if (!Array.isArray(value.classes) || !value.classes.every((c) => typeof c === 'string')) return false;
  if (typeof value.text !== 'string' || typeof value.xpath !== 'string') return false;
  if (typeof value.selector !== 'string') return false;
  if (!isRecord(value.styles)) return false;
  const styles = value.styles;
  const props: Array<keyof InspectedStyles> = [
    'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'margin', 'padding', 'borderRadius',
  ];
  return props.every((prop) => typeof styles[prop] === 'string');
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'ready' &&
    typeof value.href === 'string'
  );
}

export function isBufferMessage(value: unknown): value is BufferMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'buffer' &&
    Array.isArray(value.entries) &&
    value.entries.every(isPreviewEntry)
  );
}

export function isInspectHoverMessage(value: unknown): value is InspectHoverMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'inspect-hover' &&
    isInspectedElement(value.element)
  );
}

export function isInspectSelectMessage(value: unknown): value is InspectSelectMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'inspect-select' &&
    isInspectedElement(value.element)
  );
}

export function isInspectStateMessage(value: unknown): value is InspectStateMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'inspect-state' &&
    typeof value.armed === 'boolean'
  );
}

export function isStyleAppliedMessage(value: unknown): value is StyleAppliedMessage {
  return (
    isRecord(value) &&
    value.source === PREVIEW_SOURCE &&
    value.kind === 'style-applied' &&
    typeof value.ok === 'boolean' &&
    typeof value.selector === 'string' &&
    typeof value.prop === 'string' &&
    typeof value.value === 'string'
  );
}

export function isPreviewMessage(value: unknown): value is PreviewMessage {
  return (
    isPreviewEntry(value) ||
    isReadyMessage(value) ||
    isBufferMessage(value) ||
    isInspectHoverMessage(value) ||
    isInspectSelectMessage(value) ||
    isInspectStateMessage(value) ||
    isStyleAppliedMessage(value)
  );
}

// --- postToPreview -----------------------------------------------------------

/**
 * Send a command to the preview iframe. Returns false when the iframe has no
 * contentWindow yet (not mounted) so callers can retry instead of dropping the
 * command silently. Note the bridge script itself is only installed once the
 * preview document parses; before the first 'ready' message, posted commands
 * may still be lost — arm inspect mode from the iframe's load event.
 */
export function postToPreview(
  iframe: HTMLIFrameElement | null | undefined,
  command: PreviewCommand,
): boolean {
  const target = iframe?.contentWindow;
  if (!target) return false;
  target.postMessage(command, '*');
  return true;
}

// --- subscribePreview --------------------------------------------------------

export type PreviewListener = (message: PreviewMessage, event: MessageEvent) => void;

/**
 * Listen for bridge messages from any preview iframe on this page. Accepts the
 * app origin and the 'null' origin of sandboxed iframes; everything failing
 * the protocol guards is dropped. Returns the unsubscribe function.
 */
export function subscribePreview(listener: PreviewListener): () => void {
  const handler = (event: MessageEvent): void => {
    if (event.origin !== 'null' && event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!isPreviewMessage(data)) return;
    listener(data, event);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// --- ring buffer feed store --------------------------------------------------

export interface PreviewFeed {
  readonly size: number;
  push(entry: PreviewEntry): void;
  /** Fold a bridge message into the feed: live entries and 'buffer' replays. */
  ingest(message: PreviewMessage): void;
  /** Snapshot in arrival order, oldest first. Stable reference until the next mutation. */
  entries(): readonly PreviewEntry[];
  clear(): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Ring buffer holding the last `limit` feed entries. The backing array is
 * replaced (not mutated) on every change so the snapshot works with
 * useSyncExternalStore.
 */
export function createPreviewFeed(limit = PREVIEW_FEED_LIMIT): PreviewFeed {
  let items: readonly PreviewEntry[] = [];
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    get size() {
      return items.length;
    },
    push(entry) {
      const next = items.length >= limit ? items.slice(items.length - limit + 1) : items.slice();
      next.push(entry);
      items = next;
      emit();
    },
    ingest(message) {
      if (isPreviewEntry(message)) {
        this.push(message);
      } else if (isBufferMessage(message)) {
        for (const entry of message.entries) this.push(entry);
      }
    },
    entries() {
      return items;
    },
    clear() {
      if (items.length === 0) return;
      items = [];
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// --- inspect mode controller -------------------------------------------------

export interface InspectModeController {
  isActive(): boolean;
  /** Returns false when the iframe is not mounted; state stays disarmed. */
  arm(): boolean;
  disarm(): void;
  /** Returns the resulting state. */
  toggle(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
  destroy(): void;
}

/**
 * Arms/disarms click-to-inspect in the preview. Escape (in either frame)
 * disarms; child-initiated disarms (Escape or a completed selection) are
 * synced back via 'inspect-state'. When the preview reloads while armed, the
 * controller re-arms once the fresh bridge reports 'ready' — getIframe is a
 * callback so the controller survives React recreating the iframe element.
 */
export function createInspectMode(getIframe: () => HTMLIFrameElement | null): InspectModeController {
  let active = false;
  const listeners = new Set<(active: boolean) => void>();

  const emit = (): void => {
    for (const listener of listeners) listener(active);
  };

  const command = (armed: boolean): PreviewCommand => ({ source: APP_SOURCE, kind: 'foundry:inspect', armed });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') controller.disarm();
  };

  const unsubscribe = subscribePreview((message) => {
    if (isReadyMessage(message) && active) {
      postToPreview(getIframe(), command(true));
    } else if (isInspectStateMessage(message) && !message.armed && active) {
      active = false;
      window.removeEventListener('keydown', onKeyDown);
      emit();
    }
  });

  const controller: InspectModeController = {
    isActive: () => active,
    arm() {
      if (active) return true;
      if (!postToPreview(getIframe(), command(true))) return false;
      active = true;
      window.addEventListener('keydown', onKeyDown);
      emit();
      return true;
    },
    disarm() {
      if (!active) return;
      postToPreview(getIframe(), command(false));
      active = false;
      window.removeEventListener('keydown', onKeyDown);
      emit();
    },
    toggle() {
      if (active) {
        controller.disarm();
        return false;
      }
      return controller.arm();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      controller.disarm();
      unsubscribe();
      listeners.clear();
    },
  };
  return controller;
}

// --- style application -------------------------------------------------------

export interface ApplyStyleRequest {
  selector: string;
  /** CSS property (camelCase or kebab-case). The special prop 'text' edits textContent. */
  prop: string;
  value: string;
}

let styleRequestCounter = 0;

/**
 * Apply a visual style edit in the preview and wait for the bridge to confirm.
 * Resolves with the confirmation (check `ok`/`error` — a selector that matches
 * nothing resolves with ok:false, it does not throw). Rejects only when the
 * iframe is not mounted or the preview never answers within `timeoutMs`.
 */
export function applyStyleToPreview(
  iframe: HTMLIFrameElement | null | undefined,
  request: ApplyStyleRequest,
  timeoutMs = 5000,
): Promise<StyleAppliedMessage> {
  return new Promise((resolve, reject) => {
    styleRequestCounter += 1;
    const requestId = `foundry-style-${Date.now()}-${styleRequestCounter}`;
    const sent = postToPreview(iframe, {
      source: APP_SOURCE,
      kind: 'foundry:applyStyle',
      selector: request.selector,
      prop: request.prop,
      value: request.value,
      requestId,
    });
    if (!sent) {
      reject(new Error('preview iframe is not mounted'));
      return;
    }
    const unsubscribe = subscribePreview((message) => {
      if (!isStyleAppliedMessage(message)) return;
      if (message.requestId !== requestId) return;
      finish();
      resolve(message);
    });
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error(`preview did not confirm style ${request.prop} on ${request.selector} within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (): void => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  });
}
