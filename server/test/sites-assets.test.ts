import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_FONT_BYTES,
  MAX_ICO_BYTES,
  MAX_JSON_BYTES,
  MAX_SVG_BYTES,
  copySiteDir,
  listSiteFiles,
  newSiteId,
  readSiteFile,
  writeSiteFile,
} from '../src/sites.js';

let root: string;
let sites: string;
let id: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-assets-'));
  sites = path.join(root, 'sites');
  id = newSiteId();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function expectSiteError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'SiteError', code });
}

async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) out.set(rel, await fs.readFile(abs));
    }
  };
  await walk(dir, '');
  return out;
}

async function expectMissing(target: string): Promise<void> {
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('writeSiteFile asset types', () => {
  it('accepts a well-formed svg, with or without BOM and leading whitespace', async () => {
    await writeSiteFile(sites, id, 'img/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await writeSiteFile(sites, id, 'img/bom.svg', '\uFEFF\n  <?xml version="1.0"?>\n<svg></svg>');
    const body = await readSiteFile(sites, id, 'img/icon.svg');
    expect(body.toString('utf8')).toContain('<svg');
  });

  it('rejects svg content that does not start with "<"', async () => {
    await expectSiteError(writeSiteFile(sites, id, 'a.svg', 'not an svg <svg></svg>'), 'INVALID_CONTENT');
    await expectSiteError(writeSiteFile(sites, id, 'a.svg', ''), 'INVALID_CONTENT');
  });

  it('rejects svg content without an "<svg" tag', async () => {
    await expectSiteError(writeSiteFile(sites, id, 'a.svg', '<html><body>x</body></html>'), 'INVALID_CONTENT');
  });

  it('applies the svg rule case-insensitively by extension', async () => {
    await expectSiteError(writeSiteFile(sites, id, 'ICON.SVG', 'junk'), 'INVALID_CONTENT');
  });

  it('enforces the svg size cap even for content that would sniff clean', async () => {
    const big = `<svg>${'x'.repeat(MAX_SVG_BYTES)}</svg>`;
    await expectSiteError(writeSiteFile(sites, id, 'big.svg', big), 'FILE_TOO_LARGE');
  });

  it('accepts parseable json and rejects unparseable json', async () => {
    await writeSiteFile(sites, id, 'manifest.json', '{"name":"site","icons":[]}');
    await writeSiteFile(sites, id, 'data.json', '[1,2,3]');
    await writeSiteFile(sites, id, 'bom.json', '\uFEFF{"a":1}');
    await expectSiteError(writeSiteFile(sites, id, 'bad.json', '{not json'), 'INVALID_CONTENT');
    await expectSiteError(writeSiteFile(sites, id, 'empty.json', ''), 'INVALID_CONTENT');
  });

  it('enforces the json size cap even for valid json', async () => {
    const big = `{"pad":"${'x'.repeat(MAX_JSON_BYTES)}"}`;
    await expectSiteError(writeSiteFile(sites, id, 'big.json', big), 'FILE_TOO_LARGE');
  });

  it('accepts binary ico/woff/woff2 without content sniffing', async () => {
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0xff, 0xfe]); // any bytes pass: ico is not sniffed
    await writeSiteFile(sites, id, 'favicon.ico', ico);
    expect(await readSiteFile(sites, id, 'favicon.ico')).toEqual(ico);
    await writeSiteFile(sites, id, 'fonts/a.woff', Buffer.from('wOFF fake font bytes'));
    await writeSiteFile(sites, id, 'fonts/a.woff2', Buffer.from('wOF2 fake font bytes'));
  });

  it('enforces the per-type caps for ico and fonts', async () => {
    await expectSiteError(
      writeSiteFile(sites, id, 'favicon.ico', Buffer.alloc(MAX_ICO_BYTES + 1, 1)),
      'FILE_TOO_LARGE',
    );
    await writeSiteFile(sites, id, 'favicon.ico', Buffer.alloc(MAX_ICO_BYTES, 1));
    await expectSiteError(
      writeSiteFile(sites, id, 'a.woff', Buffer.alloc(MAX_FONT_BYTES + 1, 1)),
      'FILE_TOO_LARGE',
    );
    await expectSiteError(
      writeSiteFile(sites, id, 'a.woff2', Buffer.alloc(MAX_FONT_BYTES + 1, 1)),
      'FILE_TOO_LARGE',
    );
  });

  it('keeps the generic cap for types without an asset rule', async () => {
    // 128KB exceeds every per-type cap but html has no asset rule.
    await writeSiteFile(sites, id, 'index.html', 'x'.repeat(128 * 1024));
    await expectSiteError(
      writeSiteFile(sites, id, 'big.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 1)),
      'FILE_TOO_LARGE',
    );
  });
});

describe('listSiteFiles withBytes mode', () => {
  it('returns sorted {path, bytes} entries when withBytes is true', async () => {
    await writeSiteFile(sites, id, 'b.txt', 'bbb');
    await writeSiteFile(sites, id, 'sub/a.svg', '<svg></svg>');
    const entries = await listSiteFiles(sites, id, { withBytes: true });
    expect(entries).toEqual([
      { path: 'b.txt', bytes: 3 },
      { path: 'sub/a.svg', bytes: 11 },
    ]);
  });

  it('keeps the default {path, size} shape for existing callers', async () => {
    await writeSiteFile(sites, id, 'a.txt', 'ab');
    expect(await listSiteFiles(sites, id)).toEqual([{ path: 'a.txt', size: 2 }]);
    expect(await listSiteFiles(sites, newSiteId())).toEqual([]);
  });
});

describe('copySiteDir', () => {
  it('round-trips a tree byte-for-byte and leaves the source untouched', async () => {
    await writeSiteFile(sites, id, 'index.html', '<h1>checkpoint me</h1>');
    await writeSiteFile(sites, id, 'assets/app.js', 'console.log(1)');
    await writeSiteFile(sites, id, 'favicon.ico', Buffer.from([0, 1, 2, 3, 255]));
    const before = await readTree(path.join(sites, id));
    const dest = path.join(root, 'checkpoints', 'v1');
    await copySiteDir(sites, id, dest);
    expect(await readTree(dest)).toEqual(before);
    expect(await readTree(path.join(sites, id))).toEqual(before);
  });

  it('replaces an existing destination, dropping stale files and leaving no litter', async () => {
    await writeSiteFile(sites, id, 'index.html', 'new');
    const dest = path.join(root, 'ckpt');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'stale.txt'), 'old');
    await copySiteDir(sites, id, dest);
    expect(await readTree(dest)).toEqual(await readTree(path.join(sites, id)));
    await expectMissing(path.join(dest, 'stale.txt'));
    const siblings = await fs.readdir(path.dirname(dest));
    expect(siblings.filter((n) => n.includes('.copy-') || n.includes('.old-'))).toEqual([]);
  });

  it('rejects a missing source site and invalid ids', async () => {
    await expectSiteError(copySiteDir(sites, newSiteId(), path.join(root, 'x')), 'NOT_FOUND');
    await expectSiteError(copySiteDir(sites, '..', path.join(root, 'x')), 'INVALID_ID');
  });

  it('refuses destinations inside the source or containing it', async () => {
    await writeSiteFile(sites, id, 'index.html', 'x');
    await expectSiteError(copySiteDir(sites, id, path.join(sites, id, 'nested')), 'BAD_PATH');
    await expectSiteError(copySiteDir(sites, id, sites), 'BAD_PATH');
  });

  it('refuses symlinks in the source tree and cleans up the tmp dir', async (ctx) => {
    await writeSiteFile(sites, id, 'index.html', 'ok');
    try {
      await fs.symlink(path.join(root, 'outside-target'), path.join(sites, id, 'link'));
    } catch {
      ctx.skip();
      return;
    }
    const dest = path.join(root, 'ckpt');
    await expectSiteError(copySiteDir(sites, id, dest), 'SYMLINK');
    await expectMissing(dest);
    const siblings = await fs.readdir(root);
    expect(siblings.filter((n) => n.includes('.copy-'))).toEqual([]);
  });

  it('enforces per-file caps on copy even for files planted out of band', async () => {
    await writeSiteFile(sites, id, 'index.html', 'ok');
    // Planted directly on disk, bypassing writeSiteFile's validation.
    await fs.writeFile(path.join(sites, id, 'huge.bin'), Buffer.alloc(MAX_FILE_BYTES + 1, 7));
    const dest = path.join(root, 'ckpt');
    await expectSiteError(copySiteDir(sites, id, dest), 'FILE_TOO_LARGE');
    await expectMissing(dest);
  });
});
