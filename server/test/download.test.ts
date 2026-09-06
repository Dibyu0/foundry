import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { writeSiteFile } from '../src/sites.js';

const SITE_ID = '01234567-89ab-cdef-0123-456789abcdef';

let root: string;
let sites: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-dl-'));
  sites = path.join(root, 'sites');
  await writeSiteFile(sites, SITE_ID, 'index.html', '<!doctype html><h1>zip me</h1>');
  await writeSiteFile(sites, SITE_ID, 'assets/app.js', 'console.log("zip")');
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

describe('site download', () => {
  it('streams a zip containing the site files', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/builds/${SITE_ID}/download`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/zip');
        expect(res.headers.get('content-disposition')).toBe(
          `attachment; filename="foundry-site-${SITE_ID.slice(0, 8)}.zip"`,
        );
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBeGreaterThan(100);
        // Zip local file header magic.
        expect(body[0]).toBe(0x50); // P
        expect(body[1]).toBe(0x4b); // K
        expect(body[2]).toBe(0x03);
        expect(body[3]).toBe(0x04);
        // Entry names are stored uncompressed in every zip.
        expect(body.includes('index.html')).toBe(true);
        expect(body.includes('assets/app.js')).toBe(true);
      });
    } finally {
      await foundry.close();
    }
  });

  it('404s for unknown and invalid build ids', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const missing = await fetch(`${base}/api/builds/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/download`);
        expect(missing.status).toBe(404);
        expect(((await missing.json()) as { error: string }).error).toContain('no such build');

        const invalid = await fetch(`${base}/api/builds/..%2f..%2fetc/download`);
        expect(invalid.status).toBe(404);
      });
    } finally {
      await foundry.close();
    }
  });
});
