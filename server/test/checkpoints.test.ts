import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CheckpointError,
  MAX_CHECKPOINTS,
  createCheckpointService,
  type CheckpointService,
} from '../src/agent/checkpoints.js';
import { listSiteFiles, readSiteFile, writeSiteFile } from '../src/sites.js';

let root: string;
let sitesRoot: string;
let dataDir: string;
let clock: number;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-ckpt-'));
  sitesRoot = path.join(root, 'sites');
  dataDir = path.join(root, 'data');
  clock = 1_000;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeService(maxCheckpoints?: number): CheckpointService {
  return createCheckpointService({
    dataDir,
    sitesStore: sitesRoot,
    now: () => clock,
    ...(maxCheckpoints !== undefined ? { maxCheckpoints } : {}),
  });
}

const ID = 'build-1';
const ckptsDir = (id: string): string => path.join(dataDir, 'builds', id, 'checkpoints');
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');
const readSite = async (id: string, rel: string): Promise<string> =>
  (await readSiteFile(sitesRoot, id, rel)).toString('utf8');

describe('factory', () => {
  it('validates its configuration honestly', async () => {
    expect(() => createCheckpointService({ dataDir: '', sitesStore: sitesRoot })).toThrow(/dataDir/);
    expect(() => createCheckpointService({ dataDir, sitesStore: {} })).toThrow(CheckpointError);
    expect(() => createCheckpointService({ dataDir, sitesStore: { root: '' } })).toThrow(/sitesStore/);
    expect(() => createCheckpointService({ dataDir, sitesStore: sitesRoot, maxCheckpoints: 0 })).toThrow(
      /maxCheckpoints/,
    );
    const objectForm = createCheckpointService({ dataDir, sitesStore: { root: sitesRoot } });
    expect(await objectForm.list(ID)).toEqual([]);
  });
});

describe('snapshot', () => {
  it('copies the live site and reports honest counts', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', '<h1>v1</h1>');
    await writeSiteFile(sitesRoot, ID, 'assets/app.js', 'console.log(1)');
    const svc = makeService();

    const result = await svc.snapshot(ID, 'initial build');

    const bytes = byteLen('<h1>v1</h1>') + byteLen('console.log(1)');
    expect(result).toEqual({ n: 1, label: 'initial build', createdAt: 1_000, files: 2, bytes, count: 1, pruned: [] });
    // The copy is real and independent of the live dir.
    expect(await fs.readFile(path.join(ckptsDir(ID), '1', 'index.html'), 'utf8')).toBe('<h1>v1</h1>');
    expect(await fs.readFile(path.join(ckptsDir(ID), '1', 'assets', 'app.js'), 'utf8')).toBe('console.log(1)');
    const meta = JSON.parse(await fs.readFile(path.join(ckptsDir(ID), '1.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ version: 1, label: 'initial build', createdAt: 1_000, files: 2, bytes });
    // No staging debris or tmp files anywhere.
    expect((await fs.readdir(ckptsDir(ID))).sort()).toEqual(['1', '1.json']);
    expect(await fs.readdir(sitesRoot)).toEqual([ID]);
  });

  it('uses the injected clock for createdAt', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'x');
    const svc = makeService();
    await svc.snapshot(ID, 'one');
    clock = 4_250;
    const second = await svc.snapshot(ID, 'two');
    expect(second.createdAt).toBe(4_250);
    expect((await svc.list(ID)).map((e) => e.createdAt)).toEqual([1_000, 4_250]);
  });

  it('rejects when there is no site to snapshot', async () => {
    const svc = makeService();
    const err = await svc.snapshot('no-such-build', 'x').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CheckpointError);
    expect(err).toMatchObject({ code: 'NO_SITE', status: 404 });
  });

  it('validates labels honestly', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'x');
    const svc = makeService();
    await expect(svc.snapshot(ID, 42 as unknown as string)).rejects.toMatchObject({ code: 'BAD_LABEL', status: 400 });
    await expect(svc.snapshot(ID, 'x'.repeat(201))).rejects.toMatchObject({ code: 'BAD_LABEL' });
    expect((await svc.snapshot(ID, '  trimmed  ')).label).toBe('trimmed');
    expect((await svc.snapshot(ID, '')).label).toBe('');
  });

  it('rejects invalid build ids', async () => {
    const svc = makeService();
    await expect(svc.snapshot('../escape', 'x')).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(svc.list('../escape')).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(svc.restore('../escape', 1)).rejects.toMatchObject({ code: 'INVALID_ID' });
  });

  it('serializes concurrent snapshots for the same build', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'x');
    const svc = makeService();
    const [a, b] = await Promise.all([svc.snapshot(ID, 'one'), svc.snapshot(ID, 'two')]);
    expect([a.n, b.n].sort((x, y) => x - y)).toEqual([1, 2]);
    expect(await svc.list(ID)).toHaveLength(2);
  });
});

describe('list', () => {
  it('returns [] for a build with no checkpoints', async () => {
    expect(await makeService().list('unknown-build')).toEqual([]);
  });

  it('lists oldest-first, each checkpoint frozen at its own content', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'one');
    const svc = makeService();
    await svc.snapshot(ID, 'first');
    clock += 1_000;
    await writeSiteFile(sitesRoot, ID, 'index.html', 'two!!');
    await writeSiteFile(sitesRoot, ID, 'extra.js', 'x');
    await svc.snapshot(ID, 'second');

    const list = await svc.list(ID);
    expect(list.map((e) => e.n)).toEqual([1, 2]);
    expect(list[0]).toMatchObject({ label: 'first', createdAt: 1_000, files: 1, bytes: 3 });
    expect(list[1]).toMatchObject({ label: 'second', createdAt: 2_000, files: 2, bytes: 6 });
  });

  it('keeps listing a checkpoint whose metadata file is corrupt', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'data');
    const svc = makeService();
    await svc.snapshot(ID, 'base');
    await fs.writeFile(path.join(ckptsDir(ID), '1.json'), '{not json', 'utf8');

    const [entry] = await svc.list(ID);
    expect(entry).toMatchObject({ n: 1, label: '', files: 1, bytes: 4 });
    expect(entry?.createdAt).toBeGreaterThan(0);
    const restored = await svc.restore(ID, 1);
    expect(restored.label).toBe('');
    expect(await readSite(ID, 'index.html')).toBe('data');
  });
});

describe('prune', () => {
  it('drops the oldest beyond the cap and returns an honest count', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'x');
    const svc = makeService(3);
    for (let i = 1; i <= 3; i += 1) await svc.snapshot(ID, `s${i}`);

    const fourth = await svc.snapshot(ID, 's4');
    expect(fourth).toMatchObject({ n: 4, count: 3, pruned: [1] });
    expect((await svc.list(ID)).map((e) => `${e.n}:${e.label}`)).toEqual(['2:s2', '3:s3', '4:s4']);
    expect((await fs.readdir(ckptsDir(ID))).sort()).toEqual(['2', '2.json', '3', '3.json', '4', '4.json']);

    const fifth = await svc.snapshot(ID, 's5');
    // Sequence numbers are never reused after pruning.
    expect(fifth).toMatchObject({ n: 5, count: 3, pruned: [2] });
    expect((await svc.list(ID)).map((e) => e.n)).toEqual([3, 4, 5]);
  });

  it('caps at 12 by default', async () => {
    expect(MAX_CHECKPOINTS).toBe(12);
    await writeSiteFile(sitesRoot, ID, 'index.html', 'x');
    const svc = makeService();
    for (let i = 1; i <= 12; i += 1) await svc.snapshot(ID, `s${i}`);
    const thirteenth = await svc.snapshot(ID, 's13');
    expect(thirteenth).toMatchObject({ n: 13, count: 12, pruned: [1] });
    const list = await svc.list(ID);
    expect(list).toHaveLength(12);
    expect(list[0]?.n).toBe(2);
    expect(list[11]?.n).toBe(13);
  });
});

describe('restore', () => {
  it('round-trips: current files swap back, files added later are gone', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v1');
    await writeSiteFile(sitesRoot, ID, 'assets/app.js', 'a1');
    const svc = makeService();
    await svc.snapshot(ID, 'base');
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v2');
    await writeSiteFile(sitesRoot, ID, 'extra.js', 'e');

    const restored = await svc.restore(ID, 1);

    expect(restored).toEqual({ n: 1, label: 'base', createdAt: 1_000, files: 2, bytes: 4 });
    expect((await listSiteFiles(sitesRoot, ID)).map((e) => e.path)).toEqual(['assets/app.js', 'index.html']);
    expect(await readSite(ID, 'index.html')).toBe('v1');
    expect(await readSite(ID, 'assets/app.js')).toBe('a1');
    // The checkpoint itself survives the restore.
    expect((await svc.list(ID)).map((e) => e.n)).toEqual([1]);
    // The swap left no staging or pre-restore dirs behind.
    expect(await fs.readdir(sitesRoot)).toEqual([ID]);
  });

  it('restores into a missing site dir', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v1');
    const svc = makeService();
    await svc.snapshot(ID, 'base');
    await fs.rm(path.join(sitesRoot, ID), { recursive: true, force: true });

    const restored = await svc.restore(ID, 1);
    expect(restored.n).toBe(1);
    expect(await readSite(ID, 'index.html')).toBe('v1');
  });

  it('rejects unknown checkpoints without touching current files', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v1');
    const svc = makeService();
    await svc.snapshot(ID, 'base');
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v2');

    const err = await svc.restore(ID, 99).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CheckpointError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await readSite(ID, 'index.html')).toBe('v2');
    expect(await fs.readdir(sitesRoot)).toEqual([ID]);
  });

  it('validates the checkpoint number', async () => {
    const svc = makeService();
    await expect(svc.restore(ID, 0)).rejects.toMatchObject({ code: 'BAD_CHECKPOINT', status: 400 });
    await expect(svc.restore(ID, 1.5)).rejects.toMatchObject({ code: 'BAD_CHECKPOINT' });
    await expect(svc.restore(ID, Number.NaN)).rejects.toMatchObject({ code: 'BAD_CHECKPOINT' });
  });

  it('refuses planted symlinks and leaves current files intact on failure', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'before');
    const svc = makeService();
    await svc.snapshot(ID, 'base');
    await writeSiteFile(sitesRoot, ID, 'index.html', 'after');
    // A junction on Windows / plain symlink on POSIX; either way it must not
    // be copied into the live site.
    await fs.symlink(sitesRoot, path.join(ckptsDir(ID), '1', 'planted'), 'junction');

    const err = await svc.restore(ID, 1).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CheckpointError);
    expect(err).toMatchObject({ code: 'BAD_ENTRY' });
    expect(await readSite(ID, 'index.html')).toBe('after');
    expect(await fs.readdir(sitesRoot)).toEqual([ID]);
  });
});

describe('CKPT-API seam (routes/checkpoints.ts call shapes)', () => {
  it('supports the (sitesRoot, buildId[, n]) argument order', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v1');
    const svc = makeService();
    await svc.snapshot(ID, 'base');

    expect(await svc.list(sitesRoot, ID)).toHaveLength(1);

    await writeSiteFile(sitesRoot, ID, 'index.html', 'v2');
    const restored = await svc.restore(sitesRoot, ID, 1);
    expect(restored).toMatchObject({ n: 1, label: 'base' });
    expect(await readSite(ID, 'index.html')).toBe('v1');

    await writeSiteFile(sitesRoot, ID, 'index.html', 'v3');
    await svc.restore(ID, 1, sitesRoot);
    expect(await readSite(ID, 'index.html')).toBe('v1');
  });

  it('supports snapshot(sitesRoot, buildId, label)', async () => {
    await writeSiteFile(sitesRoot, ID, 'index.html', 'v1');
    const svc = makeService();
    const result = await svc.snapshot(sitesRoot, ID, 'edit: restyle');
    expect(result).toMatchObject({ n: 1, label: 'edit: restyle', files: 1, count: 1 });
    expect(await fs.readFile(path.join(ckptsDir(ID), '1', 'index.html'), 'utf8')).toBe('v1');
    expect(await svc.list(ID)).toHaveLength(1);
  });
});
