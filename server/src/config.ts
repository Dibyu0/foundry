import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROVIDERS = ['kimi', 'openai-compatible', 'ollama', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

// Roles that may route to a different model. 'planner' is intentionally
// excluded: it always uses the base model.
export const ROLE_MODEL_KEYS = ['design', 'copy', 'builder', 'reviewer'] as const;
export type RoleModelKey = (typeof ROLE_MODEL_KEYS)[number];
export type PerRoleModels = Partial<Record<RoleModelKey, string>>;
export const MAX_ROLE_MODEL_LEN = 128;

export interface FoundryConfig {
  provider: Provider;
  endpoint: string;
  model: string;
  perRoleModels?: PerRoleModels;
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

/**
 * Validates an untrusted perRoleModels value (from the config file or a PUT
 * body). Returns undefined when the field is absent; throws ConfigError
 * describing the first problem found.
 */
export function validatePerRoleModels(value: unknown): PerRoleModels | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('perRoleModels must be an object keyed by role name');
  }
  const out: PerRoleModels = {};
  for (const [key, model] of Object.entries(value)) {
    if (!(ROLE_MODEL_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`perRoleModels has an unknown role "${key}" (allowed: ${ROLE_MODEL_KEYS.join(', ')})`);
    }
    if (typeof model !== 'string' || model.trim() === '' || model.length > MAX_ROLE_MODEL_LEN) {
      throw new ConfigError(
        `perRoleModels.${key} must be a non-empty string of at most ${MAX_ROLE_MODEL_LEN} characters`,
      );
    }
    out[key as RoleModelKey] = model;
  }
  return out;
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

// Deep enough to keep callers from mutating cached state (perRoleModels is
// the only nested object).
function copyConfig(config: FoundryConfig): FoundryConfig {
  const copy: FoundryConfig = { ...config };
  if (config.perRoleModels) copy.perRoleModels = { ...config.perRoleModels };
  return copy;
}

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
  let perRoleModels: PerRoleModels | undefined;
  try {
    perRoleModels = validatePerRoleModels(obj.perRoleModels);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`config file ${file}: ${err.message}`);
    throw err;
  }
  const config: FoundryConfig = { provider: obj.provider as Provider, endpoint: obj.endpoint, model: obj.model };
  if (perRoleModels !== undefined) config.perRoleModels = perRoleModels;
  return config;
}

/** Returns the persisted config, or DEFAULT_CONFIG when none exists yet. */
export async function readConfig(root: string): Promise<FoundryConfig> {
  const cached = configCache.get(root);
  if (cached) return copyConfig(cached);
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
  // Never clobber a value that a concurrent writeConfig cached while this
  // read was in flight — the writer's value is always newer.
  if (!configCache.has(root)) configCache.set(root, config);
  return copyConfig(config);
}

export async function writeConfig(root: string, config: FoundryConfig): Promise<void> {
  await ensureDataDirs(root);
  const { configFile } = dataDirs(root);
  const perRoleModels = validatePerRoleModels(config.perRoleModels);
  const persisted: FoundryConfig = { provider: config.provider, endpoint: config.endpoint, model: config.model };
  // An empty overrides map is equivalent to absent; keep the file minimal.
  if (perRoleModels !== undefined && Object.keys(perRoleModels).length > 0) {
    persisted.perRoleModels = perRoleModels;
  }
  await atomicWriteJson(configFile, persisted, 0o644);
  configCache.set(root, copyConfig(persisted));
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
  // Same rule as readConfig: a concurrent writeKey's cache wins over this
  // in-flight read.
  if (!keyCache.has(root)) keyCache.set(root, key);
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
