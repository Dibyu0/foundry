import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { INJECT_SCRIPT, injectBridge } from '../src/previewInject.js';
import { writeSiteFile } from '../src/sites.js';
import {
  isBufferMessage,
  isConsoleEntry,
  isErrorEntry,
  isInspectHoverMessage,
  isInspectSelectMessage,
  isInspectStateMessage,
  isNetworkEntry,
  isPreviewEntry,
  isPreviewMessage,
  isReadyMessage,
  isStyleAppliedMessage,
} from '../../web/src/previewBridge.ts';

const SITE_ID = 'bridge-test-site';
const INDEX_HTML = '<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n<h1>bridge-ok</h1>\n</body>\n</html>\n';

let root: string;
let sites: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-bridge-'));
  sites = path.join(root, 'sites');
  await writeSiteFile(sites, SITE_ID, 'index.html', INDEX_HTML);
  await writeSiteFile(sites, SITE_ID, 'style.css', 'h1{color:red}');
  await writeSiteFile(sites, SITE_ID, 'sub/index.html', '<p>nested</p>');
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

async function withFoundry(fn: (base: string) => Promise<void>): Promise<void> {
  const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
  try {
    await withServer(foundry.app, fn);
  } finally {
    await foundry.close();
  }
}

function markerCount(html: string): number {
  return html.split('foundry-preview-bridge').length - 1;
}

describe('injectBridge', () => {
  it('inserts the bridge script immediately before </body>', () => {
    const out = injectBridge(INDEX_HTML);
    const marker = out.indexOf('foundry-preview-bridge');
    const bodyClose = out.search(/<\/body\s*>/i);
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(bodyClose);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<h1>bridge-ok</h1>');
  });

  it('matches the body close tag case-insensitively', () => {
    const out = injectBridge('<html><BODY>hi</BODY></html>');
    expect(markerCount(out)).toBe(1);
    expect(out.indexOf('foundry-preview-bridge')).toBeLessThan(out.indexOf('</BODY>'));
  });

  it('appends the script when the document has no </body>', () => {
    const out = injectBridge('<h1>fragment</h1>');
    expect(markerCount(out)).toBe(1);
    expect(out.startsWith('<h1>fragment</h1>')).toBe(true);
  });

  it('is idempotent', () => {
    const once = injectBridge(INDEX_HTML);
    const twice = injectBridge(once);
    expect(twice).toBe(once);
    expect(markerCount(twice)).toBe(1);
  });

  it('passes non-HTML content types through unchanged', () => {
    for (const type of ['text/css', 'text/javascript', 'image/png', 'application/json']) {
      expect(injectBridge(INDEX_HTML, { contentType: type })).toBe(INDEX_HTML);
    }
  });

  it('accepts xhtml as HTML', () => {
    expect(markerCount(injectBridge(INDEX_HTML, { contentType: 'application/xhtml+xml' }))).toBe(1);
  });
});

describe('INJECT_SCRIPT hygiene', () => {
  it('is a single script tag with no stray </script> in the JS body', () => {
    expect(INJECT_SCRIPT.startsWith('<script id="foundry-preview-bridge"')).toBe(true);
    expect(INJECT_SCRIPT.endsWith('</script>')).toBe(true);
    expect(INJECT_SCRIPT.split('</script').length - 1).toBe(1);
  });

  it('is ASCII-only', () => {
    for (let i = 0; i < INJECT_SCRIPT.length; i++) {
      expect(INJECT_SCRIPT.charCodeAt(i)).toBeLessThanOrEqual(127);
    }
  });

  it('contains no template-literal hazard sequences', () => {
    const js = extractJs();
    expect(js).not.toContain('${');
    expect(js).not.toContain('`');
  });

  it('parses as a valid script (node --check)', async () => {
    const file = path.join(root, 'bridge-check.js');
    await fs.writeFile(file, extractJs());
    // Throws with the syntax error on stderr when the script is invalid.
    execFileSync(process.execPath, ['--check', file]);
  });
});

function extractJs(): string {
  const open = INJECT_SCRIPT.indexOf('>');
  const close = INJECT_SCRIPT.lastIndexOf('</script>');
  return INJECT_SCRIPT.slice(open + 1, close);
}

describe('preview route injection', () => {
  it('injects the bridge into served HTML, once, with a correct Content-Length', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(markerCount(body)).toBe(1);
      expect(body).toContain('bridge-ok');
      expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body, 'utf8'));
    });
  });

  it('is idempotent across repeated requests', async () => {
    await withFoundry(async (base) => {
      const first = await (await fetch(`${base}/preview/${SITE_ID}/`)).text();
      const second = await (await fetch(`${base}/preview/${SITE_ID}/`)).text();
      expect(second).toBe(first);
      expect(markerCount(second)).toBe(1);
    });
  });

  it('injects nested index.html documents too', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}/sub/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(markerCount(body)).toBe(1);
      expect(body).toContain('nested');
    });
  });

  it('leaves non-HTML responses byte-identical', async () => {
    await withFoundry(async (base) => {
      const res = await fetch(`${base}/preview/${SITE_ID}/style.css`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('h1{color:red}');
      expect(body).not.toContain('foundry-preview-bridge');
    });
  });

  it('never modifies files on disk, so downloads stay clean', async () => {
    await withFoundry(async (base) => {
      const before = await fs.readFile(path.join(sites, SITE_ID, 'index.html'), 'utf8');
      expect(before).toBe(INDEX_HTML);
      const res = await fetch(`${base}/preview/${SITE_ID}/`);
      expect(res.status).toBe(200);
      expect(markerCount(await res.text())).toBe(1);
      const after = await fs.readFile(path.join(sites, SITE_ID, 'index.html'), 'utf8');
      expect(after).toBe(INDEX_HTML);
    });
  });
});

describe('injected script behavior (fake DOM harness)', () => {
  interface Harness {
    posted: unknown[];
    windowListeners: Map<string, Array<(...args: unknown[]) => void>>;
    documentListeners: Map<string, Array<(...args: unknown[]) => void>>;
    consoleCalls: unknown[][];
    /** The fake console after the bridge wrapped it — what page code calls. */
    con: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    win: Record<string, unknown>;
    h1: Record<string, unknown>;
    sendCommand: (command: unknown) => void;
  }

  function makeHarness(): Harness {
    const posted: unknown[] = [];
    const consoleCalls: unknown[][] = [];
    const windowListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const documentListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const listen =
      (map: Map<string, Array<(...args: unknown[]) => void>>) =>
      (type: string, fn: (...args: unknown[]) => void): void => {
        const list = map.get(type) ?? [];
        list.push(fn);
        map.set(type, list);
      };
    const unlisten =
      (map: Map<string, Array<(...args: unknown[]) => void>>) =>
      (type: string, fn: (...args: unknown[]) => void): void => {
        map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
      };

    const styleStore: Record<string, string> = {};
    const h1: Record<string, unknown> = {
      nodeType: 1,
      tagName: 'H1',
      id: '',
      className: 'title',
      textContent: 'Hello world',
      parentElement: null,
      previousElementSibling: null,
      style: {
        setProperty: (k: string, v: string) => {
          styleStore[k] = v;
        },
        getPropertyValue: (k: string) => styleStore[k] ?? '',
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 }),
    };

    const doc: Record<string, unknown> = {
      addEventListener: listen(documentListeners),
      removeEventListener: unlisten(documentListeners),
      createElement: () => ({ setAttribute: () => undefined, style: {}, parentNode: null }),
      body: {
        appendChild(node: { parentNode: unknown }) {
          node.parentNode = doc.body;
        },
      },
      documentElement: { nodeType: 1, tagName: 'HTML', id: '', parentElement: null },
      querySelector: (sel: string) => (sel === 'h1' ? h1 : null),
    };

    const win: Record<string, unknown> = {
      addEventListener: listen(windowListeners),
      removeEventListener: unlisten(windowListeners),
      location: { href: 'https://localhost/preview/x/' },
      CSS: { escape: (s: string) => s },
      getComputedStyle: () => ({
        color: 'rgb(1, 2, 3)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        fontFamily: 'Inter',
        fontSize: '32px',
        fontWeight: '700',
        lineHeight: '40px',
        margin: '0px',
        padding: '8px',
        borderRadius: '4px',
      }),
      fetch: (url: string) =>
        url === '/fail'
          ? Promise.reject(new Error('connection down'))
          : Promise.resolve({ ok: false, status: 404 }),
    };
    win.parent = { postMessage: (message: unknown) => posted.push(message) };

    const con = {
      log: (...args: unknown[]) => consoleCalls.push(args),
      warn: (...args: unknown[]) => consoleCalls.push(args),
      error: (...args: unknown[]) => consoleCalls.push(args),
    };

    const runner = new Function('window', 'document', 'console', extractJs()) as (
      w: unknown,
      d: unknown,
      c: unknown,
    ) => void;
    runner(win, doc, con);

    const sendCommand = (command: unknown): void => {
      for (const fn of windowListeners.get('message') ?? []) fn({ data: command });
    };
    return { posted, windowListeners, documentListeners, consoleCalls, con, win, h1, sendCommand };
  }

  function lastOfKind(posted: unknown[], kind: string): unknown {
    const hits = posted.filter(
      (m) => typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === kind,
    );
    return hits[hits.length - 1];
  }

  it('posts a valid ready message on install', () => {
    const h = makeHarness();
    const ready = lastOfKind(h.posted, 'ready');
    expect(isReadyMessage(ready)).toBe(true);
    expect((ready as { href: string }).href).toContain('/preview/x/');
  });

  it('wraps console methods, posts valid entries and preserves passthrough', () => {
    const h = makeHarness();
    h.con.log('hello', { a: 1 }, undefined);
    h.con.warn('careful');
    h.con.error(new Error('bad'));
    expect(h.consoleCalls.length).toBe(3);
    expect(h.consoleCalls[0]).toEqual(['hello', { a: 1 }, undefined]);

    const log = lastOfKind(h.posted.filter((m) => (m as { level?: string }).level === 'log'), 'console') as { text: string };
    expect(isConsoleEntry(log)).toBe(true);
    expect(log.text).toBe('hello {"a":1} undefined');

    const warn = h.posted.find((m) => (m as { level?: string }).level === 'warn');
    expect(isConsoleEntry(warn)).toBe(true);

    const err = h.posted.find((m) => (m as { level?: string }).level === 'error') as { text: string };
    expect(isConsoleEntry(err)).toBe(true);
    expect(err.text).toContain('Error: bad');
  });

  it('reports window errors and unhandled rejections as valid error entries', () => {
    const h = makeHarness();
    const errorListeners = h.windowListeners.get('error') ?? [];
    expect(errorListeners.length).toBe(1);
    errorListeners[0]?.({
      target: h.win,
      message: 'boom',
      filename: 'app.js',
      lineno: 3,
      colno: 9,
      error: { stack: 'Error: boom\n at x' },
    });
    const err = lastOfKind(h.posted, 'error') as { message: string; file: string; line: number };
    expect(isErrorEntry(err)).toBe(true);
    expect(err.message).toBe('boom');
    expect(err.file).toBe('app.js');
    expect(err.line).toBe(3);

    const rejectionListeners = h.windowListeners.get('unhandledrejection') ?? [];
    rejectionListeners[0]?.({ reason: new Error('nope') });
    const rej = lastOfKind(h.posted, 'error') as { message: string };
    expect(isErrorEntry(rej)).toBe(true);
    expect(rej.message).toContain('unhandled rejection');
    expect(rej.message).toContain('nope');
  });

  it('reports resource load failures as failed network entries', () => {
    const h = makeHarness();
    h.windowListeners.get('error')?.[0]?.({ target: { src: 'https://x/a.png' } });
    const net = lastOfKind(h.posted, 'network') as { url: string; ok: boolean; via: string };
    expect(isNetworkEntry(net)).toBe(true);
    expect(net.url).toBe('https://x/a.png');
    expect(net.ok).toBe(false);
    expect(net.via).toBe('resource');
  });

  it('reports failed fetch responses and rejections as network entries', async () => {
    const h = makeHarness();
    const fetchFn = h.win.fetch as (url: string) => Promise<unknown>;
    await fetchFn('/api/data');
    let net = lastOfKind(h.posted, 'network') as { url: string; status: number; ok: boolean; via: string };
    expect(isNetworkEntry(net)).toBe(true);
    expect(net.url).toBe('/api/data');
    expect(net.status).toBe(404);
    expect(net.ok).toBe(false);
    expect(net.via).toBe('fetch');

    await expect(fetchFn('/fail')).rejects.toThrow('connection down');
    net = lastOfKind(h.posted, 'network') as { url: string; status: number; ok: boolean; via: string };
    expect(isNetworkEntry(net)).toBe(true);
    expect(net.url).toBe('/fail');
    expect(net.ok).toBe(false);
    expect((net as { error?: string }).error).toContain('connection down');
  });

  it('arms and disarms inspection on foundry:inspect and reports state', () => {
    const h = makeHarness();
    h.sendCommand({ source: 'foundry-app', kind: 'foundry:inspect', armed: true });
    let state = lastOfKind(h.posted, 'inspect-state') as { armed: boolean };
    expect(isInspectStateMessage(state)).toBe(true);
    expect(state.armed).toBe(true);
    expect((h.documentListeners.get('click') ?? []).length).toBe(1);

    h.sendCommand({ source: 'foundry-app', kind: 'foundry:inspect', armed: false });
    state = lastOfKind(h.posted, 'inspect-state') as { armed: boolean };
    expect(state.armed).toBe(false);
    expect((h.documentListeners.get('click') ?? []).length).toBe(0);
  });

  it('posts hover (on change only) and select payloads that pass the guards', () => {
    const h = makeHarness();
    h.sendCommand({ source: 'foundry-app', kind: 'foundry:inspect', armed: true });
    const move = h.documentListeners.get('mousemove')?.[0];
    const other = { ...h.h1, tagName: 'P' };
    move?.({ target: h.h1 });
    move?.({ target: h.h1 }); // same element: no duplicate hover post
    move?.({ target: other });
    const hovers = h.posted.filter(
      (m) => typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === 'inspect-hover',
    );
    expect(hovers.length).toBe(2);
    expect(isInspectHoverMessage(hovers[0])).toBe(true);
    const hoveredEl = (hovers[0] as { element: { tag: string; selector: string } }).element;
    expect(hoveredEl.tag).toBe('h1');
    expect(hoveredEl.selector).toBe('h1');

    const click = h.documentListeners.get('click')?.[0];
    let prevented = false;
    click?.({
      target: h.h1,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => undefined,
    });
    expect(prevented).toBe(true);
    const selected = lastOfKind(h.posted, 'inspect-select');
    expect(isInspectSelectMessage(selected)).toBe(true);
    const el = (selected as { element: { tag: string; text: string; selector: string; xpath: string } }).element;
    expect(el.tag).toBe('h1');
    expect(el.text).toBe('Hello world');
    expect(el.selector).toBe('h1');
    expect(el.xpath).toBe('/h1[1]');
    // Selecting auto-disarms.
    const state = lastOfKind(h.posted, 'inspect-state') as { armed: boolean };
    expect(state.armed).toBe(false);
  });

  it('applies styles, edits text, and confirms with honest read-backs', () => {
    const h = makeHarness();
    h.sendCommand({ source: 'foundry-app', kind: 'foundry:applyStyle', selector: 'h1', prop: 'color', value: 'red', requestId: 'r1' });
    let reply = lastOfKind(h.posted, 'style-applied') as { ok: boolean; applied?: string; requestId?: string };
    expect(isStyleAppliedMessage(reply)).toBe(true);
    expect(reply.ok).toBe(true);
    expect(reply.applied).toBe('red');
    expect(reply.requestId).toBe('r1');
    expect((h.h1.style as Record<string, string>).color).toBe('red');

    h.sendCommand({ source: 'foundry-app', kind: 'foundry:applyStyle', selector: 'h1', prop: 'background-color', value: 'blue', requestId: 'r2' });
    reply = lastOfKind(h.posted, 'style-applied') as { ok: boolean; applied?: string; requestId?: string };
    expect(reply.ok).toBe(true);
    expect(reply.applied).toBe('blue');

    h.sendCommand({ source: 'foundry-app', kind: 'foundry:applyStyle', selector: 'h1', prop: 'text', value: 'New title', requestId: 'r3' });
    reply = lastOfKind(h.posted, 'style-applied') as { ok: boolean; applied?: string; requestId?: string };
    expect(reply.ok).toBe(true);
    expect(reply.applied).toBe('New title');
    expect(h.h1.textContent).toBe('New title');

    h.sendCommand({ source: 'foundry-app', kind: 'foundry:applyStyle', selector: 'span', prop: 'color', value: 'red', requestId: 'r4' });
    reply = lastOfKind(h.posted, 'style-applied') as { ok: boolean; error?: string; requestId?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('no element matches selector');
    expect(reply.requestId).toBe('r4');
  });

  it('ring-buffers the last 200 feed entries and replays them on foundry:pull', () => {
    const h = makeHarness();
    for (let i = 0; i < 210; i++) h.con.log('entry', i);
    h.sendCommand({ source: 'foundry-app', kind: 'foundry:pull' });
    const replay = lastOfKind(h.posted, 'buffer');
    expect(isBufferMessage(replay)).toBe(true);
    const entries = (replay as { entries: Array<{ text: string }> }).entries;
    expect(entries.length).toBe(200);
    expect(entries[0]?.text).toBe('entry 10');
    expect(entries[199]?.text).toBe('entry 209');
  });

  it('ignores commands from other sources', () => {
    const h = makeHarness();
    h.sendCommand({ source: 'foundry-preview', kind: 'foundry:inspect', armed: true });
    h.sendCommand({ source: 'evil', kind: 'foundry:inspect', armed: true });
    expect(lastOfKind(h.posted, 'inspect-state')).toBeUndefined();
  });
});

describe('previewBridge protocol guards', () => {
  const ts = 1720000000000;

  it('accepts console entries as the script emits them', () => {
    const entry = { source: 'foundry-preview', kind: 'console', level: 'warn', text: 'a b', ts };
    expect(isConsoleEntry(entry)).toBe(true);
    expect(isPreviewEntry(entry)).toBe(true);
    expect(isPreviewMessage(entry)).toBe(true);
  });

  it('rejects malformed console entries', () => {
    const base = { source: 'foundry-preview', kind: 'console', level: 'warn', text: 'x', ts };
    expect(isConsoleEntry({ ...base, level: 'debug' })).toBe(false);
    expect(isConsoleEntry({ ...base, source: 'foundry-app' })).toBe(false);
    expect(isConsoleEntry({ ...base, text: 42 })).toBe(false);
    expect(isConsoleEntry({ ...base, ts: 'now' })).toBe(false);
  });

  it('accepts error and network entries', () => {
    const err = {
      source: 'foundry-preview', kind: 'error', message: 'boom', file: 'app.js', line: 3, col: 9, stack: 'at x', ts,
    };
    expect(isErrorEntry(err)).toBe(true);
    expect(isErrorEntry({ source: 'foundry-preview', kind: 'error', message: 'plain', ts })).toBe(true);
    expect(isErrorEntry({ source: 'foundry-preview', kind: 'error', ts })).toBe(false);

    const net = { source: 'foundry-preview', kind: 'network', method: 'GET', url: '/a.png', ok: true, durationMs: 12, via: 'performance', ts };
    expect(isNetworkEntry(net)).toBe(true);
    expect(isNetworkEntry({ ...net, ok: 'yes' })).toBe(false);
    expect(isNetworkEntry({ ...net, url: 7 })).toBe(false);
  });

  it('accepts ready / inspect-state / style-applied messages', () => {
    expect(isReadyMessage({ source: 'foundry-preview', kind: 'ready', href: 'https://x/', ts })).toBe(true);
    expect(isReadyMessage({ source: 'foundry-preview', kind: 'ready', ts })).toBe(false);

    expect(isInspectStateMessage({ source: 'foundry-preview', kind: 'inspect-state', armed: false, ts })).toBe(true);
    expect(isInspectStateMessage({ source: 'foundry-preview', kind: 'inspect-state', armed: 'no', ts })).toBe(false);

    const applied = {
      source: 'foundry-preview', kind: 'style-applied', ok: true,
      selector: 'h1', prop: 'color', value: 'red', applied: 'red', requestId: 'r1', ts,
    };
    expect(isStyleAppliedMessage(applied)).toBe(true);
    expect(isStyleAppliedMessage({ ...applied, ok: 'true' })).toBe(false);
    expect(isStyleAppliedMessage({ ...applied, selector: undefined })).toBe(false);
  });

  it('accepts inspect-hover and inspect-select with the full element payload', () => {
    const element = {
      tag: 'h1', id: 'hero', classes: ['title', 'big'], text: 'Hello',
      styles: {
        color: 'rgb(1, 2, 3)', backgroundColor: 'rgba(0, 0, 0, 0)', fontFamily: 'Inter',
        fontSize: '32px', fontWeight: '700', lineHeight: '40px',
        margin: '0px', padding: '8px', borderRadius: '4px',
      },
      xpath: '/#hero',
      selector: '#hero',
    };
    for (const kind of ['inspect-hover', 'inspect-select']) {
      const message = { source: 'foundry-preview', kind, element, ts };
      expect(isInspectHoverMessage(message)).toBe(kind === 'inspect-hover');
      expect(isInspectSelectMessage(message)).toBe(kind === 'inspect-select');
      expect(isPreviewMessage(message)).toBe(true);
      expect(isInspectSelectMessage({ ...message, element: { ...element, xpath: 1 } })).toBe(false);
      expect(isInspectSelectMessage({ ...message, element: { ...element, selector: undefined } })).toBe(false);
      expect(isInspectSelectMessage({ ...message, element: { ...element, styles: { color: 'red' } } })).toBe(false);
      expect(isInspectSelectMessage({ ...message, element: { ...element, classes: ['a', 2] } })).toBe(false);
    }
  });

  it('accepts buffer replays of feed entries only', () => {
    const entries = [
      { source: 'foundry-preview', kind: 'console', level: 'log', text: 'hi', ts },
      { source: 'foundry-preview', kind: 'network', method: 'GET', url: '/x', ok: false, status: 404, ts },
    ];
    expect(isBufferMessage({ source: 'foundry-preview', kind: 'buffer', entries, ts })).toBe(true);
    expect(isBufferMessage({ source: 'foundry-preview', kind: 'buffer', entries: [], ts })).toBe(true);
    const poisoned = [...entries, { source: 'foundry-preview', kind: 'inspect-select', element: {}, ts }];
    expect(isBufferMessage({ source: 'foundry-preview', kind: 'buffer', entries: poisoned, ts })).toBe(false);
  });

  it('rejects non-protocol messages and parent commands', () => {
    expect(isPreviewMessage(null)).toBe(false);
    expect(isPreviewMessage(undefined)).toBe(false);
    expect(isPreviewMessage('foundry-preview')).toBe(false);
    expect(isPreviewMessage({ source: 'react-devtools-bridge', kind: 'console', level: 'log', text: 'x', ts })).toBe(false);
    expect(isPreviewMessage({ source: 'foundry-preview', kind: 'mystery', ts })).toBe(false);
    // Parent -> child commands must never be mistaken for preview messages,
    // otherwise same-origin pages would echo commands back into the feed.
    expect(isPreviewMessage({ source: 'foundry-app', kind: 'foundry:inspect', armed: true })).toBe(false);
    expect(isPreviewMessage({ source: 'foundry-app', kind: 'foundry:applyStyle', selector: 'h1', prop: 'color', value: 'red', requestId: 'r' })).toBe(false);
    expect(isPreviewMessage({ source: 'foundry-app', kind: 'foundry:pull' })).toBe(false);
  });
});
