import { describe, expect, it } from 'vitest';
import { SseHub, type SseEvent } from '../src/sse.js';

/**
 * Minimal Response stand-in. `write` always records the chunk (a real
 * socket buffers it even when signaling backpressure) and returns
 * `fake.writable` so tests can flip backpressure on and off.
 */
function fakeResponse() {
  const chunks: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const fake = {
    chunks,
    writable: true,
    statusCode: null as number | null,
    jsonBody: undefined as unknown,
    ended: false,
    res: {
      writeHead: () => undefined,
      write: (chunk: string) => {
        chunks.push(chunk);
        return fake.writable;
      },
      on: (event: string, handler: () => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      end: () => {
        fake.ended = true;
        chunks.push('<end>');
      },
      status: (code: number) => {
        fake.statusCode = code;
        return fake.res;
      },
      json: (body: unknown) => {
        fake.jsonBody = body;
      },
    } as Record<string, unknown>,
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
  return fake;
}

function dataEvents(chunks: string[]): SseEvent[] {
  return chunks
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice('data: '.length).trimEnd()) as SseEvent);
}

function dataTypes(chunks: string[]): string[] {
  return dataEvents(chunks).map((e) => e.type);
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHub(opts: Record<string, unknown> = {}): SseHub {
  return new SseHub({ heartbeatMs: 600_000, batchWindowMs: 25, ...opts });
}

describe('sse batching', () => {
  it('coalesces a 100-event file burst into one ordered batch frame', async () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      for (let i = 0; i < 100; i += 1) hub.send('b1', { type: 'file', i });

      // Nothing batchable leaks out before the window closes.
      expect(dataEvents(sub.chunks)).toEqual([]);
      await tick(80);

      const events = dataEvents(sub.chunks);
      expect(events).toHaveLength(1);
      const frame = events[0];
      expect(frame?.type).toBe('batch');
      const inner = frame?.events as SseEvent[];
      expect(inner).toHaveLength(100);
      expect(inner.map((e) => e.i)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    } finally {
      hub.shutdown();
    }
  });

  it('groups interleaved batchable types into consecutive same-type runs', async () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      hub.send('b1', { type: 'file', n: 1 });
      hub.send('b1', { type: 'file', n: 2 });
      hub.send('b1', { type: 'file', n: 3 });
      hub.send('b1', { type: 'activity', n: 4 });
      hub.send('b1', { type: 'activity', n: 5 });
      hub.send('b1', { type: 'file', n: 6 });
      await tick(80);

      const events = dataEvents(sub.chunks);
      expect(events.map((e) => e.type)).toEqual(['batch', 'batch', 'file']);
      expect(((events[0]?.events ?? []) as SseEvent[]).map((e) => e.n)).toEqual([1, 2, 3]);
      expect(((events[1]?.events ?? []) as SseEvent[]).map((e) => e.n)).toEqual([4, 5]);
      expect(events[2]?.n).toBe(6);
    } finally {
      hub.shutdown();
    }
  });

  it('never batches phase/question/plan/done/error and keeps them in order', async () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      hub.send('b1', { type: 'file', n: 1 });
      hub.send('b1', { type: 'file', n: 2 });
      hub.send('b1', { type: 'phase', phase: 'INTAKE' });
      hub.send('b1', { type: 'question', n: 3 });
      hub.send('b1', { type: 'plan', n: 4 });
      hub.send('b1', { type: 'error', error: 'x' });

      // Critical events flush the pending batch and go out synchronously.
      expect(dataTypes(sub.chunks)).toEqual(['batch', 'phase', 'question', 'plan', 'error']);
      const frame = dataEvents(sub.chunks)[0];
      expect(((frame?.events ?? []) as SseEvent[]).map((e) => e.n)).toEqual([1, 2]);

      hub.send('b1', { type: 'done', n: 5 });
      hub.send('b1', { type: 'activity', n: 6 });
      // The trailing batchable is still inside its window; done was not delayed by it.
      expect(dataTypes(sub.chunks)).toEqual(['batch', 'phase', 'question', 'plan', 'error', 'done']);
      await tick(80);
      expect(dataTypes(sub.chunks)).toEqual(['batch', 'phase', 'question', 'plan', 'error', 'done', 'activity']);
    } finally {
      hub.shutdown();
    }
  });

  it('serves the verbatim stream to ?raw=1 subscribers while others get frames', async () => {
    const hub = makeHub();
    try {
      const batched = fakeResponse();
      const viaOpts = fakeResponse();
      const viaQuery = fakeResponse();
      viaQuery.res.req = { query: { raw: '1' } };
      hub.subscribe('b1', batched.res as never);
      hub.subscribe('b1', viaOpts.res as never, { raw: true });
      hub.subscribe('b1', viaQuery.res as never);

      for (let i = 0; i < 3; i += 1) hub.send('b1', { type: 'file', i });
      await tick(80);

      expect(dataTypes(batched.chunks)).toEqual(['batch']);
      expect(dataTypes(viaOpts.chunks)).toEqual(['file', 'file', 'file']);
      expect(dataTypes(viaQuery.chunks)).toEqual(['file', 'file', 'file']);
    } finally {
      hub.shutdown();
    }
  });

  it('drop() flushes the pending batch before ending streams', () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      for (let i = 0; i < 3; i += 1) hub.send('b1', { type: 'file', i });
      hub.drop('b1');
      const events = dataEvents(sub.chunks);
      expect(events).toHaveLength(1);
      expect(((events[0]?.events ?? []) as SseEvent[]).map((e) => e.i)).toEqual([0, 1, 2]);
      expect(sub.ended).toBe(true);
    } finally {
      hub.shutdown();
    }
  });
});

describe('sse backpressure', () => {
  it('queues while backpressured and flushes in order on drain', () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      hub.send('b1', { type: 'message', n: 1 });

      sub.writable = false;
      // This write is accepted by the "kernel" but signals a full buffer.
      hub.send('b1', { type: 'message', n: 2 });
      for (let i = 3; i <= 7; i += 1) hub.send('b1', { type: 'message', n: i });
      expect(sub.chunks).toHaveLength(3); // connected + n=1 + n=2
      expect(hub.stats().slowConsumers).toBe(0);

      sub.writable = true;
      sub.fire('drain');
      expect(dataEvents(sub.chunks).map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(hub.stats().slowConsumers).toBe(0);
      // Fully drained: backpressure cleared, the next event writes directly.
      hub.send('b1', { type: 'message', n: 8 });
      expect(dataEvents(sub.chunks).map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      hub.shutdown();
    }
  });

  it('flags a subscriber slow past 100 queued events', () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      sub.writable = false;
      hub.send('b1', { type: 'message', n: 0 }); // trips backpressure
      for (let i = 1; i <= 100; i += 1) hub.send('b1', { type: 'message', n: i });
      expect(hub.stats().slowConsumers).toBe(0);
      hub.send('b1', { type: 'message', n: 101 });
      expect(hub.stats().slowConsumers).toBe(1);
      expect(sub.ended).toBe(false);
    } finally {
      hub.shutdown();
    }
  });

  it('drops the connection with a terminal error past 500 queued events', () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      sub.writable = false;
      hub.send('b1', { type: 'message', n: 0 }); // trips backpressure
      for (let i = 1; i <= 500; i += 1) hub.send('b1', { type: 'message', n: i });
      expect(sub.ended).toBe(false);
      expect(hub.stats().subscribers).toBe(1);

      hub.send('b1', { type: 'message', n: 501 });
      expect(sub.ended).toBe(true);
      const events = dataEvents(sub.chunks);
      expect(events[events.length - 1]).toEqual({ type: 'error', error: 'slow consumer' });
      expect(hub.stats().droppedSlow).toBe(1);
      expect(hub.stats().subscribers).toBe(0);

      // The dropped subscriber is gone: later events do not reach it.
      const before = sub.chunks.length;
      hub.send('b1', { type: 'message', n: 502 });
      expect(sub.chunks.length).toBe(before);
    } finally {
      hub.shutdown();
    }
  });

  it('stops writing to a subscriber once its socket closes', () => {
    const hub = makeHub();
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      sub.fire('close');
      expect(hub.stats().subscribers).toBe(0);
      hub.send('b1', { type: 'phase', phase: 'DONE' });
      expect(dataEvents(sub.chunks)).toEqual([]);
    } finally {
      hub.shutdown();
    }
  });
});

describe('sse subscriber caps', () => {
  it('rejects subscribers past the per-build cap with an honest 429', () => {
    const hub = makeHub({ maxSubsPerBuild: 2 });
    try {
      const s1 = fakeResponse();
      const s2 = fakeResponse();
      const s3 = fakeResponse();
      hub.subscribe('b1', s1.res as never);
      hub.subscribe('b1', s2.res as never);
      hub.subscribe('b1', s3.res as never);
      expect(s3.statusCode).toBe(429);
      expect((s3.jsonBody as { error: string }).error).toContain('too many subscribers for build b1');
      expect(s3.chunks).toEqual([]);
      expect(hub.stats().subscribers).toBe(2);
    } finally {
      hub.shutdown();
    }
  });

  it('rejects subscribers past the global cap with an honest 429', () => {
    const hub = makeHub({ maxSubsTotal: 3 });
    try {
      for (const id of ['b1', 'b2', 'b3']) hub.subscribe(id, fakeResponse().res as never);
      const s4 = fakeResponse();
      hub.subscribe('b4', s4.res as never);
      expect(s4.statusCode).toBe(429);
      expect((s4.jsonBody as { error: string }).error).toContain('too many subscribers overall');
      expect(hub.stats().subscribers).toBe(3);
    } finally {
      hub.shutdown();
    }
  });
});

describe('sse replay under batching', () => {
  it('replays raw events from the ring buffer, not batch frames', async () => {
    const hub = makeHub({ bufferSize: 5 });
    try {
      const live = fakeResponse();
      hub.subscribe('b1', live.res as never);
      for (let i = 0; i < 7; i += 1) hub.send('b1', { type: 'file', i });
      await tick(80);
      expect(dataTypes(live.chunks)).toEqual(['batch']);

      const late = fakeResponse();
      hub.subscribe('b1', late.res as never);
      const replayed = dataEvents(late.chunks);
      expect(replayed.map((e) => e.type)).toEqual(['file', 'file', 'file', 'file', 'file']);
      expect(replayed.map((e) => e.i)).toEqual([2, 3, 4, 5, 6]);
    } finally {
      hub.shutdown();
    }
  });

  it('replays a mix of batchable and critical events in arrival order', () => {
    const hub = makeHub();
    try {
      hub.send('b1', { type: 'phase', phase: 'INTAKE' });
      hub.send('b1', { type: 'file', n: 1 });
      hub.send('b1', { type: 'activity', n: 2 });
      hub.send('b1', { type: 'question', n: 3 });
      const late = fakeResponse();
      hub.subscribe('b1', late.res as never);
      expect(dataTypes(late.chunks)).toEqual(['phase', 'file', 'activity', 'question']);
    } finally {
      hub.shutdown();
    }
  });
});
