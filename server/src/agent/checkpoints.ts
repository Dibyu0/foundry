import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertValidId, siteDir } from '../sites.js';

/**
 * Checkpoint service for builds. snapshot() copies the live site dir into
 * <dataDir>/builds/<id>/checkpoints/<n>/ (staged in a tmp dir, then renamed
 * into place); restore() swaps checkpoint content back into the live site
 * dir (staged beside it, then renamed, with rollback so the live site is
 * never left half-restored). At most MAX_CHECKPOINTS are kept per build;
 * the oldest are pruned and sequence numbers are never reused.
 *
 * Metadata lives in a sibling <n>.json, never inside the snapshot dir, so a
 * site file can never collide with it. A crash mid-snapshot leaves only
 * dot-prefixed staging dirs or orphan metadata, which list() ignores and
 * the next snapshot sweeps. Operations on one build id are serialized on a
 * per-build promise chain so numbering and swapping cannot race.
 */

export const MAX_CHECKPOINTS = 12;
export const MAX_LABEL_CHARS = 200;

export type CheckpointErrorCode =
  | 'BAD_CHECKPOINT'
  | 'BAD_ENTRY'
  | 'BAD_LABEL'
  | 'BAD_STORE'
  | 'NO_SITE'
  | 'NOT_FOUND'
  | 'RESTORE_FAILED'
  | 'SNAPSHOT_FAILED';

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  readonly status: number;

  constructor(code: CheckpointErrorCode, message: string, status: number) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
    this.status = status;
  }
}

/** One stored checkpoint as reported by snapshot/list/restore. */
export interface CheckpointInfo {
  /** 1-based sequence number; never reused within a build, even after pruning. */
  n: number;
  label: string;
  /** Epoch ms from the service clock. */
  createdAt: number;
  files: number;
  bytes: number;
}

export interface SnapshotResult extends CheckpointInfo {
  /** Checkpoints stored for the build after the cap prune. */
  count: number;
  /** Sequence numbers dropped by the cap (oldest first). */
  pruned: number[];
}

/** The confined site store: either its root path or an object carrying it. */
export type SitesStoreLike = string | { root: string };

export interface CheckpointServiceDeps {
  /** Data root; checkpoints live under <dataDir>/builds/<id>/checkpoints/. */
  dataDir: string;
  /** Default site store (sites.ts root); restore/list accept per-call overrides. */
  sitesStore: SitesStoreLike;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Cap per build; defaults to MAX_CHECKPOINTS (12). */
  maxCheckpoints?: number;
}

export interface CheckpointService {
  /** Snapshots the build's current site dir. Throws NO_SITE (404) when there is none. */
  snapshot(buildId: string, label: string): Promise<SnapshotResult>;
  /** Call shape with the store root first, for callers that hold it per call. */
  snapshot(sitesRoot: string, buildId: string, label: string): Promise<SnapshotResult>;
  list(buildId: string): Promise<CheckpointInfo[]>;
  /**
   * routes/checkpoints.ts (CKPT-API) seam: store root passed per call. The
   * root is accepted for interface symmetry; checkpoints are keyed by build
   * id under dataDir, so list never reads the site store.
   */
  list(sitesRoot: string, buildId: string): Promise<CheckpointInfo[]>;
  /**
   * Swaps the live site dir back to checkpoint n. Throws NOT_FOUND (404)
   * when the checkpoint does not exist; current files are untouched on any
   * failure.
   */
  restore(buildId: string, n: number, sitesStore?: SitesStoreLike): Promise<CheckpointInfo>;
  /** routes/checkpoints.ts (CKPT-API) seam: store root passed per call. */
  restore(sitesRoot: string, buildId: string, n: number): Promise<CheckpointInfo>;
}

interface CheckpointMeta {
  version: 1;
  label: string;
  createdAt: number;
  files: number;
  bytes: number;
}

interface TreeStats {
  files: number;
  bytes: number;
}

const DIR_PATTERN = /^(\d{1,10})$/;
const META_PATTERN = /^(\d{1,10})\.json$/;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function storeRoot(store: unknown): string {
  const root = typeof store === 'string' ? store : (store as { root?: unknown } | null | undefined)?.root;
  if (typeof root !== 'string' || root === '') {
    throw new CheckpointError('BAD_STORE', 'sitesStore must be a root path string or an object { root }', 500);
  }
  return root;
}

function suffix(): string {
  return `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
}

function enoentNull(err: unknown): null {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw err;
}

/**
 * Recursive copy refusing anything that is not a plain file or directory.
 * The site store never creates symlinks, so finding one means on-disk
 * tampering — and copying it into a live site would break confinement.
 */
async function copyTree(src: string, dst: string, stats: TreeStats): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyTree(s, d, stats);
    } else if (entry.isFile()) {
      const { size } = await fs.stat(s);
      await fs.copyFile(s, d);
      stats.files += 1;
      stats.bytes += size;
    } else {
      throw new CheckpointError('BAD_ENTRY', `refusing to copy non-regular entry (symlink or special file): ${s}`, 500);
    }
  }
}

/** Best-effort measure; entries pruned mid-walk are skipped, special entries ignored. */
async function measureTree(dir: string, stats: TreeStats): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await measureTree(abs, stats);
    } else if (entry.isFile()) {
      try {
        stats.bytes += (await fs.stat(abs)).size;
        stats.files += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
}

async function writeMetaAtomic(file: string, meta: CheckpointMeta): Promise<void> {
  const tmp = `${file}.${suffix()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta) + '\n', 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Missing/corrupt metadata degrades to ''/dir time; the checkpoint stays restorable. */
async function readMeta(file: string): Promise<{ label: string; createdAt: number } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CheckpointMeta> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.label !== 'string') return null;
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return null;
    return { label: parsed.label, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function dirTime(dir: string): Promise<number> {
  try {
    const stat = await fs.stat(dir);
    return Math.floor(stat.birthtimeMs || stat.mtimeMs);
  } catch {
    return 0;
  }
}

/** Sorted 1-based sequence numbers of checkpoint dirs directly under root. */
async function checkpointNumbers(root: string): Promise<number[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = DIR_PATTERN.exec(entry.name);
    if (m === null) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n >= 1) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  if (typeof deps?.dataDir !== 'string' || deps.dataDir === '') {
    throw new Error('createCheckpointService: dataDir must be a non-empty string');
  }
  const dataDir = deps.dataDir;
  const defaultRoot = storeRoot(deps.sitesStore);
  const now = deps.now ?? Date.now;
  const maxCheckpoints = deps.maxCheckpoints ?? MAX_CHECKPOINTS;
  if (!Number.isInteger(maxCheckpoints) || maxCheckpoints < 1) {
    throw new Error('createCheckpointService: maxCheckpoints must be a positive integer');
  }

  const checkpointsDir = (buildId: string): string => path.join(dataDir, 'builds', buildId, 'checkpoints');

  const chains = new Map<string, Promise<void>>();
  const enqueue = <T>(buildId: string, op: () => Promise<T>): Promise<T> => {
    const prev = chains.get(buildId) ?? Promise.resolve();
    const run = prev.then(op);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(buildId, tail);
    void tail.then(() => {
      if (chains.get(buildId) === tail) chains.delete(buildId);
    });
    return run;
  };

  const infoFor = async (root: string, n: number): Promise<CheckpointInfo> => {
    const dir = path.join(root, String(n));
    const meta = await readMeta(path.join(root, `${n}.json`));
    const stats: TreeStats = { files: 0, bytes: 0 };
    await measureTree(dir, stats);
    return {
      n,
      label: meta?.label ?? '',
      createdAt: meta?.createdAt ?? (await dirTime(dir)),
      files: stats.files,
      bytes: stats.bytes,
    };
  };

  /** Removes staging debris and orphan metadata left by crashed snapshots. */
  const sweep = async (root: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const numeric = new Set(
      entries.filter((e) => e.isDirectory() && DIR_PATTERN.test(e.name)).map((e) => e.name),
    );
    for (const entry of entries) {
      const staleStage = entry.name.startsWith('.stage-');
      const staleTmp = entry.name.endsWith('.tmp');
      const orphanMeta = META_PATTERN.test(entry.name) && !numeric.has(entry.name.slice(0, -'.json'.length));
      if (!staleStage && !staleTmp && !orphanMeta) continue;
      try {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
      } catch (err) {
        console.error(`[foundry] failed to sweep stale checkpoint entry ${entry.name}: ${errMsg(err)}`);
      }
    }
  };

  const snapshotAt = async (root: string, id: string, label: string): Promise<SnapshotResult> => {
    const src = siteDir(root, id);
    const srcStat = await fs.stat(src).catch(enoentNull);
    if (srcStat === null || !srcStat.isDirectory()) {
      throw new CheckpointError('NO_SITE', `no site files to checkpoint for build ${id}`, 404);
    }
    const ckptRoot = checkpointsDir(id);
    await fs.mkdir(ckptRoot, { recursive: true });
    await sweep(ckptRoot);
    const existing = await checkpointNumbers(ckptRoot);
    const last = existing.length === 0 ? 0 : (existing[existing.length - 1] ?? 0);
    const n = last + 1;
    const stage = path.join(ckptRoot, `.stage-${suffix()}`);
    const metaFile = path.join(ckptRoot, `${n}.json`);
    const createdAt = now();
    const stats: TreeStats = { files: 0, bytes: 0 };
    try {
      await copyTree(src, stage, stats);
      const meta: CheckpointMeta = { version: 1, label, createdAt, files: stats.files, bytes: stats.bytes };
      await writeMetaAtomic(metaFile, meta);
      // The rename is last so a visible checkpoint dir always has its
      // metadata; a crash before it leaves only debris list() ignores.
      await fs.rename(stage, path.join(ckptRoot, String(n)));
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(metaFile, { force: true }).catch(() => undefined);
      if (err instanceof CheckpointError) throw err;
      throw new CheckpointError('SNAPSHOT_FAILED', `failed to snapshot build ${id}: ${errMsg(err)}`, 500);
    }
    const pruned: number[] = [];
    const after = await checkpointNumbers(ckptRoot);
    for (const old of after.slice(0, Math.max(0, after.length - maxCheckpoints))) {
      try {
        await fs.rm(path.join(ckptRoot, String(old)), { recursive: true, force: true });
        await fs.rm(path.join(ckptRoot, `${old}.json`), { force: true });
        pruned.push(old);
      } catch (err) {
        console.error(`[foundry] failed to prune checkpoint ${old} of build ${id}: ${errMsg(err)}`);
      }
    }
    // Count is re-read from disk so it stays honest even if a prune failed.
    const count = (await checkpointNumbers(ckptRoot)).length;
    return { n, label, createdAt, files: stats.files, bytes: stats.bytes, count, pruned };
  };

  const restoreAt = async (root: string, id: string, n: number): Promise<CheckpointInfo> => {
    const ckptRoot = checkpointsDir(id);
    const ckptDir = path.join(ckptRoot, String(n));
    const ckptStat = await fs.stat(ckptDir).catch(enoentNull);
    if (ckptStat === null || !ckptStat.isDirectory()) {
      throw new CheckpointError('NOT_FOUND', `no checkpoint ${n} for build ${id}`, 404);
    }
    const site = siteDir(root, id);
    const tag = suffix();
    const stage = path.join(root, `.${id}.restore-${tag}`);
    const old = path.join(root, `.${id}.old-${tag}`);
    const stats: TreeStats = { files: 0, bytes: 0 };
    try {
      await copyTree(ckptDir, stage, stats);
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof CheckpointError) throw err;
      throw new CheckpointError('RESTORE_FAILED', `failed to restore checkpoint ${n} for build ${id}: ${errMsg(err)}`, 500);
    }
    const siteStat = await fs.stat(site).catch(enoentNull);
    // Atomic swap: site -> old, stage -> site. If the second rename fails the
    // first is rolled back, so the live site is never left half-restored.
    try {
      if (siteStat !== null) await fs.rename(site, old);
      try {
        await fs.rename(stage, site);
      } catch (err) {
        if (siteStat !== null) {
          await fs.rename(old, site).catch((rollbackErr: unknown) => {
            console.error(`[foundry] restore rollback failed for build ${id}: ${errMsg(rollbackErr)}`);
          });
        }
        throw err;
      }
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw new CheckpointError('RESTORE_FAILED', `failed to restore checkpoint ${n} for build ${id}: ${errMsg(err)}`, 500);
    }
    if (siteStat !== null) {
      await fs.rm(old, { recursive: true, force: true }).catch((err: unknown) => {
        console.error(`[foundry] failed to remove pre-restore site copy for build ${id}: ${errMsg(err)}`);
      });
    }
    const meta = await readMeta(path.join(ckptRoot, `${n}.json`));
    return {
      n,
      label: meta?.label ?? '',
      createdAt: meta?.createdAt ?? (await dirTime(ckptDir)),
      files: stats.files,
      bytes: stats.bytes,
    };
  };

  async function snapshot(a: string, b: string, c?: string): Promise<SnapshotResult> {
    const root = c === undefined ? defaultRoot : storeRoot(a);
    const id = c === undefined ? a : b;
    const label = c === undefined ? b : c;
    assertValidId(id);
    if (typeof label !== 'string') {
      throw new CheckpointError('BAD_LABEL', 'label must be a string', 400);
    }
    const trimmed = label.trim();
    if (trimmed.length > MAX_LABEL_CHARS) {
      throw new CheckpointError('BAD_LABEL', `label must be at most ${MAX_LABEL_CHARS} characters`, 400);
    }
    return enqueue(id, () => snapshotAt(root, id, trimmed));
  }

  async function list(a: string, b?: string): Promise<CheckpointInfo[]> {
    const id = b === undefined ? a : b;
    assertValidId(id);
    return enqueue(id, async () => {
      const root = checkpointsDir(id);
      const numbers = await checkpointNumbers(root);
      const out: CheckpointInfo[] = [];
      for (const n of numbers) out.push(await infoFor(root, n));
      return out;
    });
  }

  async function restore(a: string, b: number | string, c?: SitesStoreLike | number): Promise<CheckpointInfo> {
    const root = typeof b === 'number' ? (c === undefined ? defaultRoot : storeRoot(c)) : storeRoot(a);
    const id = typeof b === 'number' ? a : b;
    const n = typeof b === 'number' ? b : typeof c === 'number' ? c : Number.NaN;
    assertValidId(id);
    if (!Number.isInteger(n) || n < 1) {
      throw new CheckpointError('BAD_CHECKPOINT', `checkpoint number must be a positive integer: ${String(n)}`, 400);
    }
    return enqueue(id, () => restoreAt(root, id, n));
  }

  return { snapshot, list, restore };
}
