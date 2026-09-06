import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  SiteError,
  listSiteFiles,
  newSiteId,
  readSiteFile,
  resolveSitePath,
  siteExists,
  writeSiteFile,
} from '../src/sites.js';

let root: string;
let sites: string;
let id: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-confine-'));
  sites = path.join(root, 'sites');
  id = newSiteId();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function expectSiteError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'SiteError', code });
}

describe('site store confinement', () => {
  it('writes and reads a file inside the site dir', async () => {
    await writeSiteFile(sites, id, 'index.html', '<h1>hello</h1>');
    const body = await readSiteFile(sites, id, 'index.html');
    expect(body.toString('utf8')).toBe('<h1>hello</h1>');
    expect(await siteExists(sites, id)).toBe(true);
  });

  it('rejects dot-dot traversal', async () => {
    await expectSiteError(writeSiteFile(sites, id, '../evil.txt', 'x'), 'PATH_TRAVERSAL');
    await expectSiteError(writeSiteFile(sites, id, 'sub/../../evil.txt', 'x'), 'PATH_TRAVERSAL');
    await expectSiteError(readSiteFile(sites, id, '..\\..\\evil.txt'), 'PATH_TRAVERSAL');
  });

  it('rejects absolute paths', async () => {
    await expectSiteError(writeSiteFile(sites, id, '/etc/passwd', 'x'), 'BAD_PATH');
    await expectSiteError(writeSiteFile(sites, id, 'C:\\Windows\\win.ini', 'x'), 'BAD_PATH');
    await expectSiteError(writeSiteFile(sites, id, 'C:/Windows/win.ini', 'x'), 'BAD_PATH');
    await expectSiteError(writeSiteFile(sites, id, 'C:evil.txt', 'x'), 'BAD_PATH');
  });

  it('rejects UNC paths', async () => {
    await expectSiteError(writeSiteFile(sites, id, '\\\\server\\share\\f.txt', 'x'), 'BAD_PATH');
    await expectSiteError(writeSiteFile(sites, id, '//server/share/f.txt', 'x'), 'BAD_PATH');
  });

  it('rejects NUL bytes and empty paths', async () => {
    await expectSiteError(writeSiteFile(sites, id, 'a\0b.txt', 'x'), 'BAD_PATH');
    await expectSiteError(writeSiteFile(sites, id, '', 'x'), 'BAD_PATH');
  });

  it('rejects traversal through the site id itself', async () => {
    await expectSiteError(writeSiteFile(sites, '../..', 'evil.txt', 'x'), 'INVALID_ID');
    await expectSiteError(readSiteFile(sites, 'a/b', 'evil.txt'), 'INVALID_ID');
    await expectSiteError(writeSiteFile(sites, '..', 'evil.txt', 'x'), 'INVALID_ID');
  });

  it('rejects symlink escapes', async (ctx) => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await writeSiteFile(sites, id, 'index.html', 'ok');
    const linkPath = path.join(sites, id, 'linked');
    try {
      await fs.symlink(outside, linkPath, 'junction');
    } catch {
      ctx.skip();
      return;
    }
    await expectSiteError(writeSiteFile(sites, id, 'linked/pwned.txt', 'x'), 'PATH_TRAVERSAL');
    await expectSiteError(readSiteFile(sites, id, 'linked/secret.txt'), 'PATH_TRAVERSAL');
    expect((await fs.readdir(outside)).sort()).toEqual(['secret.txt']);
  });

  it('confines writes into legitimate subdirectories', async () => {
    await writeSiteFile(sites, id, 'assets/css/site.css', 'body{}');
    const body = await readSiteFile(sites, id, 'assets/css/site.css');
    expect(body.toString()).toBe('body{}');
  });

  it('lists files with forward-slash relative paths, sorted', async () => {
    await writeSiteFile(sites, id, 'b.txt', 'b');
    await writeSiteFile(sites, id, 'sub/a.txt', 'a');
    await writeSiteFile(sites, id, 'index.html', 'i');
    const entries = await listSiteFiles(sites, id);
    expect(entries.map((e) => e.path)).toEqual(['b.txt', 'index.html', 'sub/a.txt']);
    expect(entries.every((e) => e.size === 1)).toBe(true);
  });

  it('returns an empty listing for an unknown site', async () => {
    expect(await listSiteFiles(sites, newSiteId())).toEqual([]);
  });

  it('caps the file count', async () => {
    for (let i = 0; i < MAX_FILES; i += 1) {
      await writeSiteFile(sites, id, `f${String(i).padStart(2, '0')}.txt`, 'x');
    }
    await expectSiteError(writeSiteFile(sites, id, 'one-more.txt', 'x'), 'TOO_MANY_FILES');
    // Overwriting an existing file is still allowed at the cap.
    await writeSiteFile(sites, id, 'f00.txt', 'updated');
  });

  it('caps the per-file size', async () => {
    await expectSiteError(
      writeSiteFile(sites, id, 'big.bin', Buffer.alloc(MAX_FILE_BYTES + 1, 1)),
      'FILE_TOO_LARGE',
    );
    await writeSiteFile(sites, id, 'ok.bin', Buffer.alloc(MAX_FILE_BYTES, 1));
  });

  it('caps the total site size', async () => {
    const chunk = Buffer.alloc(MAX_FILE_BYTES, 2);
    for (let i = 0; i < 8; i += 1) {
      await writeSiteFile(sites, id, `c${i}.bin`, chunk); // 8 x 256KB = 2MB exactly
    }
    await expectSiteError(writeSiteFile(sites, id, 'extra.txt', 'x'), 'SITE_TOO_LARGE');
    // Shrinking an existing file frees budget.
    await writeSiteFile(sites, id, 'c0.bin', 'small');
    await writeSiteFile(sites, id, 'extra.txt', 'x');
  });

  it('maps reads of missing files and sites to NOT_FOUND', async () => {
    await expectSiteError(readSiteFile(sites, id, 'nope.txt'), 'NOT_FOUND');
    await expectSiteError(resolveSitePath(sites, newSiteId(), 'nope.txt'), 'NOT_FOUND');
  });

  it('throws SiteError instances with an http-ish status', async () => {
    const err = await writeSiteFile(sites, id, '../x', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).status).toBe(403);
  });
});
