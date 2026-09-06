import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirs, writeKey } from '../src/config.js';
import { createConfigRouter } from '../src/routes/config.js';
import { rateLimit } from '../src/security.js';
import {
  createSite,
  readSiteFile,
  siteDir,
  writeSiteFile,
} from '../src/sites.js';

const CANARY = 'foundry-test-canary-key-1a2b3c4d5e6f';

const cleanup: string[] = [];
const servers: Server[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-security-'));
  cleanup.push(dir);
  return dir;
}

/** Serves an express app on an ephemeral loopback port; returns its base URL. */
async function serve(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('config route: key hygiene', () => {
  it('GET /api/config never serializes the stored apiKey', async () => {
    const root = await tmpRoot();
    const { secretsFile } = dataDirs(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(secretsFile, JSON.stringify({ apiKey: CANARY }), 'utf8');

    const app = express();
    app.use(express.json());
    app.use('/api/config', createConfigRouter(root));
    const base = await serve(app);

    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(CANARY);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['endpoint', 'hasKey', 'model', 'perRoleModels', 'provider']);
    expect(body.hasKey).toBe(true);
  });

  it('PUT /api/config accepts a key without echoing it back', async () => {
    const root = await tmpRoot();
    const app = express();
    app.use(express.json());
    app.use('/api/config', createConfigRouter(root));
    const base = await serve(app);

    const put = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', endpoint: '', model: 'mock', apiKey: CANARY }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(CANARY);
    expect(JSON.parse(putText)).not.toHaveProperty('apiKey');

    const get = await fetch(`${base}/api/config`);
    expect(await get.text()).not.toContain(CANARY);
  });
});

describe('site store: path confinement', () => {
  async function confinedSite() {
    const root = await tmpRoot();
    const sitesRoot = path.join(root, 'sites');
    const id = 'site_confine_1';
    await createSite(sitesRoot, id);
    return { root, sitesRoot, id };
  }

  it('rejects .. traversal on write and read', async () => {
    const { sitesRoot, id } = await confinedSite();
    await expect(writeSiteFile(sitesRoot, id, '../evil.txt', 'x')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
      status: 403,
    });
    await expect(writeSiteFile(sitesRoot, id, 'a/../../evil.txt', 'x')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
    await expect(readSiteFile(sitesRoot, id, '../evil.txt')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
    // Nothing escaped onto the disk outside the site dir.
    await expect(fs.stat(path.join(sitesRoot, 'evil.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects absolute paths on every platform', async () => {
    const { sitesRoot, id } = await confinedSite();
    for (const p of ['/etc/evil', 'C:\\Windows\\evil', '\\\\server\\share\\evil', '//server/share/evil']) {
      await expect(writeSiteFile(sitesRoot, id, p, 'x')).rejects.toMatchObject({
        code: 'BAD_PATH',
        status: 400,
      });
    }
    await expect(writeSiteFile(sitesRoot, id, 'has\0nul', 'x')).rejects.toMatchObject({
      code: 'BAD_PATH',
    });
  });

  it('rejects symlink/junction escapes via realpath', async () => {
    const { root, sitesRoot, id } = await confinedSite();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
    const link = path.join(sitesRoot, id, 'link');
    try {
      // junction needs no privilege on win32; 'dir' is the POSIX equivalent.
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // no symlink privilege: skip
      throw err;
    }
    await expect(readSiteFile(sitesRoot, id, 'link/secret.txt')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
      status: 403,
    });
    await expect(writeSiteFile(sitesRoot, id, 'link/evil.txt', 'x')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });
  });

  it('confines the site id itself', () => {
    expect(() => siteDir('/tmp/foundry-test', '../..')).toThrowError(/invalid site id/);
    expect(() => siteDir('/tmp/foundry-test', 'a/b')).toThrowError(/invalid site id/);
  });
});

describe('rate limiter', () => {
  it('answers 429 with Retry-After once the cap is exceeded', async () => {
    const app = express();
    app.get('/ping', rateLimit({ windowMs: 60_000, max: 3 }), (_req, res) => {
      res.json({ ok: true });
    });
    const base = await serve(app);

    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/ping`);
      expect(res.status).toBe(200);
    }
    const limited = await fetch(`${base}/ping`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toMatch(/rate limit/i);
  });

  it('allows requests again after the window resets', async () => {
    const app = express();
    app.get('/ping', rateLimit({ windowMs: 100, max: 1 }), (_req, res) => {
      res.json({ ok: true });
    });
    const base = await serve(app);

    expect((await fetch(`${base}/ping`)).status).toBe(200);
    expect((await fetch(`${base}/ping`)).status).toBe(429);
    await new Promise((r) => setTimeout(r, 150));
    expect((await fetch(`${base}/ping`)).status).toBe(200);
  });
});

describe('secrets.json file permissions', () => {
  it('writeKey stores only {apiKey} with mode 0600', async () => {
    const root = await tmpRoot();
    await writeKey(root, CANARY);
    const { secretsFile } = dataDirs(root);

    const stat = await fs.stat(secretsFile);
    if (process.platform !== 'win32') {
      // Windows ACLs do not map to POSIX modes; assert the shape only there.
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const parsed = JSON.parse(await fs.readFile(secretsFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['apiKey']);
    expect(parsed.apiKey).toBe(CANARY);
  });
});
