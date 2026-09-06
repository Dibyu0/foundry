import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { writeSiteFile } from '../src/sites.js';

const PREVIEW_CSP = "default-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:";
const SITE_ID = 'preview-test-site';

let root: string;
let sites: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-preview-'));
  sites = path.join(root, 'sites');
  await writeSiteFile(sites, SITE_ID, 'index.html', '<!doctype html><h1>preview-ok</h1>');
  await writeSiteFile(sites, SITE_ID, 'style.css', 'h1{color:red}');
  await writeSiteFile(sites, SITE_ID, 'app.js', 'console.log(1)');
  await writeSiteFile(sites, SITE_ID, 'img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeSiteFile(sites, SITE_ID, 'sub/index.html', '<p>nested</p>');
  await writeSiteFile(sites, SITE_ID, 'notes.txt', 'plain');
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

async function withFoundry(fn: (base: string) => Promise<void>): Promise<void> {
  const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
  try {
    await withServer(foundry.app, fn);
  } finally {
    await foundry.close();
  }
}

describe('preview serving', () => {
  it('serves index.html at the site root with the preview header set', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(await res.text()).toContain('preview-ok');
    });
  });

  it('redirects the bare site url to the trailing-slash form', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/preview/${SITE_ID}/`);
    });
  });

  it('serves each supported content type', async () => {
    await withFoundry(async (base) => {
      const cases: Array<[string, string]> = [
        ['style.css', 'text/css; charset=utf-8'],
        ['app.js', 'text/javascript; charset=utf-8'],
        ['img/logo.png', 'image/png'],
        ['notes.txt', 'text/plain; charset=utf-8'],
      ];
      for (const [file, type] of cases) {
        const res = await fetch(`${base}/preview/${SITE_ID}/${file}`);
        expect(res.status, file).toBe(200);
        expect(res.headers.get('content-type'), file).toBe(type);
        await res.arrayBuffer();
      }
    });
  });

  it('falls back to index.html for directory paths', async () => {
    await withFoundry(async (base) => {
      for (const tail of ['sub', 'sub/']) {
        const res = await fetch(`${base}/preview/${SITE_ID}/${tail}`);
        expect(res.status, tail).toBe(200);
        expect(await res.text(), tail).toContain('nested');
      }
    });
  });

  it('rejects traversal attempts', async () => {
    await withFoundry(async (base) => {
      // Encoded dot segments survive fetch URL normalization and are
      // decoded by express into real '..' segments.
      for (const tail of ['%2e%2e/secret.txt', '%2e%2e%2fsecret.txt', 'sub/%2e%2e/%2e%2e/x.txt']) {
        const res = await fetch(`${base}/preview/${SITE_ID}/${tail}`);
        expect([403, 404], tail).toContain(res.status);
        await res.text();
      }
      const nul = await fetch(`${base}/preview/${SITE_ID}/a%00b.txt`);
      expect([400, 403, 404]).toContain(nul.status);
    });
  });

  it('404s missing files, unknown ids, invalid ids and unsupported types', async () => {
    await withFoundry(async (base) => {
      expect((await fetch(`${base}/preview/${SITE_ID}/missing.html`)).status).toBe(404);
      expect((await fetch(`${base}/preview/does-not-exist-1/`)).status).toBe(404);
      expect((await fetch(`${base}/preview/bad..id/`)).status).toBe(404);

      await writeSiteFile(sites, SITE_ID, 'data.weird', 'x');
      const res = await fetch(`${base}/preview/${SITE_ID}/data.weird`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain('unsupported');
    });
  });

  it('does not apply the app-shell CSP to preview responses', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}/`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).not.toContain('frame-ancestors');
      expect(csp).toContain('img-src');
      expect(csp).toContain('https:');
    });
  });
});
