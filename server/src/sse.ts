import type { Response } from 'express';

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Events whose delay, loss or reordering would break the client contract;
 * they always flush any pending batch and go out immediately, unbatched.
 */
const NEVER_BATCH: ReadonlySet<string> = new Set(['phase', 'question', 'plan', 'done', 'error']);

const DEFAULT_BATCHABLE: readonly string[] = ['file', 'activity'];

interface Subscriber {
  res: Response;
  /** Raw subscribers bypass batching and receive every event verbatim. */
  raw: boolean;
  /** App-level queue used while the socket reports backpressure. */
  queue: SseEvent[];
  backpressured: boolean;
  slow: boolean;
  closed: boolean;
}

interface Channel {
  subs: Set<Subscriber>;
  buffer: SseEvent[];
  /** Batchable events waiting out the coalescing window, in arrival order. */
  pending: SseEvent[];
  flushTimer: NodeJS.Timeout | null;
}

export interface SseHubOptions {
  heartbeatMs?: number;
  bufferSize?: number;
  /** Coalescing window for chatty event types; 0 disables batching. */
  batchWindowMs?: number;
  batchableTypes?: readonly string[];
  maxSubsPerBuild?: number;
  maxSubsTotal?: number;
  /** Queue depth at which a backpressured subscriber is flagged slow. */
  slowQueueThreshold?: number;
  /** Queue depth at which a backpressured subscriber is dropped. */
  maxQueueSize?: number;
}

function writeEvent(res: Response, event: SseEvent): boolean {
  return res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Collapses consecutive same-type runs into {type:'batch'} frames. */
function coalesce(events: SseEvent[]): SseEvent[] {
  const frames: SseEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const first = events[i];
    if (first === undefined) break;
    let j = i + 1;
    while (j < events.length && events[j]?.type === first.type) j += 1;
    if (j - i === 1) frames.push(first);
    else frames.push({ type: 'batch', events: events.slice(i, j) });
    i = j;
  }
  return frames;
}

/** Express keeps the matching request at res.req; ?raw=1 asks for the unbatched stream. */
function rawRequested(res: Response): boolean {
  const req = (res as { req?: { query?: unknown } }).req;
  const query = req?.query;
  if (query !== null && typeof query === 'object') {
    return (query as Record<string, unknown>).raw === '1';
  }
  return false;
}

/**
 * Server-sent events hub. One channel per build id; subscribers receive
 * live events, heartbeats keep proxies from idling out, and the last
 * `bufferSize` events are replayed to late subscribers (EventSource
 * reconnects included).
 *
 * Hardening for chatty builds:
 * - Batching: bursts of `batchableTypes` (default file/activity) arriving
 *   within `batchWindowMs` (default 50ms) are coalesced into a single
 *   {type:'batch', events:[...]} frame, preserving arrival order. Critical
 *   types (phase/question/plan/done/error) are never batched and flush any
 *   pending batch first so ordering is kept. The replay buffer always
 *   stores raw events, and ?raw=1 subscribers get the verbatim live stream.
 * - Backpressure: when a socket write signals a full buffer, later events
 *   queue in memory; past `slowQueueThreshold` (100) the subscriber is
 *   flagged slow, the queue flushes on 'drain', and past `maxQueueSize`
 *   (500) the connection is ended with a terminal
 *   {type:'error',error:'slow consumer'} event.
 * - Bounds: at most `maxSubsPerBuild` (10) subscribers per build and
 *   `maxSubsTotal` (100) overall; excess subscribes get an honest 429.
 *
 * Wiring: createServer stores the shared instance at app.locals.sseHub;
 * the orchestration routes call send(id, event) and route GET
 * /api/builds/:id/events to subscribe(id, res).
 */
export class SseHub {
  private readonly channels = new Map<string, Channel>();
  private readonly bufferSize: number;
  private readonly batchWindowMs: number;
  private readonly batchable: ReadonlySet<string>;
  private readonly maxSubsPerBuild: number;
  private readonly maxSubsTotal: number;
  private readonly slowQueueThreshold: number;
  private readonly maxQueueSize: number;
  private readonly heartbeat: NodeJS.Timeout;
  private droppedSlow = 0;

  constructor(opts: SseHubOptions = {}) {
    this.bufferSize = opts.bufferSize ?? 200;
    this.batchWindowMs = opts.batchWindowMs ?? 50;
    this.batchable = new Set(opts.batchableTypes ?? DEFAULT_BATCHABLE);
    this.maxSubsPerBuild = opts.maxSubsPerBuild ?? 10;
    this.maxSubsTotal = opts.maxSubsTotal ?? 100;
    this.slowQueueThreshold = opts.slowQueueThreshold ?? 100;
    this.maxQueueSize = opts.maxQueueSize ?? 500;
    this.heartbeat = setInterval(() => {
      for (const channel of this.channels.values()) {
        for (const sub of channel.subs) {
          // A backed-up subscriber already has data in flight; piling
          // heartbeats onto its kernel buffer only hastens the drop.
          if (sub.closed || sub.backpressured) continue;
          sub.res.write(': heartbeat\n\n');
        }
      }
    }, opts.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  private channel(id: string): Channel {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = { subs: new Set(), buffer: [], pending: [], flushTimer: null };
      this.channels.set(id, channel);
    }
    return channel;
  }

  private totalSubs(): number {
    let total = 0;
    for (const channel of this.channels.values()) total += channel.subs.size;
    return total;
  }

  /** Point-in-time view for observability and tests. */
  stats(): { channels: number; subscribers: number; slowConsumers: number; droppedSlow: number } {
    let subscribers = 0;
    let slowConsumers = 0;
    for (const channel of this.channels.values()) {
      subscribers += channel.subs.size;
      for (const sub of channel.subs) if (sub.slow) slowConsumers += 1;
    }
    return { channels: this.channels.size, subscribers, slowConsumers, droppedSlow: this.droppedSlow };
  }

  /**
   * Takes over the response: SSE headers, replay, live stream, close
   * cleanup. Over-cap subscribes are answered with a 429 instead, and
   * {raw:true} (or ?raw=1) skips batching for this subscriber.
   */
  subscribe(id: string, res: Response, opts: { raw?: boolean } = {}): void {
    const channel = this.channel(id);
    if (channel.subs.size >= this.maxSubsPerBuild) {
      res.status(429).json({ error: `too many subscribers for build ${id} (max ${this.maxSubsPerBuild})` });
      return;
    }
    if (this.totalSubs() >= this.maxSubsTotal) {
      res.status(429).json({ error: `too many subscribers overall (max ${this.maxSubsTotal})` });
      return;
    }
    const sub: Subscriber = {
      res,
      raw: opts.raw ?? rawRequested(res),
      queue: [],
      backpressured: false,
      slow: false,
      closed: false,
    };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx et al) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    channel.subs.add(sub);
    for (const event of channel.buffer) this.deliver(channel, sub, event);
    res.on('close', () => {
      sub.closed = true;
      channel.subs.delete(sub);
    });
    res.on('drain', () => {
      while (sub.queue.length > 0 && !sub.closed) {
        const next = sub.queue.shift();
        if (next === undefined) break;
        if (!writeEvent(sub.res, next)) return;
      }
      if (sub.queue.length === 0) {
        sub.backpressured = false;
        sub.slow = false;
      }
    });
  }

  send(id: string, event: SseEvent): void {
    const channel = this.channel(id);
    // The replay buffer keeps raw events so late subscribers see full fidelity.
    channel.buffer.push(event);
    if (channel.buffer.length > this.bufferSize) {
      channel.buffer.splice(0, channel.buffer.length - this.bufferSize);
    }
    if (this.batchWindowMs > 0 && this.batchable.has(event.type) && !NEVER_BATCH.has(event.type)) {
      channel.pending.push(event);
      if (channel.flushTimer === null) {
        channel.flushTimer = setTimeout(() => {
          channel.flushTimer = null;
          this.flushPending(channel);
        }, this.batchWindowMs);
        channel.flushTimer.unref();
      }
      return;
    }
    // A direct event must not overtake anything still in the batch window.
    this.flushPending(channel);
    for (const sub of channel.subs) this.deliver(channel, sub, event);
  }

  /** Drops a channel entirely (e.g. after a build reaches a terminal phase). */
  drop(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    // Do not strand events sitting in the batch window when a build ends.
    this.flushPending(channel);
    for (const sub of channel.subs) {
      sub.closed = true;
      sub.res.end();
    }
    channel.subs.clear();
    this.channels.delete(id);
  }

  /** Ends every open stream with a comment; used during graceful shutdown. */
  shutdown(): void {
    clearInterval(this.heartbeat);
    for (const channel of this.channels.values()) {
      if (channel.flushTimer !== null) clearTimeout(channel.flushTimer);
      channel.pending.length = 0;
      for (const sub of channel.subs) {
        sub.closed = true;
        sub.res.write(': server shutting down\n\n');
        sub.res.end();
      }
      channel.subs.clear();
    }
    this.channels.clear();
  }

  private flushPending(channel: Channel): void {
    if (channel.flushTimer !== null) {
      clearTimeout(channel.flushTimer);
      channel.flushTimer = null;
    }
    if (channel.pending.length === 0) return;
    const events = channel.pending.splice(0);
    const frames = coalesce(events);
    for (const sub of channel.subs) {
      const outgoing = sub.raw ? events : frames;
      for (const event of outgoing) this.deliver(channel, sub, event);
    }
  }

  private deliver(channel: Channel, sub: Subscriber, event: SseEvent): void {
    if (sub.closed) return;
    if (sub.backpressured) {
      sub.queue.push(event);
      if (sub.queue.length > this.slowQueueThreshold) sub.slow = true;
      if (sub.queue.length > this.maxQueueSize) this.dropSlow(channel, sub);
      return;
    }
    if (!writeEvent(sub.res, event)) sub.backpressured = true;
  }

  private dropSlow(channel: Channel, sub: Subscriber): void {
    sub.closed = true;
    sub.queue.length = 0;
    channel.subs.delete(sub);
    this.droppedSlow += 1;
    // The socket is backed up, so this terminal event may never flush; it
    // is still the honest last word, and end() guarantees the disconnect.
    try {
      writeEvent(sub.res, { type: 'error', error: 'slow consumer' });
    } catch {
      // Socket already broken; end() below is the remaining signal.
    }
    sub.res.end();
  }
}
