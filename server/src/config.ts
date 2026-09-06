import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROVIDERS = ['kimi', 'openai-compatible', 'ollama', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface FoundryConfig {
  provider: Provider;
  endpoint: string;
  model: string;
}

export interface DataDirs {
  root: string;
  sites: string;
  certs: string;
  configFile: string;
  secretsFile: string;
}

export const DEFAULT_CONFIG: FoundryConfig = {
  provider: 'mock',
  endpoint: '',
  model: 'mock',
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function dataDirs(root: string): DataDirs {
  return {
    root,
    sites: path.join(root, 'sites'),
    certs: path.join(root, 'certs'),
    configFile: path.join(root, 'foundry.config.json'),
    secretsFile: path.join(root, 'secrets.json'),
  };
}

export async function ensureDataDirs(root: string): Promise<DataDirs> {
  const dirs = dataDirs(root);
  await fs.mkdir(dirs.sites, { recursive: true });
  await fs.mkdir(dirs.certs, { recursive: true });
  return dirs;
}

// In-memory caches keyed by data root; writes invalidate/replace entries.
const configCache = new Map<string, FoundryConfig>();
const keyCache = new Map<string, string>();

async function atomicWriteJson(file: string, value: unknown, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function parseConfig(raw: string, file: string): FoundryConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`config file ${file} is not valid JSON`);
  }
  const obj = parsed as Partial<FoundryConfig> | null;
  if (!obj || typeof obj !== 'object') throw new ConfigError(`config file ${file} must contain an object`);
  if (typeof obj.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(obj.provider)) {
    throw new ConfigError(`config file ${file} has an unknown provider: ${String(obj.provider)}`);
  }
  if (typeof obj.endpoint !== 'string' || typeof obj.model !== 'string') {
    throw new ConfigError(`config file ${file} must have string "endpoint" and "model" fields`);
  }
  return { provider: obj.provider as Provider, endpoint: obj.endpoint, model: obj.model };
}

/** Returns the persisted config, or DEFAULT_CONFIG when none exists yet. */
export async function readConfig(root: string): Promise<FoundryConfig> {
  const cached = configCache.get(root);
  if (cached) return cached;
  const { configFile } = dataDirs(root);
  let raw: string;
  try {
    raw = await fs.readFile(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      configCache.set(root, { ...DEFAULT_CONFIG });
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
  const config = parseConfig(raw, configFile);
  configCache.set(root, config);
  return { ...config };
}

export async function writeConfig(root: string, config: FoundryConfig): Promise<void> {
  await ensureDataDirs(root);
  const { configFile } = dataDirs(root);
  await atomicWriteJson(
    configFile,
    { provider: config.provider, endpoint: config.endpoint, model: config.model },
    0o644,
  );
  configCache.set(root, { ...config });
}

/** Returns the stored provider API key, or '' when none is set. */
export async function readKey(root: string): Promise<string> {
  const cached = keyCache.get(root);
  if (cached !== undefined) return cached;
  const { secretsFile } = dataDirs(root);
  let raw: string;
  try {
    raw = await fs.readFile(secretsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      keyCache.set(root, '');
      return '';
    }
    throw err;
  }
  let key: string;
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    key = typeof parsed?.apiKey === 'string' ? parsed.apiKey : '';
  } catch {
    throw new ConfigError(`secrets file ${secretsFile} is not valid JSON`);
  }
  keyCache.set(root, key);
  return key;
}

/** Persists the API key in data/secrets.json with 0600 perms (best-effort on Windows). */
export async function writeKey(root: string, key: string): Promise<void> {
  await ensureDataDirs(root);
  const { secretsFile } = dataDirs(root);
  await atomicWriteJson(secretsFile, { apiKey: key }, 0o600);
  try {
    await fs.chmod(secretsFile, 0o600);
  } catch {
    /* best-effort */
  }
  keyCache.set(root, key);
}
