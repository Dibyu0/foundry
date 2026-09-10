import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  listSiteFiles,
  newSiteId,
  readSiteFile,
  writeSiteFile,
} from '../src/sites.js';

let root: string;
let sites: string;
let id: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-race-'));
  sites = path.join(root, 'sites');
  id = newSiteId();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Outcome = 'ok' | { code?: string };

function attempt(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => 'ok' as const,
    (err: unknown) => err as { code?: string },
  );
}

describe('writeSiteFile under parallel writes', () => {
  it('never overshoots the file-count cap', async () => {
    // One slot left; three writers race for it. Without serialization each
    // can observe count == MAX_FILES - 1 and all three would land.
    for (let i = 0; i < MAX_FILES - 1; i++) {
      await writeSiteFile(sites, id, `seed-${i}.txt`, 'seed');
    }
    const results = await Promise.all([
      attempt(writeSiteFile(sites, id, 'race-a.txt', 'a')),
      attempt(writeSiteFile(sites, id, 'race-b.txt', 'b')),
      attempt(writeSiteFile(sites, id, 'race-c.txt', 'c')),
    ]);
    const ok = results.filter((r) => r === 'ok');
    const rejected = results.filter((r) => r !== 'ok') as Array<{ code?: string }>;
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const err of rejected) {
      expect(err.code).toBe('TOO_MANY_FILES');
    }
    expect(await listSiteFiles(sites, id)).toHaveLength(MAX_FILES);
  });

  it('never overshoots the total-bytes cap', async () => {
    // 8 * MAX_FILE_BYTES == MAX_TOTAL_BYTES exactly, so precisely eight of
    // the nine parallel writes fit; the ninth must fail, not land alongside.
    expect((MAX_TOTAL_BYTES / MAX_FILE_BYTES) % 1).toBe(0);
    const fits = MAX_TOTAL_BYTES / MAX_FILE_BYTES;
    const payload = Buffer.alloc(MAX_FILE_BYTES, 7);
    const results = await Promise.all(
      Array.from({ length: fits + 1 }, (_, i) => attempt(writeSiteFile(sites, id, `blob-${i}.bin`, payload))),
    );
    const ok = results.filter((r) => r === 'ok');
    const rejected = results.filter((r) => r !== 'ok') as Array<{ code?: string }>;
    expect(ok).toHaveLength(fits);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe('SITE_TOO_LARGE');
    const entries = await listSiteFiles(sites, id);
    expect(entries.reduce((sum, e) => sum + e.size, 0)).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it('counts a parallel overwrite against the bytes it replaces', async () => {
    const payload = Buffer.alloc(MAX_FILE_BYTES, 1);
    await writeSiteFile(sites, id, 'kept.bin', payload);
    // Overwriting kept.bin with same-size content must always fit, no
    // matter what else lands concurrently.
    const results = await Promise.all([
      attempt(writeSiteFile(sites, id, 'kept.bin', payload)),
      attempt(writeSiteFile(sites, id, 'extra.bin', payload)),
    ]);
    expect(results).toEqual(['ok', 'ok']);
    expect(await readSiteFile(sites, id, 'kept.bin')).toEqual(payload);
  });

  it('releases the lock when a write fails, so queued writes still land', async () => {
    const results = await Promise.allSettled([
      writeSiteFile(sites, id, 'bad.svg', 'not an svg'),
      writeSiteFile(sites, id, 'a.txt', 'a'),
      writeSiteFile(sites, id, 'b.txt', 'b'),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]?.status).toBe('fulfilled');
    expect(results[2]?.status).toBe('fulfilled');
    expect((await readSiteFile(sites, id, 'b.txt')).toString('utf8')).toBe('b');
  });

  it('locks per site id: different sites write independently', async () => {
    const other = newSiteId();
    await Promise.all([
      writeSiteFile(sites, id, 'x.txt', 'one'),
      writeSiteFile(sites, other, 'x.txt', 'two'),
    ]);
    expect((await readSiteFile(sites, id, 'x.txt')).toString('utf8')).toBe('one');
    expect((await readSiteFile(sites, other, 'x.txt')).toString('utf8')).toBe('two');
  });
});
