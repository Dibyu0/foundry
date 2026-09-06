import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallOptions, ChatMessage, Provider } from '../src/agent/provider.js';
import {
  ENHANCE_DRAFT_MAX_CHARS,
  createEnhanceRouter,
  enhanceRouter,
  mockEnhance,
} from '../src/routes/agent.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-enhance-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function withServer(app: Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function enhanceApp(deps: Parameters<typeof createEnhanceRouter>[0]): Express {
  const app = express();
  app.use('/api/enhance-prompt', express.json(), createEnhanceRouter(deps));
  return app;
}

interface RecordedCall {
  messages: ChatMessage[];
  opts?: CallOptions;
}

/** A provider that records its calls and replies or throws on demand. */
function recordingProvider(reply: string | (() => string), calls: RecordedCall[]): Provider {
  return {
    complete(messages: ChatMessage[], opts?: CallOptions): Promise<string> {
      calls.push({ messages: messages.map((m) => ({ ...m })), ...(opts ? { opts } : {}) });
      return Promise.resolve(typeof reply === 'function' ? reply() : reply);
    },
    stream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<string> {
      const text = typeof reply === 'function' ? reply() : reply;
      onDelta(text);
      return Promise.resolve(text);
    },
  };
}

function failingProvider(message: string): Provider {
  return {
    complete: () => Promise.reject(new Error(message)),
    stream: () => Promise.reject(new Error(message)),
  };
}

describe('mockEnhance', () => {
  it('is deterministic and derives the brief from the draft', () => {
    const a = mockEnhance('a bakery site with online ordering');
    expect(a).toBe(mockEnhance('a bakery site with online ordering'));
    expect(a).toContain('A bakery site with online ordering.');
    expect(a).toContain('prefers reduced motion');
  });

  it('collapses whitespace and avoids double punctuation', () => {
    const out = mockEnhance('  a   portfolio\nfor a photographer!  ');
    expect(out.startsWith('A portfolio for a photographer.')).toBe(true);
    expect(out).not.toContain('!.');
  });
});

describe('POST /api/enhance-prompt', () => {
  it('rejects invalid drafts with honest 400s', async () => {
    const app = enhanceApp({ getKind: () => 'mock', getProvider: () => Promise.resolve(recordingProvider('x', [])) });
    await withServer(app, async (base) => {
      for (const body of [{}, { draft: '' }, { draft: '   ' }, { draft: 42 }]) {
        const res = await fetch(`${base}/api/enhance-prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain('draft');
      }
    });
  });

  it('rejects drafts over the size cap', async () => {
    const app = enhanceApp({ getKind: () => 'mock', getProvider: () => Promise.resolve(recordingProvider('x', [])) });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'x'.repeat(ENHANCE_DRAFT_MAX_CHARS + 1) }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('too long');
    });
  });

  it('uses the canned enhancer for the mock provider without a provider round', async () => {
    let providerTouched = false;
    const app = enhanceApp({
      getKind: () => 'mock',
      getProvider: () => {
        providerTouched = true;
        return Promise.reject(new Error('must not be called'));
      },
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'a landing page for a dentist' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enhanced: string };
      expect(body.enhanced).toBe(mockEnhance('a landing page for a dentist'));
      expect(providerTouched).toBe(false);
    });
  });

  it('runs one cheap provider round for real providers', async () => {
    const calls: RecordedCall[] = [];
    const app = enhanceApp({
      getKind: () => 'kimi',
      getProvider: () => Promise.resolve(recordingProvider('A polished brief with real sections.', calls)),
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: '  a docs site for my CLI  ' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enhanced: string }).enhanced).toBe('A polished brief with real sections.');
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.messages).toHaveLength(2);
    expect(call?.messages[0]?.role).toBe('system');
    expect(call?.messages[1]).toEqual({ role: 'user', content: 'a docs site for my CLI' });
    expect(call?.opts?.temperature).toBe(0.4);
    expect(call?.opts?.maxTokens).toBe(600);
  });

  it('strips quotes a model wraps around the whole reply', async () => {
    const app = enhanceApp({
      getKind: () => 'ollama',
      getProvider: () => Promise.resolve(recordingProvider('"A quoted brief."', [])),
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'a shop' }),
      });
      expect(((await res.json()) as { enhanced: string }).enhanced).toBe('A quoted brief.');
    });
  });

  it('surfaces provider failures as honest 502s', async () => {
    const app = enhanceApp({
      getKind: () => 'kimi',
      getProvider: () => Promise.resolve(failingProvider('no API key configured')),
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'a shop' }),
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain('no API key configured');
    });
  });

  it('treats an empty provider reply as a 502, not a success', async () => {
    const app = enhanceApp({
      getKind: () => 'kimi',
      getProvider: () => Promise.resolve(recordingProvider('   ', [])),
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'a shop' }),
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain('empty');
    });
  });

  it('the default lazy router reads the persisted config (mock by default)', async () => {
    const app = express();
    app.locals.dataRoot = root;
    app.use('/api/enhance-prompt', express.json(), enhanceRouter);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/enhance-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: 'a waitlist page for a podcast app' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { enhanced: string }).enhanced).toBe(
        mockEnhance('a waitlist page for a podcast app'),
      );
    });
  });
});
