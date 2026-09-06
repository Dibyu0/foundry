import type { Response } from 'express';

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

interface Channel {
  subs: Set<Response>;
  buffer: SseEvent[];
}

function writeEvent(res: Response, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Server-sent events hub. One channel per build id; subscribers receive
 * live events, heartbeats keep proxies from idling out, and the last
 * `bufferSize` events are replayed to late subscribers (EventSource
 * reconnects included).
 *
 * Wiring: createServer stores the shared instance at app.locals.sseHub;
 * the orchestration routes call send(id, event) and route GET
 * /api/builds/:id/events to subscribe(id, res).
 */
export class SseHub {
  private readonly channels = new Map<string, Channel>();
  private readonly bufferSize: number;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(opts: { heartbeatMs?: number; bufferSize?: number } = {}) {
    this.bufferSize = opts.bufferSize ?? 200;
    this.heartbeat = setInterval(() => {
      for (const channel of this.channels.values()) {
        for (const res of channel.subs) res.write(': heartbeat\n\n');
      }
    }, opts.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  private channel(id: string): Channel {
    let channel = this.channels.get(id);
    if (!channel) {
      channel = { subs: new Set(), buffer: [] };
      this.channels.set(id, channel);
    }
    return channel;
  }

  /** Takes over the response: SSE headers, replay, live stream, close cleanup. */
  subscribe(id: string, res: Response): void {
    const channel = this.channel(id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx et al) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    for (const event of channel.buffer) writeEvent(res, event);
    channel.subs.add(res);
    res.on('close', () => {
      channel.subs.delete(res);
    });
  }

  send(id: string, event: SseEvent): void {
    const channel = this.channel(id);
    channel.buffer.push(event);
    if (channel.buffer.length > this.bufferSize) {
      channel.buffer.splice(0, channel.buffer.length - this.bufferSize);
    }
    for (const res of channel.subs) writeEvent(res, event);
  }

  /** Drops a channel entirely (e.g. after a build reaches a terminal phase). */
  drop(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    for (const res of channel.subs) res.end();
    this.channels.delete(id);
  }

  /** Ends every open stream with a comment; used during graceful shutdown. */
  shutdown(): void {
    clearInterval(this.heartbeat);
    for (const channel of this.channels.values()) {
      for (const res of channel.subs) {
        res.write(': server shutting down\n\n');
        res.end();
      }
    }
    this.channels.clear();
  }
}
