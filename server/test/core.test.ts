import { promises as fs } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCerts } from '../src/certs.js';
import {
  ConfigError,
  DEFAULT_CONFIG,
  dataDirs,
  readConfig,
  readKey,
  writeConfig,
  writeKey,
} from '../src/config.js';
import { createServer } from '../src/index.js';
import { SseHub, type SseEvent } from '../src/sse.js';

function fakeResponse() {
  const chunks: string[] = [];
  let closeHandler: (() => void) | undefined;
  return {
    chunks,
    res: {
      writeHead: () => undefined,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      on: (event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      },
      end: () => {
        chunks.push('<end>');
      },
    },
    close: () => closeHandler?.(),
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-core-'));
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

describe('certs', () => {
  it('generates then reloads a persisted cert pair', { timeout: 30_000 }, async () => {
    const certsDir = path.join(root, 'certs');
    const first = await ensureCerts(certsDir);
    expect(first.cert).toContain('BEGIN CERTIFICATE');
    expect(first.key).toContain('PRIVATE KEY');
    expect(await fs.readFile(path.join(certsDir, 'cert.pem'), 'utf8')).toBe(first.cert);
    expect(await fs.readFile(path.join(certsDir, 'key.pem'), 'utf8')).toBe(first.key);

    const second = await ensureCerts(certsDir);
    expect(second).toEqual(first);
  });
});

describe('config store', () => {
  it('returns defaults when no config file exists', async () => {
    expect(await readConfig(root)).toEqual(DEFAULT_CONFIG);
    expect(await readKey(root)).toBe('');
  });

  it('round-trips config and key, keeping the key out of the config file', async () => {
    await writeConfig(root, { provider: 'kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2' });
    await writeKey(root, 'sk-test-secret');

    expect(await readConfig(root)).toEqual({
      provider: 'kimi',
      endpoint: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2',
    });
    expect(await readKey(root)).toBe('sk-test-secret');

    const configRaw = await fs.readFile(dataDirs(root).configFile, 'utf8');
    expect(configRaw).not.toContain('sk-test-secret');
    expect(JSON.parse(configRaw)).not.toHaveProperty('apiKey');
  });

  it('invalidates the cache on write', async () => {
    await writeConfig(root, { provider: 'mock', endpoint: '', model: 'mock' });
    await readConfig(root);
    await writeConfig(root, { provider: 'ollama', endpoint: 'http://localhost:11434', model: 'llama3.1' });
    expect((await readConfig(root)).provider).toBe('ollama');
    await writeKey(root, 'first');
    await readKey(root);
    await writeKey(root, 'second');
    expect(await readKey(root)).toBe('second');
  });

  it.runIf(process.platform !== 'win32')('locks the secrets file down to 0600 on POSIX', async () => {
    await writeKey(root, 'sk-test');
    const stat = await fs.stat(dataDirs(root).secretsFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writes atomically, leaving no tmp files behind', async () => {
    await writeConfig(root, { provider: 'mock', endpoint: '', model: 'mock' });
    await writeKey(root, 'k');
    const names = await fs.readdir(root);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names.sort()).toEqual(['certs', 'foundry.config.json', 'secrets.json', 'sites']);
  });

  it('rejects a corrupt config file with an honest error', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(dataDirs(root).configFile, '{not json', 'utf8');
    await expect(readConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('sse hub', () => {
  it('replays buffered events to late subscribers and streams live ones', () => {
    const hub = new SseHub({ heartbeatMs: 60_000 });
    try {
      hub.send('b1', { type: 'phase', phase: 'INTAKE' } as SseEvent);
      const late = fakeResponse();
      hub.subscribe('b1', late.res as never);
      expect(late.chunks[0]).toBe(': connected\n\n');
      expect(late.chunks[1]).toBe('data: {"type":"phase","phase":"INTAKE"}\n\n');

      hub.send('b1', { type: 'message', text: 'hi' } as SseEvent);
      expect(late.chunks[2]).toBe('data: {"type":"message","text":"hi"}\n\n');

      // Channels are isolated.
      const other = fakeResponse();
      hub.subscribe('b2', other.res as never);
      expect(other.chunks).toEqual([': connected\n\n']);
    } finally {
      hub.shutdown();
    }
  });

  it('keeps only the last bufferSize events for replay', () => {
    const hub = new SseHub({ heartbeatMs: 60_000, bufferSize: 3 });
    try {
      for (let i = 0; i < 5; i += 1) hub.send('b1', { type: 'activity', i } as SseEvent);
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      const events = sub.chunks.filter((c) => c.startsWith('data:'));
      expect(events).toEqual([
        'data: {"type":"activity","i":2}\n\n',
        'data: {"type":"activity","i":3}\n\n',
        'data: {"type":"activity","i":4}\n\n',
      ]);
    } finally {
      hub.shutdown();
    }
  });

  it('emits heartbeat comments and stops writing after close', async () => {
    const hub = new SseHub({ heartbeatMs: 15 });
    try {
      const sub = fakeResponse();
      hub.subscribe('b1', sub.res as never);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sub.chunks.some((c) => c === ': heartbeat\n\n')).toBe(true);

      const before = sub.chunks.length;
      sub.close();
      hub.send('b1', { type: 'message' } as SseEvent);
      expect(sub.chunks.length).toBe(before);
    } finally {
      hub.shutdown();
    }
  });

  it('ends open streams with a comment on shutdown', () => {
    const hub = new SseHub({ heartbeatMs: 60_000 });
    const sub = fakeResponse();
    hub.subscribe('b1', sub.res as never);
    hub.shutdown();
    expect(sub.chunks).toContain(': server shutting down\n\n');
    expect(sub.chunks[sub.chunks.length - 1]).toBe('<end>');
  });
});

describe('createServer', () => {
  it('serves /api/config without ever exposing the key', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const before = await fetch(`${base}/api/config`);
        expect(before.status).toBe(200);
        expect(await before.json()).toEqual({ provider: 'mock', endpoint: '', model: 'mock', hasKey: false, perRoleModels: {} });

        const put = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'kimi',
            endpoint: 'https://api.moonshot.cn/v1',
            model: 'kimi-k2',
            apiKey: 'sk-live-secret',
          }),
        });
        expect(put.status).toBe(200);
        const body = (await put.json()) as Record<string, unknown>;
        expect(body).toEqual({
          provider: 'kimi',
          endpoint: 'https://api.moonshot.cn/v1',
          model: 'kimi-k2',
          hasKey: true,
          perRoleModels: {},
        });
        expect(JSON.stringify(body)).not.toContain('sk-live-secret');

        const after = await (await fetch(`${base}/api/config`)).json();
        expect(after).toEqual({
          provider: 'kimi',
          endpoint: 'https://api.moonshot.cn/v1',
          model: 'kimi-k2',
          hasKey: true,
          perRoleModels: {},
        });
        expect(await readKey(root)).toBe('sk-live-secret');
      });
    } finally {
      await foundry.close();
    }
  });

  it('persists a default foundry.config.json on first run', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      const onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8'));
      expect(onDisk).toEqual(DEFAULT_CONFIG);
    } finally {
      await foundry.close();
    }
  });

  it('answers 503 with guidance when the web UI is not built', async () => {
    const foundry = await createServer({
      dataRoot: root,
      webRoot: path.join(root, 'no-such-dist'),
      listen: false,
      log: () => undefined,
    });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('npm run build:web');
      });
    } finally {
      await foundry.close();
    }
  });

  it('404s unknown /api routes as JSON', async () => {
    const foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
    try {
      await withServer(foundry.app, async (base) => {
        const res = await fetch(`${base}/api/nope`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not found' });
      });
    } finally {
      await foundry.close();
    }
  });

  it('listens over real https and closes gracefully', { timeout: 30_000 }, async () => {
    const foundry = await createServer({
      dataRoot: root,
      listen: true,
      httpsPort: 0,
      httpPort: 0,
      log: () => undefined,
    });
    try {
      const { port } = foundry.httpsServer!.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/api/config', rejectUnauthorized: false }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString('utf8');
            });
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });
      expect((JSON.parse(body) as { provider: string }).provider).toBe('mock');
      // Cert files were generated on first listen.
      const certRaw = await fs.readFile(path.join(dataDirs(root).certs, 'cert.pem'), 'utf8');
      expect(certRaw).toContain('BEGIN CERTIFICATE');
    } finally {
      await foundry.close();
    }
    expect(foundry.httpsServer!.listening).toBe(false);
    expect(foundry.httpServer!.listening).toBe(false);
  });
});
