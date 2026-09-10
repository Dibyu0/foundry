import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleSite, BundleError } from '../src/agent/bundle.js';
import { createServer } from '../src/index.js';
import { writeSiteFile } from '../src/sites.js';

const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Test site</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="animations.css">
  <script src="app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <main id="main">
    <img src="assets/hero.png" alt="hero">
    <a href="https://example.com/docs">Docs</a>
  </main>
</body>
</html>
`;

const STYLES = `:root { --ink: #111; }
.logo { background: url(assets/logo.svg) no-repeat; }
.hero { background-image: url("assets/hero.png"); }
`;

const ANIMATIONS = `@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
`;

const APP = `(() => { 'use strict';
  document.querySelector('#main').classList.add('ready');
})();
`;

function siteFiles(): Map<string, string> {
  return new Map<string, string>([
    ['index.html', INDEX],
    ['styles.css', STYLES],
    ['animations.css', ANIMATIONS],
    ['app.js', APP],
    ['assets/hero.png', 'fake-png-bytes'],
    ['assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['README.md', '# test site\n'],
  ]);
}

describe('bundleSite', () => {
  it('inlines local stylesheets and scripts into a copy of index.html', () => {
    const { html, inlined } = bundleSite(siteFiles());

    expect(inlined).toEqual(['styles.css', 'animations.css', 'app.js']);

    // Local stylesheet links are replaced by style blocks.
    expect(html).not.toContain('href="styles.css"');
    expect(html).not.toContain('href="animations.css"');
    expect(html).toContain('<style data-inlined-from="styles.css">');
    expect(html).toContain(STYLES);
    expect(html).toContain(ANIMATIONS);

    // The local script tag is replaced by an inline script.
    expect(html).not.toContain('src="app.js"');
    expect(html).toContain('<script data-inlined-from="app.js">');
    expect(html).toContain(APP);
  });

  it('keeps external stylesheets linked and reports them as skipped', () => {
    const { html, skipped } = bundleSite(siteFiles());

    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"');
    const fonts = skipped.find((s) => s.path.startsWith('https://fonts.googleapis.com/css2'));
    expect(fonts).toBeDefined();
    expect(fonts?.reason).toContain('external stylesheet');
    // preconnect hints are plumbing, not content: left alone, not reported.
    expect(html).toContain('rel="preconnect"');
    expect(skipped.some((s) => s.path === 'https://fonts.googleapis.com')).toBe(false);
  });

  it('leaves CSS url() references intact and reports them honestly', () => {
    const { html, skipped } = bundleSite(siteFiles());

    // url() targets are not rewritten or embedded.
    expect(html).toContain('url(assets/logo.svg)');
    expect(html).toContain('url("assets/hero.png")');

    const logo = skipped.find((s) => s.path === 'assets/logo.svg');
    expect(logo?.reason).toContain('inlined CSS');
  });

  it('reports images and unreferenced files without dropping them silently', () => {
    const { skipped } = bundleSite(siteFiles());

    const hero = skipped.find((s) => s.path === 'assets/hero.png');
    expect(hero).toBeDefined();

    const readme = skipped.find((s) => s.path === 'README.md');
    expect(readme?.reason).toContain('not referenced');
  });

  it('moves deferred scripts to just before </body> to preserve timing', () => {
    const { html } = bundleSite(siteFiles());
    const scriptAt = html.indexOf('<script data-inlined-from="app.js">');
    const bodyCloseAt = html.indexOf('</body>');
    const mainAt = html.indexOf('<main');
    expect(scriptAt).toBeGreaterThan(mainAt);
    expect(scriptAt).toBeLessThan(bodyCloseAt);
  });

  it('inserts deferred scripts before the real </body>, not a literal inside inlined script content', () => {
    const files = new Map<string, string>([
      [
        'index.html',
        '<!doctype html><head><script src="early.js"></script><script src="late.js" defer></script></head><body><p>x</p></body>',
      ],
      ['early.js', 'const tag = "</body>";'],
      ['late.js', 'console.log("late");'],
    ]);
    const { html, inlined } = bundleSite(files);
    expect(inlined).toEqual(['early.js', 'late.js']);
    const fakeAt = html.indexOf('"</body>"');
    const realBodyAt = html.lastIndexOf('</body>');
    const lateAt = html.indexOf('data-inlined-from="late.js"');
    expect(fakeAt).toBeGreaterThan(-1);
    expect(realBodyAt).toBeGreaterThan(fakeAt);
    // The deferred block must land after the fake literal and just before
    // the document's own body close; inserting at the fake one would put
    // script markup inside a JS string and break the export.
    expect(lateAt).toBeGreaterThan(fakeAt);
    expect(lateAt).toBeLessThan(realBodyAt);
  });

  it('rewrites url()s in subdirectory stylesheets to stay root-relative once inlined', () => {
    const files = new Map<string, string>([
      ['index.html', '<!doctype html><head><link rel="stylesheet" href="css/main.css"></head><body></body>'],
      [
        'css/main.css',
        [
          '.a { background: url(bg.png); }',
          '.b { background: url("../img/hero.png?v=2"); }',
          ".c { background: url('fonts/a.woff2'); }",
          '.d { background: url(#gradient); }',
          '.e { background: url(data:image/png;base64,AA); }',
          '.f { background: url(https://cdn.example.com/x.png); }',
          '.g { background: url(/already-root.png); }',
        ].join('\n'),
      ],
      ['css/bg.png', 'png'],
      ['img/hero.png', 'png'],
      ['css/fonts/a.woff2', 'font'],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    expect(inlined).toEqual(['css/main.css']);
    // Relative urls are rewritten against the stylesheet's directory.
    expect(html).toContain('url(css/bg.png)');
    expect(html).toContain('url("img/hero.png?v=2")');
    expect(html).toContain("url('css/fonts/a.woff2')");
    // Fragments, data:, external, and root-absolute urls stay verbatim.
    expect(html).toContain('url(#gradient)');
    expect(html).toContain('url(data:image/png;base64,AA)');
    expect(html).toContain('url(https://cdn.example.com/x.png)');
    expect(html).toContain('url(/already-root.png)');
    // The report names the resolved paths, matching what the html now says.
    expect(skipped.find((s) => s.path === 'css/bg.png')?.reason).toContain('inlined CSS');
    expect(skipped.find((s) => s.path === 'img/hero.png')?.reason).toContain('inlined CSS');
    expect(skipped.find((s) => s.path === 'bg.png')).toBeUndefined();
    const external = skipped.find((s) => s.path === 'https://cdn.example.com/x.png');
    expect(external?.reason).toContain('external asset');
  });

  it('does not inline module or other non-classic scripts, and says so honestly', () => {
    const files = new Map<string, string>([
      [
        'index.html',
        [
          '<!doctype html><head>',
          '<script type="module" src="app.mjs"></script>',
          '<script type="importmap" src="map.json"></script>',
          '<script type="text/javascript" src="classic.js"></script>',
          '</head><body></body>',
        ].join(''),
      ],
      ['app.mjs', 'import { x } from "./dep.js"; export const y = x;'],
      ['map.json', '{"imports":{}}'],
      ['classic.js', 'var ok = 1;'],
      ['dep.js', 'export const x = 1;'],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    // The classic script still inlines; the module and importmap keep their
    // tags untouched (inlining them as classic scripts would be a
    // SyntaxError or would run content the page never executes).
    expect(inlined).toEqual(['classic.js']);
    expect(html).toContain('<script type="module" src="app.mjs"></script>');
    expect(html).toContain('<script type="importmap" src="map.json"></script>');
    expect(html).not.toContain('data-inlined-from="app.mjs"');
    const mod = skipped.find((s) => s.path === 'app.mjs');
    expect(mod?.reason).toContain('"module"');
    expect(mod?.reason).toContain('not a classic script');
    expect(skipped.find((s) => s.path === 'map.json')?.reason).toContain('not a classic script');
  });

  it('leaves alternate stylesheets linked instead of forcing them on', () => {
    const files = new Map<string, string>([
      [
        'index.html',
        '<!doctype html><head><link rel="stylesheet" href="main.css"><link rel="alternate stylesheet" href="alt.css"></head><body></body>',
      ],
      ['main.css', 'body { color: #111; }'],
      ['alt.css', 'body { display: none; }'],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    expect(inlined).toEqual(['main.css']);
    expect(html).toContain('<link rel="alternate stylesheet" href="alt.css">');
    expect(html).not.toContain('display: none');
    const alt = skipped.find((s) => s.path === 'alt.css');
    expect(alt?.reason).toContain('alternate stylesheet');
    expect(alt?.reason).toContain('left linked');
  });

  it('leaves titled and disabled stylesheets linked instead of forcing them on', () => {
    const files = new Map<string, string>([
      [
        'index.html',
        '<!doctype html><head><link rel="stylesheet" href="theme.css" title="Dark"><link rel="stylesheet" href="off.css" disabled></head><body></body>',
      ],
      ['theme.css', 'body { background: #000; }'],
      ['off.css', 'body { background: #fff; }'],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    expect(inlined).toEqual([]);
    expect(html).toContain('href="theme.css"');
    expect(html).toContain('href="off.css"');
    expect(skipped.find((s) => s.path === 'theme.css')?.reason).toContain('titled stylesheet');
    expect(skipped.find((s) => s.path === 'off.css')?.reason).toContain('disabled stylesheet');
  });

  it('carries media onto the style tag so a print sheet stays print-only', () => {
    const files = new Map<string, string>([
      [
        'index.html',
        '<!doctype html><head><link rel="stylesheet" href="screen.css"><link rel="stylesheet" href="print.css" media="print"></head><body></body>',
      ],
      ['screen.css', 'body { color: #111; }'],
      ['print.css', 'body { display: none; }'],
    ]);
    const { html, inlined } = bundleSite(files);
    expect(inlined).toEqual(['screen.css', 'print.css']);
    expect(html).toContain('<style data-inlined-from="screen.css">');
    expect(html).toContain('<style data-inlined-from="print.css" media="print">');
    expect(html).toContain('display: none');
  });

  it('escapes closing script/style tags inside inlined content', () => {
    const files = new Map<string, string>([
      ['index.html', '<!doctype html><head><link rel="stylesheet" href="s.css"><script src="a.js"></script></head><body></body>'],
      ['s.css', '.x::after { content: "</style>"; }'],
      ['a.js', 'const tag = "</script>";'],
    ]);
    const { html, inlined } = bundleSite(files);
    expect(inlined).toEqual(['s.css', 'a.js']);
    expect(html).toContain('<\\/style>');
    expect(html).toContain('<\\/script>');
    // The raw closing sequences inside content must be gone (host tags remain).
    expect(html.indexOf('</style>')).toBeGreaterThan(html.indexOf('data-inlined-from="s.css"'));
  });

  it('is deterministic and idempotent over its own output', () => {
    const first = bundleSite(siteFiles());
    const second = bundleSite(siteFiles());
    expect(second).toEqual(first);

    // Re-bundling the single-file output is a no-op.
    const rebundled = bundleSite(new Map([['index.html', first.html]]));
    expect(rebundled.html).toBe(first.html);
    expect(rebundled.inlined).toEqual([]);
  });

  it('honestly reports references to missing files instead of inventing content', () => {
    const files = new Map<string, string>([
      ['index.html', '<!doctype html><head><link rel="stylesheet" href="missing.css"><script src="gone.js"></script></head><body></body>'],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    expect(inlined).toEqual([]);
    expect(html).toContain('href="missing.css"');
    expect(html).toContain('src="gone.js"');
    expect(skipped.find((s) => s.path === 'missing.css')?.reason).toContain('not found');
    expect(skipped.find((s) => s.path === 'gone.js')?.reason).toContain('not found');
  });

  it('refuses to inline non-UTF-8 content', () => {
    const files = new Map<string, string>([
      ['index.html', '<!doctype html><head><link rel="stylesheet" href="styles.css"></head><body></body>'],
      ['styles.css', Buffer.from([0xff, 0xfe, 0x00]).toString('utf8')],
    ]);
    const { html, inlined, skipped } = bundleSite(files);
    expect(inlined).toEqual([]);
    expect(html).toContain('href="styles.css"');
    expect(skipped.find((s) => s.path === 'styles.css')?.reason).toContain('UTF-8');
  });

  it('throws an honest error when the site has no index.html', () => {
    expect(() => bundleSite(new Map([['styles.css', STYLES]]))).toThrow(BundleError);
    expect(() => bundleSite(new Map())).toThrow(/no index\.html/);
  });
});

const SITE_ID = '01234567-89ab-cdef-0123-456789abcdef';

let root: string;
let sites: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-single-'));
  sites = path.join(root, 'sites');
  for (const [rel, content] of siteFiles()) {
    await writeSiteFile(sites, SITE_ID, rel, content);
  }
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

describe('GET /api/builds/:id/download?format=single', () => {
  it('serves one self-contained html file with an attachment filename', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/builds/${SITE_ID}/download?format=single`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(res.headers.get('content-disposition')).toBe(
          `attachment; filename="foundry-site-${SITE_ID.slice(0, 8)}.html"`,
        );
        const body = await res.text();
        expect(body).toContain('<style data-inlined-from="styles.css">');
        expect(body).toContain('<script data-inlined-from="app.js">');
        expect(body).not.toContain('href="styles.css"');
        expect(body).not.toContain('src="app.js"');
        // External font stylesheet stays linked.
        expect(body).toContain('fonts.googleapis.com/css2');
      });
    } finally {
      await foundry.close();
    }
  });

  it('keeps the zip download as the default and rejects unknown formats', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const zip = await fetch(`${base}/api/builds/${SITE_ID}/download`);
        expect(zip.status).toBe(200);
        expect(zip.headers.get('content-type')).toBe('application/zip');
        expect(zip.headers.get('content-disposition')).toBe(
          `attachment; filename="foundry-site-${SITE_ID.slice(0, 8)}.zip"`,
        );
        const zipBody = Buffer.from(await zip.arrayBuffer());
        expect(zipBody[0]).toBe(0x50);

        const explicit = await fetch(`${base}/api/builds/${SITE_ID}/download?format=zip`);
        expect(explicit.status).toBe(200);
        expect(explicit.headers.get('content-type')).toBe('application/zip');
        await explicit.arrayBuffer();

        const bad = await fetch(`${base}/api/builds/${SITE_ID}/download?format=tar`);
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toContain('unknown download format');
      });
    } finally {
      await foundry.close();
    }
  });

  it('404s for unknown builds and 422s when there is no index.html', async () => {
    const noIndexId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await writeSiteFile(sites, noIndexId, 'styles.css', STYLES);
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const missing = await fetch(`${base}/api/builds/ffffffff-1111-4111-8111-111111111111/download?format=single`);
        expect(missing.status).toBe(404);

        const noIndex = await fetch(`${base}/api/builds/${noIndexId}/download?format=single`);
        expect(noIndex.status).toBe(422);
        expect(((await noIndex.json()) as { error: string }).error).toContain('no index.html');
      });
    } finally {
      await foundry.close();
    }
  });
});
