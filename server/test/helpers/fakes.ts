import type { ChatMessage, FetchLike, Provider } from '../../src/agent/provider.js';
import type { SiteStore } from '../../src/agent/tools.js';

export interface MemoryStore extends SiteStore {
  files: Map<string, string>;
  writes: string[];
  reads: string[];
  listCount: number;
}

export function memoryStore(): MemoryStore {
  const files = new Map<string, string>();
  const store: MemoryStore = {
    files,
    writes: [],
    reads: [],
    listCount: 0,
    writeFile(path: string, content: string) {
      store.writes.push(path);
      files.set(path, content);
    },
    readFile(path: string) {
      store.reads.push(path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    listFiles() {
      store.listCount += 1;
      return [...files.keys()];
    },
  };
  return store;
}

export type ScriptEntry = string | (() => string | Promise<string>);

export interface ScriptedProvider extends Provider {
  calls: ChatMessage[][];
}

// Returns queued responses in order; once the queue is exhausted the last
// entry repeats (handy for loop-detection tests).
export function scriptedProvider(entries: ScriptEntry[]): ScriptedProvider {
  if (entries.length === 0) throw new Error('scriptedProvider needs at least one entry');
  const calls: ChatMessage[][] = [];
  let i = 0;
  const provider: ScriptedProvider = {
    calls,
    complete(messages: ChatMessage[]): Promise<string> {
      calls.push(messages.map((m) => ({ ...m })));
      const entry = entries[Math.min(i, entries.length - 1)] as ScriptEntry;
      i += 1;
      return Promise.resolve(typeof entry === 'function' ? entry() : entry);
    },
    async stream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<string> {
      const text = await provider.complete(messages);
      onDelta(text);
      return text;
    },
  };
  return provider;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fetchQueue(responses: Response[], captured: CapturedRequest[]): FetchLike {
  return (input, init) => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captured.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    const res = responses.shift();
    if (!res) return Promise.reject(new Error('fetchQueue: no response queued'));
    return Promise.resolve(res);
  };
}

export function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Enqueues one byte per chunk so stream parsers are exercised against the
// harshest possible split (multi-byte characters included).
export function byteStreamResponse(data: string, status = 200): Response {
  const bytes = new TextEncoder().encode(data);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(Uint8Array.of(b));
      controller.close();
    },
  });
  return new Response(stream, { status });
}
