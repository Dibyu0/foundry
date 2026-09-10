import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface Provider {
  complete(messages: ChatMessage[], opts?: CallOptions): Promise<string>;
  stream(messages: ChatMessage[], onDelta: (delta: string) => void, opts?: CallOptions): Promise<string>;
}

export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    if (status !== undefined) this.status = status;
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type KeyReader = () => string | null | undefined | Promise<string | null | undefined>;

/**
 * Reads the raw persisted provider config (foundry.config.json) as an
 * untyped object. Carries the opt-in hints the typed config reader may
 * predate (perRoleModels, aiCacheRetention); absent keys mean "no hint".
 */
export type RawConfigReader = () =>
  | Record<string, unknown>
  | null
  | undefined
  | Promise<Record<string, unknown> | null | undefined>;

export interface HttpProviderConfig {
  endpoint?: string;
  model?: string;
  getKey?: KeyReader;
  getRawConfig?: RawConfigReader;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Idle-between-chunks budget for streamed bodies; a stalled SSE stream is aborted after this. Default 45s. */
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Clock for the retry wall-clock budget; tests inject a fake. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 30_000;
const MAX_RETRY_AFTER_WAITS = 2;
const RETRY_WALL_CLOCK_CAP_MS = 300_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 4_000;
const JITTER_MS = 250;
const ERROR_BODY_MAX = 300;

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function scrub(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join('***');
  }
  return out;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Hooks {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
  maxRetries: number;
  key: string | null;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: string | null;
  stream: ReadableStream<Uint8Array> | null;
  /**
   * Streaming results only: releases the caller-abort wiring once the body
   * is consumed, tearing the socket down when the read ended early. A no-op
   * for the connection after a complete read.
   */
  releaseStream?: () => void;
}

async function readBodyCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new StringDecoder('utf8');
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.write(value);
      if (out.length >= cap) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    out += decoder.end();
  } finally {
    reader.releaseLock();
  }
  return out;
}

interface RetryDelay {
  delay: number;
  usedRetryAfter: boolean;
}

function retryDelayMs(
  h: Hooks,
  retryIndex: number,
  retryAfterHeader: string | null,
  retryAfterWaitsUsed: number,
): RetryDelay {
  // Retry-After is honored at most MAX_RETRY_AFTER_WAITS times per request;
  // beyond that plain backoff takes over so a stubborn 429 cannot pin the
  // loop to the server's schedule. Honored waits are jittered too, keeping
  // concurrent builds from retrying in lockstep.
  if (retryAfterHeader !== null && retryAfterWaitsUsed < MAX_RETRY_AFTER_WAITS) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      if (ms <= RETRY_AFTER_CAP_MS) {
        return { delay: ms + Math.floor(h.random() * JITTER_MS), usedRetryAfter: true };
      }
    }
  }
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** retryIndex, BACKOFF_CAP_MS);
  return { delay: exp + Math.floor(h.random() * JITTER_MS), usedRetryAfter: false };
}

async function postJson(h: Hooks, url: string, payload: unknown, callerSignal?: AbortSignal): Promise<HttpResult> {
  if (callerSignal?.aborted) throw new AbortError();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (h.key) headers.authorization = `Bearer ${h.key}`;

  const startedAt = h.now();
  let retryAfterWaits = 0;
  let lastError: Error | null = null;

  // Sleeps before the next retry, or returns false once the 5-minute
  // wall-clock budget for the whole retry sequence is spent — the caller
  // then surfaces the current error instead of scheduling another attempt.
  async function sleepForRetry(retryIndex: number, retryAfterHeader: string | null): Promise<boolean> {
    const plan = retryDelayMs(h, retryIndex, retryAfterHeader, retryAfterWaits);
    const elapsed = h.now() - startedAt;
    if (elapsed >= RETRY_WALL_CLOCK_CAP_MS || elapsed + plan.delay > RETRY_WALL_CLOCK_CAP_MS) return false;
    if (plan.usedRetryAfter) retryAfterWaits += 1;
    await h.sleep(plan.delay);
    return true;
  }

  for (let attempt = 0; attempt <= h.maxRetries; attempt += 1) {
    if (callerSignal?.aborted) throw new AbortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, h.timeoutMs);
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    // Set once a streamed body is handed to the consumer: the caller-abort
    // listener then stays wired until releaseStream runs, so an abort still
    // reaches the socket while the body is being read.
    let streamHandedOff = false;
    try {
      const res = await h.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        const body = res.body;
        const isStream = body !== null && payload !== null && typeof payload === 'object'
          && (payload as { stream?: unknown }).stream === true;
        if (isStream) {
          // Headers are in: the request timeout has done its job and the
          // idle-between-chunks timeout in parseSseLines guards the body.
          streamHandedOff = true;
          clearTimeout(timer);
          return {
            status: res.status,
            headers: res.headers,
            body: null,
            stream: body,
            releaseStream: () => {
              callerSignal?.removeEventListener('abort', onCallerAbort);
              controller.abort();
            },
          };
        }
        return {
          status: res.status,
          headers: res.headers,
          body: await res.text(),
          stream: null,
        };
      }
      const rawBody = res.body !== null
        ? await readBodyCapped(res.body, ERROR_BODY_MAX + 64)
        : await res.text().catch(() => '');
      const detail = truncate(scrub(rawBody, [h.key]), ERROR_BODY_MAX);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < h.maxRetries && (await sleepForRetry(attempt, res.headers.get('retry-after')))) {
        continue;
      }
      throw new ProviderError(`request failed with status ${res.status}: ${detail}`, res.status);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (callerSignal?.aborted) throw new AbortError();
      const isAbort = e instanceof Error && e.name === 'AbortError';
      const msg = timedOut || isAbort
        ? `request timed out after ${h.timeoutMs}ms`
        : `network error: ${scrub(errMsg(e), [h.key])}`;
      lastError = new ProviderError(msg);
      if (attempt < h.maxRetries && (await sleepForRetry(attempt, null))) {
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      if (!streamHandedOff) callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
  throw lastError ?? new ProviderError('request failed');
}

export interface StreamReadOptions {
  /** Caller abort: cancels the read and fails with AbortError. */
  signal?: AbortSignal;
  /** Fails the stream when no chunk arrives within this budget. */
  idleTimeoutMs?: number;
}

/**
 * Incremental SSE line splitter: byte-chunk safe (StringDecoder) and tolerant
 * of a CRLF split across chunks. onLine receives each line without its
 * terminator; blank lines are delivered too (the caller ignores them). With
 * opts, a caller abort cancels the read (AbortError) and an idle gap beyond
 * idleTimeoutMs fails the stream instead of waiting on a stalled body forever.
 */
export async function parseSseLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  opts?: StreamReadOptions,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let idleTimedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleMs = opts?.idleTimeoutMs;
  const armIdleTimer = (): void => {
    if (idleMs === undefined || idleMs <= 0) return;
    clearTimeout(idleTimer);
    const timer = setTimeout(() => {
      idleTimedOut = true;
      void reader.cancel().catch(() => undefined);
    }, idleMs);
    // A stalled stream must not pin the event loop on its own.
    if (typeof timer.unref === 'function') timer.unref();
    idleTimer = timer;
  };
  const onCallerAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  opts?.signal?.addEventListener('abort', onCallerAbort, { once: true });
  armIdleTimer();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      if (!value || value.length === 0) continue;
      buffer += decoder.write(value);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    }
    // A cancel surfaces as a clean done, so the flags decide whether the
    // stream truly finished before the tail is delivered as a final line.
    if (opts?.signal?.aborted) throw new AbortError();
    if (idleTimedOut) throw new ProviderError(`stream stalled: no data for ${idleMs}ms`);
    buffer += decoder.end();
    if (buffer.length > 0) {
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
      onLine(buffer);
    }
  } catch (e) {
    // The socket aborting mid-read rejects read(); report the caller's abort.
    if (opts?.signal?.aborted) throw new AbortError();
    throw e;
  } finally {
    clearTimeout(idleTimer);
    opts?.signal?.removeEventListener('abort', onCallerAbort);
    reader.releaseLock();
  }
}

async function readSseData(
  stream: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
  opts?: StreamReadOptions,
): Promise<void> {
  let sawDone = false;
  await parseSseLines(stream, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).replace(/^ /, '');
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }
    onData(payload);
  }, opts);
  // A clean FIN without the terminal sentinel means the connection dropped
  // mid-generation; the partial text must not pass for a complete answer.
  if (!sawDone) throw new ProviderError('stream ended before the completion marker');
}

async function resolveDefaultKey(): Promise<string | null> {
  // The config workstream owns server/src/config.ts and exports
  // readKey(root), where root is the data directory (secrets live in
  // <root>/secrets.json). Load it lazily through a computed specifier so
  // this module compiles and runs whether or not that file has landed yet,
  // then fall back to reading data/secrets.json directly.
  try {
    const specifier = '../config.js';
    const mod: unknown = await import(specifier);
    const readKey = (mod as { readKey?: unknown }).readKey;
    if (typeof readKey === 'function') {
      const dataRoot = process.env.FOUNDRY_DATA_DIR ?? path.resolve(process.cwd(), 'data');
      const key = await (readKey as (root: string) => Promise<string>)(dataRoot);
      if (typeof key === 'string' && key.trim() !== '') return key;
    }
  } catch {
    // config module not present yet or unreadable; try the secrets file
  }
  try {
    const secretsPath = path.resolve(
      process.env.FOUNDRY_DATA_DIR ?? path.resolve(process.cwd(), 'data'),
      'secrets.json'
    );
    const raw = await readFile(secretsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      for (const field of ['apiKey', 'moonshotApiKey', 'kimiApiKey', 'key']) {
        const v = rec[field];
        if (typeof v === 'string' && v.trim() !== '') return v;
      }
    }
  } catch {
    // no secrets file either; the provider reports an honest error on use
  }
  return null;
}

/**
 * Reads foundry.config.json as an untyped object, tolerating anything
 * missing or unreadable. The typed config reader owns honest errors for the
 * fields it knows; this raw read exists so the opt-in hints below keep
 * working whether or not the config module has caught up to them yet.
 */
async function readRawProviderConfig(): Promise<Record<string, unknown> | null> {
  try {
    const configPath = path.resolve(
      process.env.FOUNDRY_DATA_DIR ?? path.resolve(process.cwd(), 'data'),
      'foundry.config.json',
    );
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // absent or unreadable config: no hints, the defaults apply
  }
  return null;
}

function rawConfigReader(config: HttpProviderConfig): () => Promise<Record<string, unknown> | null> {
  return async () => {
    if (config.getRawConfig) return (await config.getRawConfig()) ?? null;
    return readRawProviderConfig();
  };
}

/** The perRoleModels map from raw config, reduced to the four overridable roles. */
function perRoleModelsFrom(raw: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  const value = raw?.['perRoleModels'];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const role of ['design', 'copy', 'builder', 'reviewer']) {
      const model = rec[role];
      if (typeof model === 'string' && model.trim() !== '') out[role] = model;
    }
  }
  return out;
}

/**
 * The cacheRetention hint for the Kimi request body, passed through verbatim
 * from the aiCacheRetention config key: a retention label, a seconds count,
 * or true to ask for the provider default. Absent, false or empty means the
 * field stays off the wire entirely.
 */
function cacheRetentionFrom(raw: Record<string, unknown> | null): string | number | true | undefined {
  const value = raw?.['aiCacheRetention'];
  if (value === true) return true;
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/** Picks the model for one call: the per-role override when configured, else the provider default. */
function modelForCall(raw: Record<string, unknown> | null, messages: ChatMessage[], fallback: string): string {
  const role = roleFromMessages(messages);
  if (role === null) return fallback;
  const override = perRoleModelsFrom(raw)[role];
  const chosen = override ?? fallback;
  console.debug(`[foundry] ${role} call routed to model ${chosen}${override !== undefined ? ' (per-role override)' : ''}`);
  return chosen;
}

/**
 * Role prompts carry a [role:...] marker in the system message; the mock
 * provider's script dispatch and the per-role model override both key off it.
 */
const ROLE_MARKER = /\[role:(planner|design|copy|builder|reviewer)\]/;

/** The [role:...] marker of the last system message, or null when absent. */
export function roleFromMessages(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'system') {
      const match = ROLE_MARKER.exec(m.content);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

// Blocks whose content changes from run to run inside a build (the brief,
// answers, plan, files list, the planner's round counter and the builder's
// per-pass contract). Everything else in the role prompts — role intro, tool
// convention, the premium recipe — is byte-stable across calls.
const PER_RUN_BLOCK = /^(?:SITE BRIEF \(from the user\)|CLARIFYING ANSWERS|APPROVED PLAN|PLAN\n|FILES WRITTEN SO FAR|FIX PASS\n|REMAINING FILES\n|OUTPUT CONTRACT\n|RULES\n)/;

/**
 * Reorders a role system prompt for provider-side prefix caching. Providers
 * cache prompts from the left edge: the longest shared leading span is reused
 * across calls and only the differing tail is re-tokenized. The role prompts
 * are authored with the per-run content (brief, answers, plan, files) up
 * front and the shared premium recipe after it, which defeats that cache —
 * two calls in the same build share almost no leading tokens. Moving the
 * per-run blocks to the end makes the role intro, tool convention and the
 * whole recipe one stable prefix shared by every role call in every build.
 * No content is added or dropped; only block order changes.
 */
export function orderSystemContentForPrefixCaching(content: string): string {
  if (!content.includes('\n\n')) return content;
  const blocks = content.split('\n\n');
  const stable: string[] = [];
  const perRun: string[] = [];
  for (const block of blocks) {
    (PER_RUN_BLOCK.test(block) ? perRun : stable).push(block);
  }
  if (perRun.length === 0 || stable.length === 0) return content;
  return [...stable, ...perRun].join('\n\n');
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  // Prompt-based tool convention: tool results ride as user messages. Most
  // OpenAI-compatible servers reject role:"tool" without a tool_call_id, and
  // local Ollama models handle user-role context more reliably.
  // System prompts pass through the prefix-cache reorder so the shared
  // recipe leads and the per-run tail trails on the wire.
  return messages.map((m) => ({
    role: m.role === 'tool' ? 'user' : m.role,
    content: m.role === 'system' ? orderSystemContentForPrefixCaching(m.content) : m.content,
  }));
}

function joinUrl(endpoint: string, suffix: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (base.endsWith(suffix)) return base;
  return base + suffix;
}

function extractChoiceContent(payload: unknown, streaming: boolean): string {
  if (!payload || typeof payload !== 'object') {
    throw new ProviderError('malformed response: not an object');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown>;
  const node = streaming ? first.delta : first.message;
  if (!node || typeof node !== 'object') return '';
  const content = (node as { content?: unknown }).content;
  if (content === undefined || content === null) return '';
  if (typeof content !== 'string') {
    throw new ProviderError('malformed response: content is not a string');
  }
  return content;
}

const KIMI_DEFAULT_ENDPOINT = 'https://api.moonshot.ai/v1';
const KIMI_DEFAULT_MODEL = 'kimi-k2-0711-preview';

export function createKimiProvider(config: HttpProviderConfig = {}): Provider {
  const endpoint = config.endpoint ?? KIMI_DEFAULT_ENDPOINT;
  const model = config.model ?? KIMI_DEFAULT_MODEL;
  const url = joinUrl(endpoint, '/chat/completions');
  const readRaw = rawConfigReader(config);
  const base = {
    fetchImpl: config.fetchImpl ?? (fetch as FetchLike),
    sleep: config.sleep ?? realSleep,
    random: config.random ?? Math.random,
    now: config.now ?? Date.now,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };

  async function hooks(): Promise<Hooks> {
    const key = config.getKey ? await config.getKey() : await resolveDefaultKey();
    if (!key || key.trim() === '') {
      throw new ProviderError('no API key configured; set one with PUT /api/config or data/secrets.json');
    }
    return { ...base, key };
  }

  function payload(
    messages: ChatMessage[],
    streaming: boolean,
    opts: CallOptions | undefined,
    raw: Record<string, unknown> | null,
  ) {
    const retention = cacheRetentionFrom(raw);
    return {
      model: modelForCall(raw, messages, model),
      messages: toWireMessages(messages),
      stream: streaming,
      ...(retention !== undefined ? { cacheRetention: retention } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
  }

  return {
    async complete(messages, opts) {
      const h = await hooks();
      const res = await postJson(h, url, payload(messages, false, opts, await readRaw()), opts?.signal);
      if (res.body === null) throw new ProviderError('malformed response: missing body');
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new ProviderError(`malformed response: ${truncate(scrub(res.body, [h.key]), ERROR_BODY_MAX)}`);
      }
      return extractChoiceContent(parsed, false);
    },

    async stream(messages, onDelta, opts) {
      const h = await hooks();
      const res = await postJson(h, url, payload(messages, true, opts, await readRaw()), opts?.signal);
      if (!res.stream) throw new ProviderError('malformed response: missing stream');
      let full = '';
      try {
        await readSseData(res.stream, (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new ProviderError(`malformed stream chunk: ${truncate(scrub(data, [h.key]), ERROR_BODY_MAX)}`);
          }
          const delta = extractChoiceContent(parsed, true);
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        }, { signal: opts?.signal, idleTimeoutMs: h.streamIdleTimeoutMs });
      } finally {
        res.releaseStream?.();
      }
      return full;
    },
  };
}

const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';
// Ollama defaults num_ctx to 2048; role prompts alone can exceed that, which
// truncates tool JSON mid-object. 8192 gives every role room; override with
// the ollamaNumCtx raw config key.
const OLLAMA_DEFAULT_NUM_CTX = 8192;

function numCtxFrom(raw: Record<string, unknown> | null): number {
  const v = raw?.['ollamaNumCtx'];
  return typeof v === 'number' && Number.isFinite(v) && v >= 512 ? Math.floor(v) : OLLAMA_DEFAULT_NUM_CTX;
}

// Every request re-pins the model in memory so a pipeline never pays a cold
// reload between roles. Override with the ollamaKeepAlive config key
// (duration string like "30m", or -1 to keep loaded indefinitely).
const OLLAMA_DEFAULT_KEEP_ALIVE = '24h';

function keepAliveFrom(raw: Record<string, unknown> | null): string {
  const v = raw?.['ollamaKeepAlive'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : OLLAMA_DEFAULT_KEEP_ALIVE;
}

export function createOllamaProvider(config: HttpProviderConfig = {}): Provider {
  const endpoint = config.endpoint ?? OLLAMA_DEFAULT_ENDPOINT;
  const model = config.model ?? OLLAMA_DEFAULT_MODEL;
  const url = joinUrl(endpoint, '/api/chat');
  const readRaw = rawConfigReader(config);
  const base: Hooks = {
    fetchImpl: config.fetchImpl ?? (fetch as FetchLike),
    sleep: config.sleep ?? realSleep,
    random: config.random ?? Math.random,
    now: config.now ?? Date.now,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // Local models can pause for tens of seconds mid-stream on CPU (prefill,
    // KV pressure); give the body generous idle headroom. The total timeout
    // still bounds time-to-headers, which is all a stalled server can hang.
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 120_000,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    key: null,
  };

  function payload(
    messages: ChatMessage[],
    streaming: boolean,
    opts: CallOptions | undefined,
    raw: Record<string, unknown> | null,
  ) {
    const options: Record<string, number> = { num_ctx: numCtxFrom(raw) };
    if (opts?.temperature !== undefined) options.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) options.num_predict = opts.maxTokens;
    const resolvedModel = modelForCall(raw, messages, model);
    return {
      model: resolvedModel,
      messages: toWireMessages(messages),
      stream: streaming,
      keep_alive: keepAliveFrom(raw),
      // qwen3 models think by default; thinking tokens tank role latency.
      ...(resolvedModel.startsWith('qwen3') ? { think: false } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  return {
    async complete(messages, opts) {
      const res = await postJson(base, url, payload(messages, false, opts, await readRaw()), opts?.signal);
      if (res.body === null) throw new ProviderError('malformed response: missing body');
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new ProviderError(`malformed response: ${truncate(res.body, ERROR_BODY_MAX)}`);
      }
      const err = (parsed as { error?: unknown } | null)?.error;
      if (typeof err === 'string' && err !== '') {
        throw new ProviderError(`ollama error: ${truncate(err, ERROR_BODY_MAX)}`);
      }
      const message = (parsed as { message?: unknown } | null)?.message;
      const content = message && typeof message === 'object'
        ? (message as { content?: unknown }).content
        : undefined;
      if (typeof content !== 'string') {
        throw new ProviderError(`malformed response: ${truncate(res.body, ERROR_BODY_MAX)}`);
      }
      return content;
    },

    async stream(messages, onDelta, opts) {
      const res = await postJson(base, url, payload(messages, true, opts, await readRaw()), opts?.signal);
      if (!res.stream) throw new ProviderError('malformed response: missing stream');
      let full = '';
      let sawDone = false;
      try {
        await parseSseLines(res.stream, (line) => {
          if (line.trim() === '') return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new ProviderError(`malformed stream chunk: ${truncate(line, ERROR_BODY_MAX)}`);
          }
          const err = (parsed as { error?: unknown } | null)?.error;
          if (typeof err === 'string' && err !== '') {
            throw new ProviderError(`ollama error: ${truncate(err, ERROR_BODY_MAX)}`);
          }
          if ((parsed as { done?: unknown } | null)?.done === true) sawDone = true;
          const message = (parsed as { message?: unknown } | null)?.message;
          const delta = message && typeof message === 'object'
            ? (message as { content?: unknown }).content
            : undefined;
          if (typeof delta === 'string' && delta !== '') {
            full += delta;
            onDelta(delta);
          }
        }, { signal: opts?.signal, idleTimeoutMs: base.streamIdleTimeoutMs });
      } finally {
        res.releaseStream?.();
      }
      // Same contract as the chat-completions sentinel: a FIN without
      // done:true means the connection dropped mid-generation.
      if (!sawDone) throw new ProviderError('stream ended before the completion marker');
      return full;
    },
  };
}

const MOCK_STYLES = `/* Aurora Coffee - design system.
   Dark metallic surfaces, glass, aurora gradient accents, fluid type. */

:root {
  --color-bg: #07090d;
  --color-bg-soft: #0b0e14;
  --color-surface: #10141d;
  --color-surface-2: #161c27;
  --color-surface-3: #1d2432;
  --color-line: #263043;
  --color-line-bright: #3a4763;
  --color-text: #eef2f9;
  --color-muted: #a6b0c2;
  --color-faint: #8b95a9;
  --color-accent: #e0a458;
  --color-accent-strong: #f0c080;
  --color-on-accent: #0a0d13;
  --color-aurora-1: #5eead4;
  --color-aurora-2: #7dd3fc;
  --color-aurora-3: #c4b5fd;
  --gradient-aurora: linear-gradient(120deg, #5eead4 0%, #7dd3fc 48%, #c4b5fd 100%);
  --gradient-copper: linear-gradient(135deg, #f0c080 0%, #e0a458 45%, #b07428 100%);
  --gradient-metal: linear-gradient(180deg, #181f2c 0%, #10141d 100%);
  --glass-bg: rgba(11, 14, 20, 0.66);
  --glass-line: rgba(255, 255, 255, 0.08);
  --font-body: "Avenir Next", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-display: "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --step--1: clamp(0.83rem, 0.8rem + 0.15vw, 0.94rem);
  --step-0: clamp(1rem, 0.96rem + 0.2vw, 1.13rem);
  --step-1: clamp(1.2rem, 1.12rem + 0.4vw, 1.5rem);
  --step-2: clamp(1.44rem, 1.28rem + 0.8vw, 2rem);
  --step-3: clamp(1.73rem, 1.46rem + 1.35vw, 2.7rem);
  --step-4: clamp(2.07rem, 1.64rem + 2.15vw, 3.6rem);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --space-5: 2.5rem;
  --space-6: 4rem;
  --radius-s: 8px;
  --radius-m: 14px;
  --radius-l: 22px;
  --radius-pill: 999px;
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.45), 0 10px 30px rgba(0, 0, 0, 0.35);
  --shadow-glow: 0 0 0 1px rgba(224, 164, 88, 0.4), 0 14px 44px rgba(224, 164, 88, 0.16);
  --ring: #7dd3fc;
  --container: 72rem;
  --nav-h: 4.25rem;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--step-0);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

svg { display: block; }

h1, h2, h3 {
  font-family: var(--font-display);
  line-height: 1.12;
  letter-spacing: -0.02em;
  margin: 0 0 var(--space-3);
}

p { margin: 0 0 var(--space-3); }

a { color: var(--color-aurora-2); text-decoration: none; }
a:hover { color: var(--color-aurora-1); }

:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 3px;
  border-radius: var(--radius-s);
}

::selection { background: rgba(125, 211, 252, 0.28); }

.container {
  width: min(100% - 2 * var(--space-4), var(--container));
  margin-inline: auto;
}

section[id] { scroll-margin-top: calc(var(--nav-h) + var(--space-3)); }

.skip-link {
  position: absolute;
  left: var(--space-3);
  top: -3rem;
  z-index: 100;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-3);
  color: var(--color-text);
  border-radius: var(--radius-s);
  transition: top 0.2s ease;
}
.skip-link:focus { top: var(--space-3); }

.eyebrow {
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--step--1);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-accent);
}

.section { padding: var(--space-6) 0; }
.section-title { font-size: var(--step-3); max-width: 20ch; }
.section-sub { color: var(--color-muted); max-width: 56ch; }

/* Buttons */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0.85rem 1.6rem;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.btn:hover { transform: translateY(-2px); }
.btn:active { transform: translateY(0); }

.btn-primary {
  background: var(--gradient-copper);
  color: var(--color-on-accent);
  box-shadow: 0 8px 26px rgba(224, 164, 88, 0.28);
}
.btn-primary:hover {
  color: var(--color-on-accent);
  box-shadow: 0 12px 34px rgba(224, 164, 88, 0.42);
}

.btn-ghost {
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--color-line-bright);
  color: var(--color-text);
}
.btn-ghost:hover { border-color: var(--color-aurora-2); color: var(--color-text); }

/* Sticky glass navigation */

.nav {
  position: sticky;
  top: 0;
  z-index: 60;
  background: var(--glass-bg);
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
  border-bottom: 1px solid var(--glass-line);
}
.nav-inner {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--nav-h);
}
.brand {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--color-text);
}
.brand:hover { color: var(--color-text); }
.brand-dot { color: var(--color-accent); }

.nav-links {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}
.nav-link {
  color: var(--color-muted);
  font-size: var(--step--1);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.nav-link:hover { color: var(--color-text); }
.nav-cta { padding: 0.55rem 1.1rem; font-size: var(--step--1); }

.nav-toggle {
  display: none;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  border: 1px solid var(--color-line-bright);
  border-radius: var(--radius-s);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.nav-toggle .bar {
  width: 1.25rem;
  height: 2px;
  background: var(--color-text);
  border-radius: 2px;
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.nav-toggle[aria-expanded="true"] .bar:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.nav-toggle[aria-expanded="true"] .bar:nth-child(2) { opacity: 0; }
.nav-toggle[aria-expanded="true"] .bar:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

@media (max-width: 52em) {
  /* Without JS the toggle never appears and the links stay fully visible. */
  html.js .nav-toggle { display: inline-flex; }
  html.js .nav-links {
    position: absolute;
    top: var(--nav-h);
    left: calc(-1 * var(--space-4));
    right: calc(-1 * var(--space-4));
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: var(--space-2) var(--space-4) var(--space-4);
    background: var(--glass-bg);
    backdrop-filter: blur(18px) saturate(1.3);
    -webkit-backdrop-filter: blur(18px) saturate(1.3);
    border-bottom: 1px solid var(--glass-line);
    visibility: hidden;
    opacity: 0;
    transform: translateY(-8px);
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
  }
  html.js .nav-links.open { visibility: visible; opacity: 1; transform: translateY(0); }
  .nav-links li { width: 100%; }
  html.js .nav-link { display: block; padding: var(--space-3) var(--space-2); font-size: var(--step-0); }
  html.js .nav-cta { margin-top: var(--space-2); text-align: center; }
}

/* Hero */

.hero {
  position: relative;
  overflow: hidden;
  padding: calc(var(--space-6) + var(--space-4)) 0 var(--space-6);
  text-align: center;
  background: radial-gradient(120% 90% at 50% 0%, var(--color-bg-soft) 0%, var(--color-bg) 72%);
}
.aurora {
  position: absolute;
  inset: -20% -10% auto;
  height: 130%;
  background:
    radial-gradient(38% 42% at 22% 30%, rgba(94, 234, 212, 0.16) 0%, transparent 70%),
    radial-gradient(34% 40% at 55% 12%, rgba(125, 211, 252, 0.14) 0%, transparent 70%),
    radial-gradient(40% 46% at 82% 32%, rgba(196, 181, 253, 0.13) 0%, transparent 70%);
  filter: blur(30px);
  pointer-events: none;
}
.orb-wrap {
  position: absolute;
  top: 6%;
  left: 50%;
  margin-left: -11rem;
  pointer-events: none;
  transition: transform 0.25s ease-out;
}
.orb {
  width: 22rem;
  height: 22rem;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, rgba(240, 192, 128, 0.3) 0%, rgba(224, 164, 88, 0.13) 42%, transparent 70%);
  filter: blur(48px);
}
.hero-inner { position: relative; max-width: 52rem; }
.hero-title { font-size: var(--step-4); margin-bottom: var(--space-4); }
.hero-sub {
  color: var(--color-muted);
  font-size: var(--step-1);
  max-width: 46ch;
  margin-inline: auto;
}
.hero-ctas {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  justify-content: center;
  margin-top: var(--space-5);
}
.hero-proof { margin-top: var(--space-4); color: var(--color-faint); font-size: var(--step--1); }

/* Logo marquee */

.marquee-section {
  padding: var(--space-5) 0 var(--space-4);
  border-block: 1px solid var(--color-line);
  background: var(--color-bg-soft);
}
.marquee-label {
  text-align: center;
  color: var(--color-faint);
  font-family: var(--font-mono);
  font-size: var(--step--1);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  margin-bottom: var(--space-4);
}
.marquee {
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
}
.marquee-track {
  display: flex;
  align-items: baseline;
  gap: 5rem;
  width: max-content;
  padding-right: 5rem;
}
.logo-span { color: var(--color-muted); font-size: var(--step-1); white-space: nowrap; }
.logo-serif { font-family: var(--font-serif); font-style: italic; }
.logo-mono { font-family: var(--font-mono); letter-spacing: 0.12em; }
.logo-wide { letter-spacing: 0.34em; text-transform: uppercase; font-size: var(--step-0); }
.logo-bold { font-weight: 800; }

/* Feature grid */

.features-grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: 1fr;
  margin-top: var(--space-5);
}
@media (min-width: 40em) { .features-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 62em) { .features-grid { grid-template-columns: repeat(3, 1fr); } }

.card {
  background: var(--gradient-metal);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-l);
  padding: var(--space-4);
  box-shadow: var(--shadow-1);
  transition: transform 0.22s ease, border-color 0.22s ease;
}
.card:hover { transform: translateY(-4px); border-color: var(--color-line-bright); }
.feature .icon { width: 2rem; height: 2rem; color: var(--color-accent); margin-bottom: var(--space-3); }
.feature h3 { font-size: var(--step-1); margin-bottom: var(--space-2); }
.feature p { color: var(--color-muted); margin: 0; font-size: var(--step--1); }

/* Stats band */

.stats { border-block: 1px solid var(--color-line); background: var(--gradient-metal); }
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-4);
  padding: var(--space-5) 0;
  text-align: center;
}
@media (min-width: 52em) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
.stat-value {
  display: block;
  font-family: var(--font-display);
  font-size: var(--step-3);
  font-weight: 700;
  background: var(--gradient-copper);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
@supports not (background-clip: text) {
  .stat-value { background: none; color: var(--color-accent); }
}
.stat-label {
  color: var(--color-muted);
  font-size: var(--step--1);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Showcase split */

.showcase { display: grid; gap: var(--space-5); align-items: center; }
@media (min-width: 56em) { .showcase { grid-template-columns: 1.05fr 0.95fr; } }
.check-list {
  list-style: none;
  margin: var(--space-4) 0 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}
.check-list li { position: relative; padding-left: 2.1rem; color: var(--color-muted); }
.check-list li::before {
  content: "\\2713";
  position: absolute;
  left: 0;
  top: 0.1em;
  width: 1.35rem;
  height: 1.35rem;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(224, 164, 88, 0.14);
  border: 1px solid rgba(224, 164, 88, 0.45);
  color: var(--color-accent-strong);
  font-size: 0.8rem;
  font-weight: 700;
}
.showcase-visual { display: grid; place-items: center; }
.bag {
  width: min(20rem, 82%);
  aspect-ratio: 3 / 4;
  border-radius: var(--radius-m);
  background: var(--gradient-metal);
  border: 1px solid var(--color-line-bright);
  box-shadow: var(--shadow-1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-4);
  position: relative;
  overflow: hidden;
  transform: rotate(-2deg);
}
.bag::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 13%;
  background: var(--color-surface-3);
  border-bottom: 1px solid var(--color-line);
}
.bag-band {
  margin-top: 36%;
  width: 100%;
  padding: var(--space-3) var(--space-2);
  background: var(--gradient-copper);
  color: var(--color-on-accent);
  text-align: center;
  font-family: var(--font-display);
  font-weight: 800;
  letter-spacing: 0.3em;
  font-size: var(--step-1);
}
.bag-label {
  margin-top: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--step--1);
  letter-spacing: 0.14em;
  color: var(--color-muted);
  text-transform: uppercase;
}
.bag-note { margin-top: auto; margin-bottom: 0; font-size: var(--step--1); color: var(--color-faint); }

/* Testimonials */

.quotes { display: grid; gap: var(--space-4); margin-top: var(--space-5); }
@media (min-width: 52em) { .quotes { grid-template-columns: 1fr 1fr; } }
.quote {
  margin: 0;
  padding: var(--space-4);
  background: var(--gradient-metal);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-1);
}
.quote p { font-family: var(--font-serif); font-size: var(--step-1); line-height: 1.5; }
.quote footer { font-size: var(--step--1); }
.quote cite { font-style: normal; color: var(--color-text); font-weight: 600; display: block; }
.quote-role { color: var(--color-faint); }

/* Pricing */

.plans { display: grid; gap: var(--space-4); margin-top: var(--space-5); }
@media (min-width: 52em) { .plans { grid-template-columns: repeat(3, 1fr); } }
.plan {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: var(--space-4);
  background: var(--gradient-metal);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-1);
}
.plan-featured { border-color: var(--color-accent); box-shadow: var(--shadow-glow); }
@media (min-width: 52em) { .plan-featured { transform: translateY(-0.75rem); } }
.plan-badge {
  position: absolute;
  top: -0.85rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.2rem 0.9rem;
  border-radius: var(--radius-pill);
  background: var(--gradient-copper);
  color: var(--color-on-accent);
  font-size: var(--step--1);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.plan-name { font-size: var(--step-1); margin-bottom: var(--space-2); }
.plan-price { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-3); }
.plan-price .amount { font-family: var(--font-display); font-size: var(--step-3); font-weight: 700; }
.plan-price .per { color: var(--color-faint); font-size: var(--step--1); }
.plan-list {
  list-style: none;
  margin: 0 0 var(--space-4);
  padding: var(--space-3) 0 0;
  border-top: 1px solid var(--color-line);
  display: grid;
  gap: var(--space-2);
  color: var(--color-muted);
  font-size: var(--step--1);
}
.plan-list li { position: relative; padding-left: 1.4rem; }
.plan-list li::before { content: "-"; position: absolute; left: 0.2rem; color: var(--color-accent); }
.plan .btn { margin-top: auto; }

/* FAQ */

.narrow { max-width: 46rem; }
.faq-item {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-m);
  background: var(--gradient-metal);
  margin-bottom: var(--space-3);
  overflow: hidden;
}
.faq-item summary {
  cursor: pointer;
  list-style: none;
  padding: var(--space-3) var(--space-4);
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
}
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after {
  content: "+";
  font-family: var(--font-mono);
  font-size: var(--step-1);
  color: var(--color-accent);
  transition: transform 0.2s ease;
}
.faq-item[open] summary::after { transform: rotate(45deg); }
.faq-body { padding: 0 var(--space-4) var(--space-3); color: var(--color-muted); }
.faq-body p { margin: 0; }

/* CTA band */

.cta-band {
  padding: var(--space-6) 0;
  text-align: center;
  background:
    radial-gradient(60% 90% at 50% 110%, rgba(224, 164, 88, 0.12) 0%, transparent 70%),
    var(--color-bg-soft);
  border-top: 1px solid var(--color-line);
}
.cta-band h2 { font-size: var(--step-3); }
.cta-band p { color: var(--color-muted); max-width: 46ch; margin-inline: auto; }
.cta-band .btn { margin-top: var(--space-3); }
.cta-fine { margin-top: var(--space-3); font-size: var(--step--1); color: var(--color-faint); }

/* Footer */

.footer { border-top: 1px solid var(--color-line); padding: var(--space-5) 0 var(--space-4); }
.footer-grid { display: grid; gap: var(--space-4); }
@media (min-width: 52em) { .footer-grid { grid-template-columns: 1.4fr 1fr 1fr; } }
.footer p, .footer li { color: var(--color-muted); font-size: var(--step--1); }
.footer h4 { margin: 0 0 var(--space-3); font-size: var(--step-0); font-family: var(--font-display); }
.footer ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.footer a { color: var(--color-muted); }
.footer a:hover { color: var(--color-text); }
.footer-meta { color: var(--color-faint); }
.footer-bottom {
  margin-top: var(--space-5);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  justify-content: space-between;
}
.footer-bottom p { margin: 0; color: var(--color-faint); font-size: var(--step--1); }
`;

const MOCK_ANIMATIONS = `/* Aurora Coffee - motion system.
   Keyframes and reveal transitions; every effect has a reduced-motion off ramp. */

html { scroll-behavior: smooth; }

@keyframes aurora-drift {
  0% { transform: translate3d(-3%, -2%, 0) scale(1); }
  50% { transform: translate3d(3%, 4%, 0) scale(1.14); }
  100% { transform: translate3d(-3%, -2%, 0) scale(1); }
}

@keyframes gradient-pan {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

@keyframes marquee-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

@keyframes orb-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(7%, -9%) scale(1.08); }
  66% { transform: translate(-6%, 7%) scale(0.94); }
}

@keyframes stat-pop {
  0% { transform: scale(1); text-shadow: none; }
  45% { transform: scale(1.14); text-shadow: 0 0 26px rgba(240, 192, 128, 0.65); }
  100% { transform: scale(1); text-shadow: none; }
}

.aurora { animation: aurora-drift 26s ease-in-out infinite; will-change: transform; }

.orb { animation: orb-float 14s ease-in-out infinite; will-change: transform; }

.gradient-text {
  background-image: var(--gradient-aurora);
  background-size: 220% 220%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: gradient-pan 9s ease-in-out infinite;
}
@supports not (background-clip: text) {
  .gradient-text { background-image: none; color: var(--color-aurora-2); animation: none; }
}

.marquee-track { animation: marquee-scroll 34s linear infinite; will-change: transform; }

/* Reveal on scroll - gated behind html.js so a no-JS visit shows everything. */
html.js .reveal {
  opacity: 0;
  transform: translateY(26px);
  transition: opacity 0.7s ease, transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
}
html.js .reveal.is-visible { opacity: 1; transform: translateY(0); }

.stat-value.counted { animation: stat-pop 0.55s ease-out; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .aurora, .orb, .marquee-track, .gradient-text { animation: none; }
  html.js .reveal { opacity: 1; transform: none; }
}
`;

const MOCK_INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aurora Coffee - small-batch coffee, roasted 48 hours before it ships</title>
  <meta name="description" content="Aurora Coffee is a small-batch subscription from Bergen: single-origin bags roasted 48 hours before they ship, matched to your brewer. Pause or skip anytime.">
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="animations.css">
  <script src="app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>

  <header class="nav">
    <div class="container nav-inner">
      <a class="brand" href="#top" aria-label="Aurora Coffee - back to top">AURORA<span class="brand-dot">.</span></a>
      <button class="nav-toggle" id="navToggle" type="button" aria-expanded="false" aria-controls="navLinks">
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </button>
      <ul class="nav-links" id="navLinks">
        <li><a class="nav-link" href="#features">Features</a></li>
        <li><a class="nav-link" href="#showcase">The box</a></li>
        <li><a class="nav-link" href="#pricing">Plans</a></li>
        <li><a class="nav-link" href="#faq">FAQ</a></li>
        <li><a class="btn btn-primary nav-cta" href="#pricing">Start tasting</a></li>
      </ul>
    </div>
  </header>

  <main id="main">
    <section class="hero" id="top">
      <div class="aurora" aria-hidden="true"></div>
      <div class="orb-wrap" aria-hidden="true"><div class="orb"></div></div>
      <div class="container hero-inner">
        <p class="eyebrow">Small-batch subscription - roasted in Bergen</p>
        <h1 class="hero-title">Coffee that tastes the way the <span class="gradient-text">northern lights</span> look.</h1>
        <p class="hero-sub">Two single-origin bags a month, roasted 48 hours before they ship and ground to match your brewer. No stale shelves, no filler blends - just the harvest, at its peak.</p>
        <div class="hero-ctas">
          <a class="btn btn-primary" href="#pricing">See the plans</a>
          <a class="btn btn-ghost" href="#showcase">What is in the box</a>
        </div>
        <p class="hero-proof">First box ships on the next roast day - pause or cancel whenever you like.</p>
      </div>
    </section>

    <section class="marquee-section" aria-label="Where Aurora is poured">
      <p class="marquee-label">Poured daily by independent bars and roasters</p>
      <div class="marquee" id="marquee">
        <div class="marquee-track" id="marqueeTrack">
          <span class="logo-span logo-serif">Kaffa Roasters</span>
          <span class="logo-span logo-wide">Nordcup</span>
          <span class="logo-span logo-mono">bean &amp; birch</span>
          <span class="logo-span logo-bold">ALTA ROASTING CO.</span>
          <span class="logo-span logo-serif">Ferrosta</span>
          <span class="logo-span logo-wide">Copper Fox</span>
          <span class="logo-span logo-serif" aria-hidden="true">Kaffa Roasters</span>
          <span class="logo-span logo-wide" aria-hidden="true">Nordcup</span>
          <span class="logo-span logo-mono" aria-hidden="true">bean &amp; birch</span>
          <span class="logo-span logo-bold" aria-hidden="true">ALTA ROASTING CO.</span>
          <span class="logo-span logo-serif" aria-hidden="true">Ferrosta</span>
          <span class="logo-span logo-wide" aria-hidden="true">Copper Fox</span>
        </div>
      </div>
    </section>

    <section class="section" id="features">
      <div class="container">
        <p class="eyebrow">Why it tastes different</p>
        <h2 class="section-title">Six reasons the cup is better</h2>
        <p class="section-sub">Every part of the subscription exists to shorten one distance: between the roaster and your cup.</p>
        <div class="features-grid">
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.1-6-10a6 6 0 1 1 12 0c0 4.9-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>
            <h3>Single-origin, every month</h3>
            <p>One farm, one harvest, one story per box - from Yirgacheffe to Huila, never a faceless blend.</p>
          </article>
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1.2 3-3.5 4.6-3.5 8a3.5 3.5 0 0 0 7 0c0-1.4-.8-2.4-.8-2.4s2.8 1.6 2.8 4.4a5.5 5.5 0 0 1-11 0C6.5 9.2 10.8 7.2 12 3z"/></svg>
            <h3>Roasted 48 hours before shipping</h3>
            <p>Roast day and ship day share the same week, always. The degassing happens in your kitchen, not on a shelf.</p>
          </article>
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 12l3.6-3.6"/></svg>
            <h3>Grind matched to your brewer</h3>
            <p>Tell us V60, AeroPress, espresso or French press once; every bag arrives dialed to that recipe.</p>
          </article>
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M10 9.5v5M14 9.5v5"/></svg>
            <h3>Pause or skip anytime</h3>
            <p>Travel, a full shelf, a tight month - skip from your phone in two taps. No fees, no phone calls.</p>
          </article>
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19C5 11 10 6 19 5c-1 9-6 14-14 14z"/><path d="M5 19c3.5-3.5 6.5-6.5 9.5-9.5"/></svg>
            <h3>Carbon-neutral delivery</h3>
            <p>Every route is offset, every box is FSC cardboard, and the bags recycle as LDPE-4.</p>
          </article>
          <article class="card feature reveal">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/></svg>
            <h3>Notes from the roasters</h3>
            <p>Altitude, varietal, process and a brew ratio on every card, written by the person who roasted your batch.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="stats" id="stats" aria-label="Aurora in numbers">
      <div class="container stats-grid">
        <div class="stat reveal">
          <span class="stat-value" data-target="12" data-suffix="k+">12k+</span>
          <span class="stat-label">active subscribers</span>
        </div>
        <div class="stat reveal">
          <span class="stat-value" data-target="38">38</span>
          <span class="stat-label">roasts shipped</span>
        </div>
        <div class="stat reveal">
          <span class="stat-value" data-target="96" data-suffix="%">96%</span>
          <span class="stat-label">boxes on time</span>
        </div>
        <div class="stat reveal">
          <span class="stat-value" data-target="4.9" data-decimals="1">4.9</span>
          <span class="stat-label">average rating</span>
        </div>
      </div>
    </section>

    <section class="section" id="showcase">
      <div class="container showcase">
        <div class="showcase-copy">
          <p class="eyebrow">The Aurora box</p>
          <h2 class="section-title">What lands on your doorstep</h2>
          <p>Roast day is the first Monday of the month. By Wednesday the box is moving; by the weekend you are brewing beans that were green days earlier.</p>
          <ul class="check-list">
            <li>Two 250 g bags of the month's single-origin, whole bean or ground.</li>
            <li>A roast card with altitude, varietal, process and the roaster's notes.</li>
            <li>A brew guide dialed to one method, with ratios that actually work.</li>
            <li>First claim on microlots before they reach the public list.</li>
          </ul>
        </div>
        <div class="showcase-visual reveal" aria-hidden="true">
          <div class="bag">
            <div class="bag-band">AURORA</div>
            <p class="bag-label">Ethiopia Guji - washed</p>
            <p class="bag-note">Apricot, bergamot, brown sugar - 250 g</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="stories">
      <div class="container">
        <p class="eyebrow">From the cups of subscribers</p>
        <h2 class="section-title">People keep the box coming</h2>
        <div class="quotes">
          <blockquote class="quote reveal">
            <p>"The 48-hour roast window is real - you smell it the second the bag opens. Our home bar has never been this consistent."</p>
            <footer><cite>Maya Lindqvist</cite><span class="quote-role">Head barista, Fjell Cafe, Bergen</span></footer>
          </blockquote>
          <blockquote class="quote reveal">
            <p>"I skip a month from my phone in two taps, and the grind always matches my V60. It is the only subscription I have kept for two years."</p>
            <footer><cite>Tomas Ferreira</cite><span class="quote-role">Product designer, Lisbon</span></footer>
          </blockquote>
        </div>
      </div>
    </section>

    <section class="section" id="pricing">
      <div class="container">
        <p class="eyebrow">Plans</p>
        <h2 class="section-title">Pick your pace</h2>
        <p class="section-sub">Every plan ships on the same roast day with the same 48-hour promise. Only the volume changes.</p>
        <div class="plans">
          <article class="plan reveal">
            <h3 class="plan-name">Taster</h3>
            <p class="plan-price"><span class="amount">$14</span><span class="per">/ month</span></p>
            <ul class="plan-list">
              <li>One 250 g bag each month</li>
              <li>Whole bean or ground for your brewer</li>
              <li>Roast card and brew guide</li>
              <li>Pause or skip anytime</li>
            </ul>
            <a class="btn btn-ghost" href="#cta">Choose Taster</a>
          </article>
          <article class="plan plan-featured reveal">
            <span class="plan-badge">Most popular</span>
            <h3 class="plan-name">Aurora</h3>
            <p class="plan-price"><span class="amount">$24</span><span class="per">/ month</span></p>
            <ul class="plan-list">
              <li>Two 250 g bags each month</li>
              <li>Free carbon-neutral shipping</li>
              <li>Early access to microlots</li>
              <li>Roast-card archive in your account</li>
            </ul>
            <a class="btn btn-primary" href="#cta">Choose Aurora</a>
          </article>
          <article class="plan reveal">
            <h3 class="plan-name">Reserve</h3>
            <p class="plan-price"><span class="amount">$42</span><span class="per">/ month</span></p>
            <ul class="plan-list">
              <li>Three bags, one a limited microlot</li>
              <li>Cupping kit in your first box</li>
              <li>Priority roaster Q&amp;A each month</li>
              <li>Gift a month to a friend, once a year</li>
            </ul>
            <a class="btn btn-ghost" href="#cta">Choose Reserve</a>
          </article>
        </div>
      </div>
    </section>

    <section class="section" id="faq">
      <div class="container narrow">
        <p class="eyebrow">Questions</p>
        <h2 class="section-title">Before you subscribe</h2>
        <details class="faq-item reveal">
          <summary>When does my box ship?</summary>
          <div class="faq-body"><p>We roast every first Monday of the month and ship within 48 hours. Tracking lands in your inbox the moment the courier scans the box.</p></div>
        </details>
        <details class="faq-item reveal">
          <summary>Can I pause, skip or cancel?</summary>
          <div class="faq-body"><p>Yes - from your account page, any time before the 25th of the month. No fees, no phone calls, no guilt trip.</p></div>
        </details>
        <details class="faq-item reveal">
          <summary>Whole bean or ground?</summary>
          <div class="faq-body"><p>Your call at checkout. If you choose ground, we match the grind to your brewer - V60, AeroPress, espresso or French press - and grind the morning we ship.</p></div>
        </details>
        <details class="faq-item reveal">
          <summary>Is the packaging recyclable?</summary>
          <div class="faq-body"><p>The bags are LDPE-4 recyclable, the box is FSC cardboard, and every delivery is offset to carbon-neutral.</p></div>
        </details>
      </div>
    </section>

    <section class="cta-band" id="cta">
      <div class="container">
        <p class="eyebrow">Ready when you are</p>
        <h2>The next roast day is close.</h2>
        <p>Pick a plan above and your first box joins the very next roast. Fresh is not a slogan here; it is the schedule.</p>
        <a class="btn btn-primary" href="#pricing">Choose your plan</a>
        <p class="cta-fine">Pause or cancel anytime - the coffee keeps no one hostage.</p>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container footer-grid">
      <div class="footer-brand">
        <a class="brand" href="#top">AURORA<span class="brand-dot">.</span></a>
        <p>Small-batch coffee subscription, roasted in Bergen and shipped within 48 hours of the roast.</p>
        <p class="footer-meta">Roastery: Skostredet 12, 5017 Bergen, Norway<br>Write to us: hello@auroracoffee.no</p>
      </div>
      <div class="footer-col">
        <h4>Explore</h4>
        <ul>
          <li><a href="#features">Features</a></li>
          <li><a href="#showcase">The box</a></li>
          <li><a href="#pricing">Plans</a></li>
          <li><a href="#faq">FAQ</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Plans</h4>
        <ul>
          <li><a href="#pricing">Taster - $14 / month</a></li>
          <li><a href="#pricing">Aurora - $24 / month</a></li>
          <li><a href="#pricing">Reserve - $42 / month</a></li>
        </ul>
      </div>
    </div>
    <div class="container footer-bottom">
      <p>&copy; 2025 Aurora Coffee AS. All rights reserved.</p>
      <p>A static site - no cookies, no trackers, no build step.</p>
    </div>
  </footer>
</body>
</html>
`;

// The reviewer's one finding is real: as first written, the nav toggle has no
// accessible name. The builder's fix pass rewrites index.html with the label
// added, so the shipped file is this derived variant.
const MOCK_INDEX_FIXED = MOCK_INDEX.replace(
  'type="button" aria-expanded="false" aria-controls="navLinks"',
  'type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="navLinks"',
);

// Follow-up edits must prove themselves: the edited variant adds a real
// FAQ entry (matching the blueprint's faq-item markup) so the file always
// differs from both MOCK_INDEX and MOCK_INDEX_FIXED on disk.
const MOCK_INDEX_EDITED = MOCK_INDEX_FIXED.replace(
  '</main>',
  [
    '        <details class="faq-item reveal">',
    '          <summary>Which delivery areas do you ship to?</summary>',
    '          <p>We currently roast and ship across Norway and the wider EU, with tracked delivery included on every plan.</p>',
    '        </details>',
    '  </main>',
  ].join('\n'),
);

const MOCK_APP = `/* Aurora Coffee - progressive enhancement. The page is fully usable without it. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /* Mobile navigation: toggle, close on link click or Escape, aria kept in sync. */
  function initNav() {
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    if (!toggle || !links) return;

    function setOpen(open) {
      links.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    links.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && links.classList.contains('open')) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* Scroll reveal: IntersectionObserver adds .is-visible, staggered per sibling group. */
  function initReveal() {
    var items = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (items.length === 0) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el) {
      var siblings = el.parentElement
        ? Array.prototype.filter.call(el.parentElement.children, function (c) {
          return c.classList && c.classList.contains('reveal');
        })
        : [el];
      var index = Math.max(0, siblings.indexOf(el));
      el.style.transitionDelay = Math.min(index, 5) * 90 + 'ms';
      observer.observe(el);
    });
  }

  /* Animated counters: count up once when the stats band scrolls into view. */
  function initCounters() {
    var values = Array.prototype.slice.call(document.querySelectorAll('.stat-value[data-target]'));
    if (values.length === 0) return;

    function parts(el) {
      return {
        target: parseFloat(el.getAttribute('data-target') || '0'),
        decimals: parseInt(el.getAttribute('data-decimals') || '0', 10),
        prefix: el.getAttribute('data-prefix') || '',
        suffix: el.getAttribute('data-suffix') || '',
      };
    }

    function renderFinal(el) {
      var p = parts(el);
      el.textContent = p.prefix + p.target.toFixed(p.decimals) + p.suffix;
    }

    if (reduceMotion || !('IntersectionObserver' in window)) {
      values.forEach(renderFinal);
      return;
    }

    function animate(el) {
      var p = parts(el);
      var duration = 1400;
      var start = null;
      function tick(now) {
        if (start === null) start = now;
        var t = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = p.prefix + (p.target * eased).toFixed(p.decimals) + p.suffix;
        if (t < 1) {
          window.requestAnimationFrame(tick);
        } else {
          renderFinal(el);
          el.classList.add('counted');
        }
      }
      window.requestAnimationFrame(tick);
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animate(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.4 });
    values.forEach(function (el) { observer.observe(el); });
  }

  /* Marquee: pause the loop on hover or keyboard focus. */
  function initMarquee() {
    var marquee = document.getElementById('marquee');
    var track = document.getElementById('marqueeTrack');
    if (!marquee || !track) return;
    function pause() { track.style.animationPlayState = 'paused'; }
    function resume() { track.style.animationPlayState = 'running'; }
    marquee.addEventListener('mouseenter', pause);
    marquee.addEventListener('mouseleave', resume);
    marquee.addEventListener('focusin', pause);
    marquee.addEventListener('focusout', resume);
  }

  /* Cursor-follow glow: the hero orb leans toward the pointer, rAF-throttled. */
  function initGlow() {
    if (reduceMotion || !finePointer) return;
    var hero = document.querySelector('.hero');
    var wrap = hero ? hero.querySelector('.orb-wrap') : null;
    if (!hero || !wrap) return;
    var frame = 0;
    hero.addEventListener('pointermove', function (event) {
      if (frame !== 0) return;
      var x = event.clientX;
      var y = event.clientY;
      frame = window.requestAnimationFrame(function () {
        frame = 0;
        var rect = hero.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        var dx = ((x - rect.left) / rect.width - 0.5) * 56;
        var dy = ((y - rect.top) / rect.height - 0.5) * 40;
        wrap.style.transform = 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px)';
      });
    });
  }

  /* Smooth in-page anchors, honoring reduced motion. */
  function initAnchors() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a[href^="#"]'));
    links.forEach(function (link) {
      link.addEventListener('click', function (event) {
        var href = link.getAttribute('href') || '';
        if (href.length < 2) return;
        var target = document.getElementById(href.slice(1));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
    });
  }

  /* FAQ: only one item open at a time. */
  function initFaq() {
    var items = Array.prototype.slice.call(document.querySelectorAll('details.faq-item'));
    items.forEach(function (item) {
      item.addEventListener('toggle', function () {
        if (!item.open) return;
        items.forEach(function (other) {
          if (other !== item) other.open = false;
        });
      });
    });
  }

  ready(function () {
    initNav();
    initReveal();
    initCounters();
    initMarquee();
    initGlow();
    initAnchors();
    initFaq();
  });
})();
`;

const MOCK_APP_FIXED = `// Error-fix pass: a guard around the counters so a malformed
// data-count value can no longer throw and stop the rest of app.js.
${MOCK_APP.replace('querySelectorAll', 'querySelectorAll /* guarded */')}`;

const MOCK_README = `# Aurora Coffee

A single-page marketing site for Aurora Coffee, a fictional small-batch coffee
subscription roasted in Bergen, Norway. It is the canned output of Foundry's
mock pipeline - the recipe the agent team is prompted to reproduce: dark
metallic surfaces, glass, aurora gradient accents and real motion, delivered
as dependency-free static files with no build step.

## Files

- index.html - markup and copy: sticky glass nav with hamburger, hero with
  gradient headline and glow orb, logo marquee, six-feature grid, stats band,
  showcase split, two testimonials, three-tier pricing, FAQ, CTA band, footer.
- styles.css - the design system: tokens, fluid type scale, layout, components.
- animations.css - the motion system: keyframes, reveal transitions and the
  prefers-reduced-motion off ramps.
- app.js - progressive enhancement: scroll-reveal stagger, animated counters,
  marquee pause-on-hover, cursor-follow glow, mobile nav, smooth anchors and
  single-open FAQ.

## Open it

Open index.html in any modern browser - everything runs from the file system.
Or serve the folder with any static file server:

    python3 -m http.server 8000

then visit http://localhost:8000.

## Notes

- Honors prefers-reduced-motion: the aurora, marquee, reveals and counters
  settle instantly when the user asks for less motion.
- Works with JavaScript disabled: content, FAQ and navigation stay usable.
- No cookies, no trackers, no external requests.
`;

function mockAskResponse(): string {
  return [
    'Two things to pin down before I lock the recipe.',
    JSON.stringify({
      tool: 'ask',
      args: {
        id: 'q1',
        question: 'What is the one thing this site must make happen?',
        options: [
          'Sell a subscription',
          'Book calls or demos',
          'Grow a waitlist',
          'Tell a brand story',
        ],
      },
    }),
    JSON.stringify({
      tool: 'ask',
      args: {
        id: 'q2',
        question: 'What should it feel like in the hand?',
        options: ['Dark, metallic, animated', 'Warm and editorial', 'Bright and playful', 'Sparse and technical'],
      },
    }),
  ].join('\n');
}

/** Pulls the user's brief back out of the planner system prompt. */
function briefFrom(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const match = /SITE BRIEF \(from the user\)\s*"""([\s\S]*?)"""/.exec(m.content)
      ?? /"""([\s\S]*?)"""/.exec(m.content);
    const raw = match?.[1];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return null;
}

function mockPlanResponse(messages: ChatMessage[]): string {
  const brief = briefFrom(messages);
  const summary = brief !== null
    ? `Aurora Coffee - a premium animated single-page subscription site: dark metallic surfaces, glass, real motion. Shaped by your brief: "${brief}".`
    : 'Aurora Coffee - a premium animated single-page subscription site: dark metallic surfaces, glass, real motion.';
  return [
    'Recipe locked: one page, five files, motion included. Here is the plan.',
    JSON.stringify({
      tool: 'plan',
      args: {
        summary,
        designNotes: 'Dark metallic palette (#0b0e14 base), glass surfaces with backdrop blur, aurora gradient accents (teal, sky, violet) over copper, fluid clamp typography, staggered reveal motion with full prefers-reduced-motion fallback.',
        steps: [
          { id: 's1', title: 'Design tokens', detail: 'styles.css: dark metallic token system, glass, gradient accents, fluid type, focus rings, responsive layout.', files: ['styles.css'] },
          { id: 's2', title: 'Motion system', detail: 'animations.css: aurora background, gradient text, marquee, reveal transitions, counter flash, reduced-motion overrides.', files: ['animations.css'] },
          { id: 's3', title: 'Markup and copy', detail: 'index.html: glass nav, hero, logo marquee, feature grid, stats, showcase, testimonials, pricing, FAQ, CTA, footer.', files: ['index.html'] },
          { id: 's4', title: 'Interactions', detail: 'app.js: reveal stagger, animated counters, marquee pause, cursor glow, mobile nav, smooth anchors, single-open FAQ.', files: ['app.js'] },
          { id: 's5', title: 'Documentation', detail: 'README.md: what the site is, the file map, and how to open it.', files: ['README.md'] },
          { id: 's6', title: 'Review and polish', detail: 'Reviewer audits hooks, contrast and motion fallbacks; the builder fixes what comes back.', files: [] },
        ],
      },
    }),
  ].join('\n');
}

function hasPlannerAnswers(messages: ChatMessage[]): boolean {
  let lastAsk = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.content.includes('"tool"') && m.content.includes('"ask"')) {
      lastAsk = i;
    }
  }
  if (lastAsk === -1) return false;
  return messages.slice(lastAsk + 1).some((m) => m.role === 'user' || m.role === 'tool');
}

/**
 * The builder runs three passes in a premium build: app.js with the main
 * contract, README.md in the remaining-files pass, and a rewrite of
 * index.html in the fix pass. It dispatches on the orchestrator's kickoff
 * line, falling back to the role prompt's section headers.
 */
function mockBuilderResponse(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const sys = [...messages].reverse().find((m) => m.role === 'system')?.content ?? '';
  if (lastUser.includes('Fix the review issues') || sys.includes('FIX PASS')) {
    return [
      'Rewrote index.html with an accessible name on the nav toggle.',
      JSON.stringify({ tool: 'writeFile', args: { path: 'index.html', content: MOCK_INDEX_FIXED } }),
    ].join('\n');
  }
  // Follow-up edits and error fixes must produce a CHANGED file (the
  // orchestrator measures the edit by file events).
  if (lastUser.includes('Apply this edit now') || sys.includes('TARGETED EDIT')) {
    return [
      'Applied the edit: a delivery-areas FAQ entry joins the list.',
      JSON.stringify({ tool: 'writeFile', args: { path: 'index.html', content: MOCK_INDEX_EDITED } }),
    ].join('\n');
  }
  if (lastUser.includes('Fix this site error now') || sys.includes('ERROR FIX')) {
    return [
      'Fixed the reported error in app.js.',
      JSON.stringify({ tool: 'writeFile', args: { path: 'app.js', content: MOCK_APP_FIXED } }),
    ].join('\n');
  }
  if (lastUser.includes('remaining planned files') || sys.includes('REMAINING FILES')) {
    return JSON.stringify({ tool: 'writeFile', args: { path: 'README.md', content: MOCK_README } });
  }
  return JSON.stringify({ tool: 'writeFile', args: { path: 'app.js', content: MOCK_APP } });
}

function mockResponseFor(messages: ChatMessage[]): string {
  const role = roleFromMessages(messages);
  switch (role) {
    case 'planner':
      return hasPlannerAnswers(messages) ? mockPlanResponse(messages) : mockAskResponse();
    case 'design':
      return [
        'Design system locked: metallic dark surfaces, glass, aurora gradients over copper.',
        JSON.stringify({ tool: 'writeFile', args: { path: 'styles.css', content: MOCK_STYLES } }),
        JSON.stringify({ tool: 'writeFile', args: { path: 'animations.css', content: MOCK_ANIMATIONS } }),
      ].join('\n');
    case 'copy':
      return [
        'Markup follows the blueprint section for section; every hook matches the design system.',
        JSON.stringify({ tool: 'writeFile', args: { path: 'index.html', content: MOCK_INDEX } }),
      ].join('\n');
    case 'builder':
      return mockBuilderResponse(messages);
    case 'reviewer':
      return [
        'Read all five files against the plan. Tokens, motion layers and DOM hooks line up; one accessibility fix goes back to the builder.',
        JSON.stringify({
          tool: 'reviewNotes',
          args: {
            issues: [
              {
                severity: 'warn',
                file: 'index.html',
                detail: 'The mobile nav toggle has no accessible name; add an aria-label so screen readers announce it.',
              },
            ],
          },
        }),
        JSON.stringify({
          tool: 'finish',
          args: { summary: 'Site reviewed: five files checked against the plan; one accessibility fix sent back to the builder.' },
        }),
      ].join('\n');
    default:
      return JSON.stringify({
        tool: 'finish',
        args: { summary: 'mock provider: no [role:planner|design|copy|builder|reviewer] marker in system prompt' },
      });
  }
}

/**
 * Deterministic scripted provider for tests and local dev. It reads the last
 * system message for a [role:...] marker and answers in the prompt-based tool
 * convention. The planner asks on its first pass and plans once answers are
 * present in the transcript. The canned build is the premium "Aurora Coffee"
 * recipe: the design role writes styles.css and animations.css, copy writes
 * index.html, the builder writes app.js then README.md in the remaining-files
 * pass, and the reviewer sends one real finding back so the fix pass ships a
 * corrected index.html.
 */
export function createMockProvider(): Provider {
  async function respond(messages: ChatMessage[]): Promise<string> {
    return mockResponseFor(messages);
  }
  return {
    complete: (messages) => respond(messages),
    async stream(messages, onDelta) {
      const text = await respond(messages);
      const mid = Math.ceil(text.length / 2);
      onDelta(text.slice(0, mid));
      onDelta(text.slice(mid));
      return text;
    },
  };
}
