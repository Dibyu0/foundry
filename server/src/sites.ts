import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type SiteErrorCode =
  | 'INVALID_ID'
  | 'BAD_PATH'
  | 'PATH_TRAVERSAL'
  | 'NOT_FOUND'
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'SITE_TOO_LARGE';

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

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
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
  const key = normalizeRel(rel);
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

export async function listSiteFiles(sitesRoot: string, id: string): Promise<SiteFileEntry[]> {
  const root = siteDir(sitesRoot, id);
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
