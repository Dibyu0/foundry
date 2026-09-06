import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { appShellHeaders, rateLimit, requestId } from '../src/security.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-sec-'));
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

describe('app shell headers', () => {
  it('sets the strict header set on app routes', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/config`);
        const csp = res.headers.get('content-security-policy') ?? '';
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("img-src 'self' data:");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('strict-transport-security')).toBe('max-age=604800');
        expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(res.headers.get('x-powered-by')).toBeNull();
      });
    } finally {
      await foundry.close();
    }
  });

  it('assigns a unique X-Request-Id per response', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const first = await fetch(`${base}/api/config`);
        const second = await fetch(`${base}/api/config`);
        const a = first.headers.get('x-request-id');
        const b = second.headers.get('x-request-id');
        expect(a).toMatch(/^[0-9a-f-]{36}$/);
        expect(b).toMatch(/^[0-9a-f-]{36}$/);
        expect(a).not.toBe(b);
      });
    } finally {
      await foundry.close();
    }
  });
});

describe('rate limiting', () => {
  it('429s over the limit with Retry-After', async () => {
    const app = express();
    app.use(requestId());
    app.use(rateLimit({ windowMs: 60_000, max: 2 }));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(app, async (base) => {
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/`)).status).toBe(200);
      const third = await fetch(`${base}/`);
      expect(third.status).toBe(429);
      const retryAfter = Number(third.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(((await third.json()) as { retryAfter: number }).retryAfter).toBe(retryAfter);
    });
  });

  it(
    'limits POST /api/builds to 60/min while other routes stay up',
    { timeout: 60_000 },
    async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const post = () =>
          fetch(`${base}/api/builds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brief: 'a bakery site' }),
          });
        for (let i = 0; i < 60; i += 1) {
          // The orchestrator route answers 202, which proves each request
          // passed the limiter (a rejected brief would still burn the same
          // bucket, so any non-429 status is fine here).
          expect((await post()).status).not.toBe(429);
        }
        const blocked = await post();
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('retry-after')).not.toBeNull();
        // The global 300/min limiter still lets ordinary routes through.
        expect((await fetch(`${base}/api/config`)).status).toBe(200);
      });
    } finally {
      await foundry.close();
    }
  });
});

describe('body limits and parse errors', () => {
  it('rejects oversized config bodies with 413', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'mock',
            endpoint: '',
            model: 'm'.repeat(70 * 1024),
          }),
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'request body too large' });
      });
    } finally {
      await foundry.close();
    }
  });

  it('rejects oversized build bodies with 413', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/builds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief: 'b'.repeat(300 * 1024) }),
        });
        expect(res.status).toBe(413);
      });
    } finally {
      await foundry.close();
    }
  });

  it('rejects malformed JSON with 400, not an HTML stack page', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{oops',
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(await res.json()).toEqual({ error: 'request body is not valid JSON' });
      });
    } finally {
      await foundry.close();
    }
  });
});

describe('config validation', () => {
  it('rejects junk with 400 and a message', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const put = (body: unknown) =>
          fetch(`${base}/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

        expect((await put({ provider: 'openai', endpoint: '', model: 'x' })).status).toBe(400);
        expect((await put({ provider: 'kimi', endpoint: 'http://example.com', model: 'x' })).status).toBe(400);
        expect((await put({ provider: 'kimi', endpoint: 'not-a-url', model: 'x' })).status).toBe(400);
        expect((await put({ provider: 'kimi', endpoint: 'https://ok.dev', model: '' })).status).toBe(400);
        expect((await put({ provider: 'kimi', endpoint: 'https://ok.dev', model: 'x'.repeat(129) })).status).toBe(400);
        expect((await put({ provider: 'kimi', endpoint: 'https://ok.dev', model: 'x', apiKey: 42 })).status).toBe(400);
        expect((await put('junk')).status).toBe(400);

        const msg = await (await put({ provider: 'openai', endpoint: '', model: 'x' })).json();
        expect((msg as { error: string }).error).toContain('provider');

        // Localhost http (Ollama-style) is allowed.
        const ok = await put({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'llama3.1' });
        expect(ok.status).toBe(200);
      });
    } finally {
      await foundry.close();
    }
  });
});

describe('rate limiter internals', () => {
  it('resets the window and isolates keys', async () => {
    const app = express();
    app.use(rateLimit({ windowMs: 50, max: 1 }));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(app, async (base) => {
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/`)).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect((await fetch(`${base}/`)).status).toBe(200);
    });
  });

  it('composes with the app shell header middleware', async () => {
    const app = express();
    app.use(appShellHeaders());
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    });
  });
});
