import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os, { type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewRouter } from '../src/routes/preview.js';
import {
  createShareApiRouter,
  createShareRouter,
  firstNonLoopbackIPv4,
  injectShareBanner,
} from '../src/routes/share.js';
import { writeSiteFile } from '../src/sites.js';

const osMocks = vi.hoisted(() => ({
  networkInterfaces: vi.fn<() => NodeJS.Dict<NetworkInterfaceInfo[]>>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  const patched = { ...original, networkInterfaces: osMocks.networkInterfaces };
  return { ...patched, default: patched };
});

const PREVIEW_CSP = "default-src 'self' 'unsafe-inline'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com";
const SITE_ID = 'share-test-site';
const HTTPS_PORT = 8443;
const SITE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>My Test Site</title>' +
  '<link rel="stylesheet" href="style.css"></head><body><h1>share-ok</h1><script src="app.js"></script></body></html>';

function iface(address: string, family: 'IPv4' | 'IPv6', internal: boolean): NetworkInterfaceInfo {
  const base = { address, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
  return family === 'IPv4' ? { ...base, family: 'IPv4' } : { ...base, family: 'IPv6', scopeid: 0 };
}

const LAN_INTERFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [iface('127.0.0.1', 'IPv4', true)],
  eth0: [iface('192.168.1.50', 'IPv4', false), iface('fe80::1', 'IPv6', false)],
};

let root: string;
let sites: string;

beforeEach(async () => {
  osMocks.networkInterfaces.mockReturnValue(LAN_INTERFACES);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-share-'));
  sites = path.join(root, 'sites');
  await writeSiteFile(sites, SITE_ID, 'index.html', SITE_HTML);
  await writeSiteFile(sites, SITE_ID, 'style.css', 'h1{color:blue}');
  await writeSiteFile(sites, SITE_ID, 'app.js', 'console.log(1)');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeApp(): Express {
  const app = express();
  app.use('/api/builds', createShareApiRouter(sites, { httpsPort: HTTPS_PORT }));
  app.use('/p', createShareRouter(sites));
  app.use('/preview', createPreviewRouter(sites));
  return app;
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = makeApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('share page', () => {
  it('serves index.html with the banner injected and the page intact', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/p/${SITE_ID}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const body = await res.text();
      // Banner present with all four elements.
      expect(body).toContain('id="foundry-share-bar"');
      expect(body).toContain('Open preview');
      expect(body).toContain('Download');
      expect(body).toContain('Built with Foundry');
      expect(body).toContain('>My Test Site<');
      expect(body).toContain(`href="/preview/${SITE_ID}/"`);
      expect(body).toContain(`href="/api/builds/${SITE_ID}/download"`);
      // Page intact: doctype first, original title and content preserved.
      expect(body.startsWith('<!doctype html>')).toBe(true);
      expect(body).toContain('<title>My Test Site</title>');
      expect(body).toContain('<h1>share-ok</h1>');
      // Banner is fixed-position and the page is padded down to clear it.
      expect(body).toContain('position:fixed');
      expect(body).toContain('padding-top:44px');
      // Banner is injected inside the body, after the <body> tag.
      const bodyAt = body.indexOf('<body>');
      expect(bodyAt).toBeGreaterThan(-1);
      expect(body.indexOf('id="foundry-share-bar"')).toBeGreaterThan(bodyAt);
    });
  });

  it('uses the preview CSP, not the app-shell policy', async () => {
    await withServer(async (base) => {
      const shareRes = await fetch(`${base}/p/${SITE_ID}/`);
      expect(shareRes.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
      // Guard against drift from the preview route's policy.
      const previewRes = await fetch(`${base}/preview/${SITE_ID}/`);
      expect(shareRes.headers.get('content-security-policy')).toBe(
        previewRes.headers.get('content-security-policy'),
      );
    });
  });

  it('serves site assets so relative links in the shared page work', async () => {
    await withServer(async (base) => {
      const css = await fetch(`${base}/p/${SITE_ID}/style.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
      expect(await css.text()).toContain('color:blue');
      const js = await fetch(`${base}/p/${SITE_ID}/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      await js.text();
    });
  });

  it('redirects the bare share url to the trailing-slash form', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/p/${SITE_ID}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/p/${SITE_ID}/`);
    });
  });

  it('404s unknown ids, invalid ids and missing files', async () => {
    await withServer(async (base) => {
      const unknown = await fetch(`${base}/p/does-not-exist-1/`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toContain('does-not-exist-1');
      expect((await fetch(`${base}/p/bad..id/`)).status).toBe(404);
      expect((await fetch(`${base}/p/${SITE_ID}/missing.css`)).status).toBe(404);
      const traversal = await fetch(`${base}/p/${SITE_ID}/%2e%2e/secret.txt`);
      expect([403, 404]).toContain(traversal.status);
      await traversal.text();
    });
  });
});

describe('injectShareBanner', () => {
  it('falls back to "Untitled site" when the page has no <title>', () => {
    const out = injectShareBanner('<!doctype html><html><body><p>x</p></body></html>', SITE_ID);
    expect(out).toContain('>Untitled site<');
    expect(out).toContain('<p>x</p>');
  });

  it('injects into html fragments that have no <body> or <head>', () => {
    const out = injectShareBanner('<h1>fragment</h1>', SITE_ID);
    expect(out).toContain('id="foundry-share-bar"');
    expect(out).toContain('<h1>fragment</h1>');
  });

  it('keeps an entity-encoded title intact without double-escaping', () => {
    const out = injectShareBanner('<html><head><title>Fish &amp; Chips</title></head></html>', SITE_ID);
    expect(out).toContain('>Fish &amp; Chips<');
    expect(out).not.toContain('&amp;amp;');
  });
});

describe('share api', () => {
  it('returns shareUrl and a LAN url built from the first non-loopback IPv4', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/builds/${SITE_ID}/share`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { shareUrl: string; lanUrl: string };
      expect(body.shareUrl).toBe(`/p/${SITE_ID}/`);
      expect(body.lanUrl).toBe(`https://192.168.1.50:${HTTPS_PORT}/p/${SITE_ID}/`);
    });
  });

  it('returns an empty lanUrl when the machine has no non-loopback IPv4', async () => {
    osMocks.networkInterfaces.mockReturnValue({
      lo: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
      wlan0: [iface('fe80::2', 'IPv6', false)],
      down0: undefined,
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/builds/${SITE_ID}/share`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { shareUrl: string; lanUrl: string };
      expect(body.shareUrl).toBe(`/p/${SITE_ID}/`);
      expect(body.lanUrl).toBe('');
    });
  });

  it('404s unknown builds', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/builds/does-not-exist-1/share`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain('does-not-exist-1');
      expect((await fetch(`${base}/api/builds/bad..id/share`)).status).toBe(404);
    });
  });
});

describe('firstNonLoopbackIPv4', () => {
  it('picks the first non-internal IPv4 address in interface order', () => {
    expect(firstNonLoopbackIPv4(LAN_INTERFACES)).toBe('192.168.1.50');
  });

  it('skips internal and IPv6 addresses', () => {
    expect(
      firstNonLoopbackIPv4({
        lo: [iface('127.0.0.1', 'IPv4', true)],
        tun0: [iface('fd00::1', 'IPv6', false)],
      }),
    ).toBe('');
  });

  it('returns empty string for empty or undefined interface lists', () => {
    expect(firstNonLoopbackIPv4({})).toBe('');
    expect(firstNonLoopbackIPv4({ eth0: undefined })).toBe('');
  });
});
