import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, dataDirs, readConfig, writeConfig, type PerRoleModels } from '../src/config.js';
import { createServer, type FoundryServer } from '../src/index.js';

const VALID_BODY = { provider: 'kimi', endpoint: 'https://api.example.com', model: 'kimi-k2' };
const FULL_OVERRIDES = {
  design: 'kimi-k2-design',
  copy: 'kimi-k2-copy',
  builder: 'kimi-k2-builder',
  reviewer: 'kimi-k2-reviewer',
};

let root: string;
let foundry: FoundryServer;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-cfg-roles-'));
  foundry = await createServer({ dataRoot: root, listen: false, log: () => undefined });
});

afterEach(async () => {
  await foundry.close();
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

async function putConfig(base: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function getConfig(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/config`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('per-role model config', () => {
  it('round-trips perRoleModels through foundry.config.json', async () => {
    await writeConfig(root, { ...VALID_BODY, provider: 'kimi', perRoleModels: FULL_OVERRIDES });
    const onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['perRoleModels']).toEqual(FULL_OVERRIDES);

    // Cold read: use a second root sharing the same file via a fresh copy.
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-cfg-roles-clone-'));
    try {
      await fs.copyFile(dataDirs(root).configFile, dataDirs(clone).configFile);
      const read = await readConfig(clone);
      expect(read.perRoleModels).toEqual(FULL_OVERRIDES);
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  });

  it('omits perRoleModels from the file when absent or empty (backward compat)', async () => {
    await writeConfig(root, { provider: 'mock', endpoint: '', model: 'mock' });
    let onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8')) as Record<string, unknown>;
    expect('perRoleModels' in onDisk).toBe(false);

    await writeConfig(root, { provider: 'mock', endpoint: '', model: 'mock', perRoleModels: {} });
    onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8')) as Record<string, unknown>;
    expect('perRoleModels' in onDisk).toBe(false);
  });

  it('reads an old config file without perRoleModels', async () => {
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-cfg-roles-old-'));
    try {
      await fs.writeFile(
        dataDirs(clone).configFile,
        JSON.stringify({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'qwen' }),
        'utf8',
      );
      const read = await readConfig(clone);
      expect(read.provider).toBe('ollama');
      expect(read.perRoleModels).toBeUndefined();
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  });

  it('rejects an invalid persisted perRoleModels with an honest error', async () => {
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-cfg-roles-bad-'));
    try {
      await fs.writeFile(
        dataDirs(clone).configFile,
        JSON.stringify({ provider: 'mock', endpoint: '', model: 'mock', perRoleModels: { planner: 'x' } }),
        'utf8',
      );
      await expect(readConfig(clone)).rejects.toThrow(ConfigError);
      await expect(readConfig(clone)).rejects.toThrow(/unknown role "planner"/);
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  });

  it('writeConfig validates perRoleModels instead of silently persisting junk', async () => {
    await expect(
      writeConfig(root, {
        provider: 'mock',
        endpoint: '',
        model: 'mock',
        perRoleModels: { design: 42 } as unknown as PerRoleModels,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('PUT accepts perRoleModels and GET reports them', async () => {
    await withServer(foundry.app, async (base) => {
      const put = await putConfig(base, { ...VALID_BODY, perRoleModels: FULL_OVERRIDES });
      expect(put.status).toBe(200);
      expect(put.json['perRoleModels']).toEqual(FULL_OVERRIDES);

      const get = await getConfig(base);
      expect(get).toEqual({
        provider: 'kimi',
        endpoint: 'https://api.example.com',
        model: 'kimi-k2',
        hasKey: false,
        perRoleModels: FULL_OVERRIDES,
      });
      // The UI renders "model per role (N overrides)" from this map.
      expect(Object.keys(get['perRoleModels'] as Record<string, string>)).toHaveLength(4);
    });
  });

  it('PUT validates each perRoleModels entry', async () => {
    await withServer(foundry.app, async (base) => {
      const cases: Array<[unknown, RegExp]> = [
        [{ planner: 'x' }, /unknown role "planner"/],
        [{ design: 42 }, /perRoleModels\.design must be a non-empty string/],
        [{ copy: '   ' }, /perRoleModels\.copy must be a non-empty string/],
        [{ builder: 'x'.repeat(129) }, /at most 128 characters/],
        [{ reviewer: { name: 'x' } }, /perRoleModels\.reviewer must be a non-empty string/],
        ['kimi-k2', /perRoleModels must be an object/],
        [[['design', 'x']], /perRoleModels must be an object/],
      ];
      for (const [perRoleModels, pattern] of cases) {
        const res = await putConfig(base, { ...VALID_BODY, perRoleModels });
        expect(res.status).toBe(400);
        expect(String(res.json['error'])).toMatch(pattern);
      }

      // A rejected PUT must not clobber the stored config.
      const get = await getConfig(base);
      expect(get['provider']).toBe('mock');
      expect(get['perRoleModels']).toEqual({});
    });
  });

  it('accepts exactly 128 characters and a partial override set', async () => {
    await withServer(foundry.app, async (base) => {
      const perRoleModels = { builder: 'm'.repeat(128) };
      const put = await putConfig(base, { ...VALID_BODY, perRoleModels });
      expect(put.status).toBe(200);
      expect(put.json['perRoleModels']).toEqual(perRoleModels);
      expect((await getConfig(base))['perRoleModels']).toEqual(perRoleModels);
    });
  });

  it('PUT without perRoleModels clears prior overrides (full replace)', async () => {
    await withServer(foundry.app, async (base) => {
      const first = await putConfig(base, { ...VALID_BODY, perRoleModels: FULL_OVERRIDES });
      expect(first.status).toBe(200);

      const second = await putConfig(base, VALID_BODY);
      expect(second.status).toBe(200);
      expect(second.json['perRoleModels']).toEqual({});
      expect((await getConfig(base))['perRoleModels']).toEqual({});

      const onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8')) as Record<string, unknown>;
      expect('perRoleModels' in onDisk).toBe(false);
    });
  });

  it('never writes perRoleModels into secrets.json', async () => {
    await withServer(foundry.app, async (base) => {
      const put = await putConfig(base, { ...VALID_BODY, apiKey: 'sk-test', perRoleModels: FULL_OVERRIDES });
      expect(put.status).toBe(200);
      expect(put.json['hasKey']).toBe(true);

      const secrets = JSON.parse(await fs.readFile(dataDirs(root).secretsFile, 'utf8')) as Record<string, unknown>;
      expect(secrets).toEqual({ apiKey: 'sk-test' });

      const onDisk = JSON.parse(await fs.readFile(dataDirs(root).configFile, 'utf8')) as Record<string, unknown>;
      expect(onDisk['perRoleModels']).toEqual(FULL_OVERRIDES);
      expect('apiKey' in onDisk).toBe(false);
    });
  });

  it('GET defaults perRoleModels to {} when the file predates the field', async () => {
    await withServer(foundry.app, async (base) => {
      const get = await getConfig(base);
      expect(get['perRoleModels']).toEqual({});
    });
  });
});
