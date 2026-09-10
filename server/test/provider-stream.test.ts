import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  createKimiProvider,
  createOllamaProvider,
  ProviderError,
} from '../src/agent/provider.js';
import type { ChatMessage, FetchLike } from '../src/agent/provider.js';
import { byteStreamResponse, fetchQueue, jsonResponse } from './helpers/fakes.js';

const userOnly: ChatMessage[] = [{ role: 'user', content: 'x' }];

// A body that delivers the given chunks up front and then stays open forever,
// standing in for a generation that stalls mid-stream.
function manualStream(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stream abort wiring', () => {
  it('keeps the caller abort wired after headers arrive and cancels the read mid-stream', async () => {
    const body = manualStream(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n']);
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl: FetchLike = (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(body.stream, { status: 200 }));
    };
    const provider = createKimiProvider({ fetchImpl, getKey: () => 'k' });
    const caller = new AbortController();
    const deltas: string[] = [];
    const pending = provider.stream(userOnly, (d) => deltas.push(d), { signal: caller.signal });
    // The first chunk lands, then the stream stalls; abort while parked in read().
    await vi.waitFor(() => expect(deltas).toEqual(['Hel']));
    caller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    // The abort reached both the socket (fetch signal) and the body reader.
    expect(fetchSignal?.aborted).toBe(true);
    expect(body.cancelled()).toBe(true);
  });
});

describe('stream idle timeout', () => {
  it('aborts a stalled stream after the default 45s idle budget (fake clock)', { timeout: 60_000 }, async () => {
    vi.useFakeTimers();
    const body = manualStream([]);
    const provider = createKimiProvider({
      fetchImpl: fetchQueue([new Response(body.stream, { status: 200 })], []),
      getKey: () => 'k',
    });
    const pending = provider.stream(userOnly, () => {});
    const assertion = expect(pending).rejects.toThrow(/stalled: no data for 45000ms/);
    // Let the request land and arm the idle timer before advancing the clock.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(44_999);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(body.cancelled()).toBe(true);
  });

  it('honors a configured streamIdleTimeoutMs (real clock)', async () => {
    const body = manualStream([]);
    const provider = createOllamaProvider({
      fetchImpl: fetchQueue([new Response(body.stream, { status: 200 })], []),
      streamIdleTimeoutMs: 20,
    });
    const err = await provider.stream(userOnly, () => {}).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.message).toContain('stalled: no data for 20ms');
    expect(body.cancelled()).toBe(true);
  });

  it('resets the idle budget on every chunk, so a slow-but-steady stream survives (fake clock)', async () => {
    vi.useFakeTimers();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    // One chunk every 30s: under the 45s idle budget, over any total budget.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let i = 0;
        const push = (): void => {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[i]!));
          i += 1;
          setTimeout(push, 30_000);
        };
        push();
      },
    });
    const provider = createKimiProvider({
      fetchImpl: fetchQueue([new Response(stream, { status: 200 })], []),
      getKey: () => 'k',
    });
    const deltas: string[] = [];
    const pending = provider.stream(userOnly, (d) => deltas.push(d));
    const assertion = expect(pending).resolves.toBe('ab');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
    expect(deltas).toEqual(['a', 'b']);
  });
});

describe('stream completion marker', () => {
  it('throws when a chat-completions stream ends without [DONE]', async () => {
    // Clean FIN mid-generation: one full delta, no sentinel.
    const sse = 'data: {"choices":[{"delta":{"content":"half"}}]}\n\n';
    const provider = createKimiProvider({
      fetchImpl: fetchQueue([byteStreamResponse(sse)], []),
      getKey: () => 'k',
    });
    const deltas: string[] = [];
    const err = await provider.stream(userOnly, (d) => deltas.push(d)).then(
      () => null,
      (e: unknown) => e as ProviderError,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.message).toBe('stream ended before the completion marker');
    // The partial text streamed live but must not come back as a result.
    expect(deltas).toEqual(['half']);
  });

  it('throws when an ollama stream ends without done:true', async () => {
    const ndjson = '{"message":{"content":"ab"},"done":false}\n';
    const provider = createOllamaProvider({ fetchImpl: fetchQueue([byteStreamResponse(ndjson)], []) });
    await expect(provider.stream(userOnly, () => {})).rejects.toThrow(
      'stream ended before the completion marker',
    );
  });

  it('still resolves marker-terminated streams for both providers', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const kimi = createKimiProvider({
      fetchImpl: fetchQueue([byteStreamResponse(sse)], []),
      getKey: () => 'k',
    });
    await expect(kimi.stream(userOnly, () => {})).resolves.toBe('ok');
    const ndjson = '{"message":{"content":"ok"},"done":false}\n{"message":{"content":""},"done":true}\n';
    const ollama = createOllamaProvider({ fetchImpl: fetchQueue([byteStreamResponse(ndjson)], []) });
    await expect(ollama.stream(userOnly, () => {})).resolves.toBe('ok');
  });

  it('leaves complete() untouched: no marker required on non-stream responses', async () => {
    const kimi = createKimiProvider({
      fetchImpl: fetchQueue([jsonResponse(200, { choices: [{ message: { content: 'full' } }] })], []),
      getKey: () => 'k',
    });
    await expect(kimi.complete(userOnly)).resolves.toBe('full');
    const ollama = createOllamaProvider({
      fetchImpl: fetchQueue([jsonResponse(200, { message: { content: 'local full' }, done: true })], []),
    });
    await expect(ollama.complete(userOnly)).resolves.toBe('local full');
  });
});
