import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// Per-type caps for asset files, each stricter than MAX_FILE_BYTES.
export const MAX_ICO_BYTES = 100 * 1024;
export const MAX_SVG_BYTES = 256 * 1024;
export const MAX_FONT_BYTES = 256 * 1024; // covers .woff and .woff2
export const MAX_JSON_BYTES = 64 * 1024;

export type SiteErrorCode =
  | 'INVALID_ID'
  | 'BAD_PATH'
  | 'PATH_TRAVERSAL'
  | 'NOT_FOUND'
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'SITE_TOO_LARGE'
  | 'INVALID_CONTENT'
  | 'SYMLINK';

export class SiteError extends Error {
  readonly code: SiteErrorCode;
  readonly status: number;

  constructor(code: SiteErrorCode, message: string, status: number) {
    super(message);
    this.name = 'SiteError';
    this.code = code;
    this.status = status;
  }
}

export interface SiteFileEntry {
  /** Path relative to the site root, forward slashes. */
  path: string;
  size: number;
}

export interface SiteFileBytesEntry {
  /** Path relative to the site root, forward slashes. */
  path: string;
  bytes: number;
}

// Build ids are randomUUIDs; pinning the charset keeps the id itself
// from ever becoming a path-traversal vector.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function newSiteId(): string {
  return randomUUID();
}

export function assertValidId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new SiteError('INVALID_ID', `invalid site id: ${JSON.stringify(id)}`, 400);
  }
}

export function siteDir(sitesRoot: string, id: string): string {
  assertValidId(id);
  return path.join(sitesRoot, id);
}

export async function siteExists(sitesRoot: string, id: string): Promise<boolean> {
  try {
    return (await fs.stat(siteDir(sitesRoot, id))).isDirectory();
  } catch {
    return false;
  }
}

function assertRelative(rel: string): void {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new SiteError('BAD_PATH', 'path must be a non-empty string', 400);
  }
  if (rel.includes('\0')) {
    throw new SiteError('BAD_PATH', 'path contains a NUL byte', 400);
  }
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('//')) {
    throw new SiteError('BAD_PATH', `absolute paths are not allowed: ${JSON.stringify(rel)}`, 400);
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Realpath of target, tolerating a not-yet-existing tail: the deepest
 * existing ancestor is realpath'd and the missing segments re-appended.
 * Needed before lexical containment checks, since a caller-supplied path
 * can differ from fs.realpath output in case or 8.3 short-name form.
 */
async function realpathLenient(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = path.dirname(target);
    if (parent === target) throw err;
    return path.join(await realpathLenient(parent), path.basename(target));
  }
}

/** Realpath of the deepest existing ancestor of target (inclusive). */
async function nearestExistingRealpath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * Resolves `rel` inside the site dir, rejecting anything that escapes —
 * lexically (.., absolute, UNC, NUL) and through symlinks (realpath of the
 * target or, for not-yet-created files, of its nearest existing ancestor).
 * We never create symlinks ourselves. Returns the absolute confined path.
 */
export async function resolveSitePath(sitesRoot: string, id: string, rel: string): Promise<string> {
  assertRelative(rel);
  const root = siteDir(sitesRoot, id);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SiteError('NOT_FOUND', `no such site: ${id}`, 404);
    }
    throw err;
  }
  const target = path.resolve(rootReal, rel);
  if (!isWithin(rootReal, target)) {
    throw new SiteError('PATH_TRAVERSAL', `path escapes the site directory: ${JSON.stringify(rel)}`, 403);
  }
  let targetReal: string;
  try {
    targetReal = await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    targetReal = await nearestExistingRealpath(target);
  }
  if (targetReal !== rootReal && !isWithin(rootReal, targetReal)) {
    throw new SiteError('PATH_TRAVERSAL', `path escapes the site directory: ${JSON.stringify(rel)}`, 403);
  }
  return target;
}

export async function createSite(sitesRoot: string, id: string = newSiteId()): Promise<string> {
  const dir = siteDir(sitesRoot, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function totals(sitesRoot: string, id: string): Promise<{ count: number; bytes: number; sizes: Map<string, number> }> {
  const entries = await listSiteFiles(sitesRoot, id);
  const sizes = new Map(entries.map((e) => [e.path, e.size]));
  return { count: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0), sizes };
}

// Parallel writes to the same site race between the totals() check and
// fs.writeFile: two writers can each observe a state where their own file
// still fits, then both write, overshooting MAX_FILES / MAX_TOTAL_BYTES.
// Serialize the check-and-write section per site id with a promise-chain
// lock: each caller queues on the current chain tail, and the map entry is
// dropped when the tail settles with nobody queued behind it, so idle
// sites leave nothing in the map.
const siteWriteLocks = new Map<string, Promise<void>>();

async function withSiteWriteLock<T>(sitesRoot: string, id: string, critical: () => Promise<T>): Promise<T> {
  const lockKey = `${path.resolve(sitesRoot)}${path.sep}${id}`;
  const prev = siteWriteLocks.get(lockKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  siteWriteLocks.set(lockKey, tail);
  await prev;
  try {
    return await critical();
  } finally {
    release();
    if (siteWriteLocks.get(lockKey) === tail) {
      siteWriteLocks.delete(lockKey);
    }
  }
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

type Sniffer = (bytes: Buffer) => string | null;

function sniffSvg(bytes: Buffer): string | null {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.replace(/^\s+/, '').startsWith('<')) {
    return 'svg content must start with "<" (after an optional BOM and whitespace)';
  }
  if (!text.includes('<svg')) return 'svg content must contain an "<svg" tag';
  return null;
}

function sniffJson(bytes: Buffer): string | null {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    JSON.parse(text);
  } catch (err) {
    return `json content does not parse: ${(err as Error).message}`;
  }
  return null;
}

interface AssetRule {
  maxBytes: number;
  sniff?: Sniffer;
}

// Asset types carry a tighter per-type cap than the generic MAX_FILE_BYTES;
// the text formats are also content-sniffed so mislabeled content fails at
// write time instead of being served under an asset content type later.
const ASSET_RULES: Record<string, AssetRule> = {
  '.ico': { maxBytes: MAX_ICO_BYTES },
  '.svg': { maxBytes: MAX_SVG_BYTES, sniff: sniffSvg },
  '.woff': { maxBytes: MAX_FONT_BYTES },
  '.woff2': { maxBytes: MAX_FONT_BYTES },
  '.json': { maxBytes: MAX_JSON_BYTES, sniff: sniffJson },
};

function maxBytesFor(rel: string): number {
  return ASSET_RULES[path.extname(rel).toLowerCase()]?.maxBytes ?? MAX_FILE_BYTES;
}

export async function writeSiteFile(
  sitesRoot: string,
  id: string,
  rel: string,
  content: string | Buffer,
): Promise<void> {
  await createSite(sitesRoot, id);
  const target = await resolveSitePath(sitesRoot, id, rel);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new SiteError('FILE_TOO_LARGE', `file exceeds ${MAX_FILE_BYTES} bytes: ${rel}`, 413);
  }
  const rule = ASSET_RULES[path.extname(rel).toLowerCase()];
  if (rule !== undefined) {
    if (bytes.length > rule.maxBytes) {
      throw new SiteError(
        'FILE_TOO_LARGE',
        `${path.extname(rel).toLowerCase()} files are limited to ${rule.maxBytes} bytes: ${rel}`,
        413,
      );
    }
    const problem = rule.sniff?.(bytes);
    if (problem != null) {
      throw new SiteError('INVALID_CONTENT', `${problem}: ${rel}`, 400);
    }
  }
  const key = normalizeRel(rel);
  // The cap check and the write must be atomic against other writes to the
  // same site, or parallel builder rounds overshoot the caps.
  return withSiteWriteLock(sitesRoot, id, async () => {
    const { count, bytes: total, sizes } = await totals(sitesRoot, id);
    const replaced = sizes.get(key) ?? 0;
    const isNew = !sizes.has(key);
    if (isNew && count >= MAX_FILES) {
      throw new SiteError('TOO_MANY_FILES', `site already has ${MAX_FILES} files`, 413);
    }
    if (total - replaced + bytes.length > MAX_TOTAL_BYTES) {
      throw new SiteError('SITE_TOO_LARGE', `site would exceed ${MAX_TOTAL_BYTES} bytes`, 413);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  });
}

export async function readSiteFile(sitesRoot: string, id: string, rel: string): Promise<Buffer> {
  const target = await resolveSitePath(sitesRoot, id, rel);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new SiteError('NOT_FOUND', `not a file: ${rel}`, 404);
    }
    return await fs.readFile(target);
  } catch (err) {
    if (err instanceof SiteError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SiteError('NOT_FOUND', `no such file: ${rel}`, 404);
    }
    throw err;
  }
}

async function walkSiteFiles(root: string): Promise<SiteFileEntry[]> {
  const out: SiteFileEntry[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push({ path: rel, size: (await fs.stat(abs)).size });
      }
      // Symlinks and special files are skipped; we never create them.
    }
  };
  await walk(root, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function listSiteFiles(sitesRoot: string, id: string): Promise<SiteFileEntry[]>;
export async function listSiteFiles(sitesRoot: string, id: string, opts: { withBytes: true }): Promise<SiteFileBytesEntry[]>;
export async function listSiteFiles(
  sitesRoot: string,
  id: string,
  opts?: { withBytes?: boolean },
): Promise<SiteFileEntry[] | SiteFileBytesEntry[]> {
  const entries = await walkSiteFiles(siteDir(sitesRoot, id));
  if (opts?.withBytes === true) {
    return entries.map((e) => ({ path: e.path, bytes: e.size }));
  }
  return entries;
}

/**
 * Copies a site tree into `destDir` (a checkpoint snapshot destination).
 * Regular files only, relative structure preserved; empty directories are
 * not carried over. Symlinks anywhere in the tree are refused (SYMLINK)
 * rather than followed, and every file is re-checked against the per-type
 * size caps, so a tree tampered with out of band cannot leak oversized or
 * escaping content into a checkpoint. Non-regular, non-symlink special
 * files are skipped: the store never creates them and they hold no content.
 *
 * Atomicity: the tree is copied to a sibling `.<name>.copy-<uuid>` dir and
 * then renamed into place; the sibling location keeps the rename on the
 * same filesystem. When `destDir` does not exist, that single rename is
 * atomic. When replacing an existing `destDir`, the old tree is first
 * renamed aside to a `.<name>.old-<uuid>` backup and deleted after the
 * swap; a crash between the two renames can leave the destination missing
 * or a backup behind, and on rename failure a rollback rename is
 * attempted. `destDir` must not sit inside the source site or contain it.
 */
export async function copySiteDir(sitesRoot: string, srcId: string, destDir: string): Promise<void> {
  const src = siteDir(sitesRoot, srcId);
  let srcReal: string;
  try {
    srcReal = await fs.realpath(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SiteError('NOT_FOUND', `no such site: ${srcId}`, 404);
    }
    throw err;
  }
  const destAbs = path.resolve(destDir);
  const destReal = await realpathLenient(destAbs);
  if (destReal === srcReal || isWithin(srcReal, destReal)) {
    throw new SiteError('BAD_PATH', `destination is inside the source site: ${destDir}`, 400);
  }
  if (isWithin(destReal, srcReal)) {
    throw new SiteError('BAD_PATH', `destination contains the source site: ${destDir}`, 400);
  }
  const parent = path.dirname(destAbs);
  await fs.mkdir(parent, { recursive: true });
  const base = path.basename(destAbs);
  const tmp = path.join(parent, `.${base}.copy-${randomUUID()}`);
  const backup = path.join(parent, `.${base}.old-${randomUUID()}`);

  const copyTree = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const srcAbs = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new SiteError('SYMLINK', `refusing to copy a symlink: ${rel}`, 500);
      }
      if (entry.isDirectory()) {
        await copyTree(srcAbs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // special files carry no site content
      // lstat right before copying so a symlink swapped in after the
      // directory read is still refused rather than followed.
      const stat = await fs.lstat(srcAbs);
      if (stat.isSymbolicLink()) {
        throw new SiteError('SYMLINK', `refusing to copy a symlink: ${rel}`, 500);
      }
      if (!stat.isFile()) continue;
      const cap = maxBytesFor(rel);
      if (stat.size > cap) {
        throw new SiteError('FILE_TOO_LARGE', `file exceeds ${cap} bytes: ${rel}`, 413);
      }
      const outAbs = path.join(tmp, ...rel.split('/'));
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      await fs.copyFile(srcAbs, outAbs);
    }
  };

  try {
    await copyTree(srcReal, '');
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }

  const destStat = await fs.lstat(destAbs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  });
  if (destStat !== null) {
    await fs.rename(destAbs, backup);
  }
  try {
    await fs.rename(tmp, destAbs);
  } catch (err) {
    if (destStat !== null) {
      await fs.rename(backup, destAbs).catch(() => undefined);
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  if (destStat !== null) {
    await fs.rm(backup, { recursive: true, force: true });
  }
}
