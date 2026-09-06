import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckpointService } from '../src/agent/checkpoints.js';
import {
  createCheckpointsRouter,
  type CheckpointInfo,
  type CheckpointServiceLike,
} from '../src/routes/checkpoints.js';
import { listSiteFiles, readSiteFile, writeSiteFile } from '../src/sites.js';
import {
  createScriptedProvider,
  eventsFor,
  finishJson,
  hangUntilAbort,
  makeWorld,
  planJson,
  waitFor,
  type World,
} from './helpers.js';

/* ------------------------------------------------------------------ */
/* Honest fake checkpoint service: real snapshots under a temp dir,   */
/* same contract server/src/checkpoints.ts must satisfy.              */
/* ------------------------------------------------------------------ */

class FsCheckpointService implements CheckpointServiceLike {
  constructor(private readonly root: string) {}

  private dirFor(buildId: string, n: number): string {
    return path.join(this.root, buildId, String(n));
  }

  async list(_sitesRoot: string, buildId: string): Promise<CheckpointInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.root, buildId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: CheckpointInfo[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const meta = JSON.parse(
        await fs.readFile(path.join(this.root, buildId, name, 'meta.json'), 'utf8'),
      ) as CheckpointInfo;
      out.push(meta);
    }
    return out.sort((a, b) => a.n - b.n);
  }

  async restore(sitesRoot: string, buildId: string, n: number): Promise<CheckpointInfo | null> {
    const dir = this.dirFor(buildId, n);
    let metaRaw: string;
    try {
      metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const siteDir = path.join(sitesRoot, buildId);
    await fs.rm(siteDir, { recursive: true, force: true });
    await fs.mkdir(siteDir, { recursive: true });
    await fs.cp(path.join(dir, 'files'), siteDir, { recursive: true });
    return JSON.parse(metaRaw) as CheckpointInfo;
  }

  /** Test-only helper: captures the current site dir as the next checkpoint. */
  async snapshot(sitesRoot: string, buildId: string, label: string): Promise<CheckpointInfo> {
    const existing = await this.list(sitesRoot, buildId);
    const n = existing.length === 0 ? 1 : Math.max(...existing.map((c) => c.n)) + 1;
    const dir = this.dirFor(buildId, n);
    const filesDir = path.join(dir, 'files');
    await fs.mkdir(filesDir, { recursive: true });
    try {
      await fs.cp(path.join(sitesRoot, buildId), filesDir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const entries = await listSiteFiles(sitesRoot, buildId);
    const meta: CheckpointInfo = {
      n,
      createdAt: Date.now(),
      label,
      files: entries.length,
      bytes: entries.reduce((sum, e) => sum + e.size, 0),
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    return meta;
  }
}

/* ------------------------------------------------------------------ */

const worlds: World[] = [];

async function world(opts: Parameters<typeof makeWorld>[0] = {}): Promise<World> {
  const w = await makeWorld(opts);
  worlds.push(w);
  return w;
}

afterEach(async () => {
  while (worlds.length > 0) {
    const w = worlds.pop();
    if (w === undefined) break;
    w.hub.shutdown();
    await w.orchestrator.flush();
    await fs.rm(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function mountApp(w: World, service: CheckpointServiceLike): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/builds',
    createCheckpointsRouter({ sitesRoot: w.sitesRoot, builds: w.orchestrator, service, hub: w.hub }),
  );
  return app;
}

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

/** Drives a real build through the mock pipeline to DONE (seeding real state). */
async function driveToDone(w: World): Promise<string> {
  const { id } = w.orchestrator.createBuild('A landing page for a coffee roaster');
  await waitFor(() => w.orchestrator.get(id)?.pendingQuestion?.id === 'q1', 'q1');
  w.orchestrator.answer(id, 'q1', 'Small-batch roaster');
  await waitFor(() => w.orchestrator.get(id)?.pendingQuestion?.id === 'q2', 'q2');
  w.orchestrator.answer(id, 'q2', 'Warm and minimal');
  await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
  w.orchestrator.approve(id);
  await waitFor(() => w.orchestrator.get(id)?.phase === 'DONE', 'done', 20_000);
  return id;
}

describe('checkpoints api', () => {
  it('lists checkpoints for a build, validated and ordered by n', { timeout: 30_000 }, async () => {
    const w = await world();
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    const id = await driveToDone(w);
    await service.snapshot(w.sitesRoot, id, 'initial build');
    await writeSiteFile(w.sitesRoot, id, 'styles.css', '/* v2 */\n:root { --x: 1; }');
    await service.snapshot(w.sitesRoot, id, 'edit: restyle');
    // Junk on disk must never reach the wire.
    await fs.mkdir(path.join(w.dir, 'checkpoints', id, '99'), { recursive: true });
    await fs.writeFile(
      path.join(w.dir, 'checkpoints', id, '99', 'meta.json'),
      JSON.stringify({ n: 'x', createdAt: 'soon' }),
      'utf8',
    );
    await fs.mkdir(path.join(w.dir, 'checkpoints', id, 'stray'), { recursive: true });

    await withServer(mountApp(w, service), async (base) => {
      const res = await fetch(`${base}/api/builds/${id}/checkpoints`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CheckpointInfo[];
      expect(body.length).toBe(2);
      expect(body[0]?.n).toBe(1);
      expect(body[1]?.n).toBe(2);
      expect(body[0]?.label).toBe('initial build');
      expect(body[1]?.label).toBe('edit: restyle');
      for (const c of body) {
        expect(typeof c.createdAt).toBe('number');
        expect(c.files).toBeGreaterThan(0);
        expect(c.bytes).toBeGreaterThan(0);
      }
    });
  });

  it('GET checkpoints 404s for an unknown build and 400s for an invalid id', async () => {
    const w = await world();
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    await withServer(mountApp(w, service), async (base) => {
      const missing = await fetch(`${base}/api/builds/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/checkpoints`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toContain('unknown build id');

      const invalid = await fetch(`${base}/api/builds/not-a-valid-id!/checkpoints`);
      expect(invalid.status).toBe(400);
    });
  });

  it('restores a checkpoint: 200, files match the snapshot, phase event emitted', { timeout: 30_000 }, async () => {
    const w = await world();
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    const id = await driveToDone(w);

    const originalCss = (await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8');
    const originalHtml = (await readSiteFile(w.sitesRoot, id, 'index.html')).toString('utf8');
    const originalFiles = (await listSiteFiles(w.sitesRoot, id)).map((e) => e.path);
    const snap1 = await service.snapshot(w.sitesRoot, id, 'initial build');

    // Mutate the live site, then snapshot again so checkpoint 1 differs.
    await writeSiteFile(w.sitesRoot, id, 'styles.css', '/* mutated */\n');
    await fs.rm(path.join(w.sitesRoot, id, 'README.md'));
    await service.snapshot(w.sitesRoot, id, 'after mutation');

    const eventsBefore = eventsFor(w.events, id).length;
    await withServer(mountApp(w, service), async (base) => {
      const res = await fetch(`${base}/api/builds/${id}/checkpoints/${snap1.n}/restore`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; restored: number; checkpoint: CheckpointInfo };
      expect(body.ok).toBe(true);
      expect(body.restored).toBe(1);
      expect(body.checkpoint.n).toBe(1);
      expect(body.checkpoint.label).toBe('initial build');
    });

    // Restored files on disk match the snapshot byte-for-byte.
    expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toBe(originalCss);
    expect((await readSiteFile(w.sitesRoot, id, 'index.html')).toString('utf8')).toBe(originalHtml);
    expect((await listSiteFiles(w.sitesRoot, id)).map((e) => e.path)).toEqual(originalFiles);

    // The route re-emitted the current phase so clients refresh.
    const fresh = eventsFor(w.events, id).slice(eventsBefore);
    expect(fresh.some((e) => e.type === 'phase' && e.phase === 'DONE')).toBe(true);
  });

  it('restore 400s on junk checkpoint numbers', { timeout: 30_000 }, async () => {
    const w = await world();
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    const id = await driveToDone(w);
    await service.snapshot(w.sitesRoot, id, 'initial build');
    await withServer(mountApp(w, service), async (base) => {
      for (const junk of ['abc', '0', '-1', '1.5', '1e3']) {
        const res = await fetch(`${base}/api/builds/${id}/checkpoints/${junk}/restore`, { method: 'POST' });
        expect(res.status, `n=${junk}`).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain('positive integer');
      }
    });
  });

  it('restore 404s for an unknown build and for an unknown checkpoint', { timeout: 30_000 }, async () => {
    const w = await world();
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    const id = await driveToDone(w);
    await withServer(mountApp(w, service), async (base) => {
      const missingBuild = await fetch(
        `${base}/api/builds/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/checkpoints/1/restore`,
        { method: 'POST' },
      );
      expect(missingBuild.status).toBe(404);
      expect(((await missingBuild.json()) as { error: string }).error).toContain('unknown build id');

      // Known build, no checkpoints taken yet.
      const missingCkpt = await fetch(`${base}/api/builds/${id}/checkpoints/7/restore`, { method: 'POST' });
      expect(missingCkpt.status).toBe(404);
      expect(((await missingCkpt.json()) as { error: string }).error).toContain('unknown checkpoint 7');
    });
  });

  it('restore 409s while the build is actively running; list stays readable', { timeout: 30_000 }, async () => {
    const w = await world({
      provider: createScriptedProvider({
        planner: () => planJson(),
        design: hangUntilAbort(),
        copy: () => finishJson,
        builder: () => finishJson,
        reviewer: () => finishJson,
      }),
    });
    const service = new FsCheckpointService(path.join(w.dir, 'checkpoints'));
    const { id } = w.orchestrator.createBuild('A portfolio site');
    await waitFor(() => w.orchestrator.get(id)?.phase === 'PLANNED', 'planned');
    w.orchestrator.approve(id);
    await waitFor(() => w.orchestrator.get(id)?.phase === 'BUILDING', 'building');

    try {
      await withServer(mountApp(w, service), async (base) => {
        const res = await fetch(`${base}/api/builds/${id}/checkpoints/1/restore`, { method: 'POST' });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('building');

        const list = await fetch(`${base}/api/builds/${id}/checkpoints`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual([]);
      });
    } finally {
      w.orchestrator.cancel(id);
      await w.orchestrator.whenSettled(id);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Same routes, but wired to the real CKPT-SVC checkpoint service     */
/* (server/src/agent/checkpoints.ts) to prove the structural seam.    */
/* ------------------------------------------------------------------ */

describe('checkpoints api with the real checkpoint service', () => {
  it('lists and restores through createCheckpointService', { timeout: 30_000 }, async () => {
    const w = await world();
    const service = createCheckpointService({ dataDir: w.dataDir, sitesStore: w.sitesRoot });
    const id = await driveToDone(w);

    const originalCss = (await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8');
    const snap = await service.snapshot(id, 'initial build');
    await writeSiteFile(w.sitesRoot, id, 'styles.css', '/* mutated */\n');

    const eventsBefore = eventsFor(w.events, id).length;
    await withServer(mountApp(w, service), async (base) => {
      const list = await fetch(`${base}/api/builds/${id}/checkpoints`);
      expect(list.status).toBe(200);
      const checkpoints = (await list.json()) as CheckpointInfo[];
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0]?.n).toBe(snap.n);
      expect(checkpoints[0]?.label).toBe('initial build');
      expect(checkpoints[0]?.files).toBe(snap.files);

      const res = await fetch(`${base}/api/builds/${id}/checkpoints/${snap.n}/restore`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; restored: number; checkpoint: CheckpointInfo };
      expect(body.ok).toBe(true);
      expect(body.restored).toBe(snap.n);
      expect(body.checkpoint.label).toBe('initial build');

      // The real service throws CheckpointError(404) for an unknown checkpoint.
      const missing = await fetch(`${base}/api/builds/${id}/checkpoints/9/restore`, { method: 'POST' });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toContain('no checkpoint 9');
    });

    expect((await readSiteFile(w.sitesRoot, id, 'styles.css')).toString('utf8')).toBe(originalCss);
    const fresh = eventsFor(w.events, id).slice(eventsBefore);
    expect(fresh.some((e) => e.type === 'phase' && e.phase === 'DONE')).toBe(true);
  });
});
