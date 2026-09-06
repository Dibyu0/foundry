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

export interface HttpProviderConfig {
  endpoint?: string;
  model?: string;
  getKey?: KeyReader;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 10_000;
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
  timeoutMs: number;
  maxRetries: number;
  key: string | null;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: string | null;
  stream: ReadableStream<Uint8Array> | null;
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

function retryDelayMs(h: Hooks, retryIndex: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      if (ms <= RETRY_AFTER_CAP_MS) return ms;
    }
  }
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** retryIndex, BACKOFF_CAP_MS);
  return exp + Math.floor(h.random() * JITTER_MS);
}

async function postJson(h: Hooks, url: string, payload: unknown, callerSignal?: AbortSignal): Promise<HttpResult> {
  if (callerSignal?.aborted) throw new AbortError();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (h.key) headers.authorization = `Bearer ${h.key}`;

  let lastError: Error | null = null;
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
    try {
      const res = await h.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        const isStream = res.body !== null && payload !== null && typeof payload === 'object'
          && (payload as { stream?: unknown }).stream === true;
        return {
          status: res.status,
          headers: res.headers,
          body: isStream ? null : await res.text(),
          stream: isStream ? res.body : null,
        };
      }
      const rawBody = res.body !== null
        ? await readBodyCapped(res.body, ERROR_BODY_MAX + 64)
        : await res.text().catch(() => '');
      const detail = truncate(scrub(rawBody, [h.key]), ERROR_BODY_MAX);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < h.maxRetries) {
        await h.sleep(retryDelayMs(h, attempt, res.headers.get('retry-after')));
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
      if (attempt < h.maxRetries) {
        await h.sleep(retryDelayMs(h, attempt, null));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
  throw lastError ?? new ProviderError('request failed');
}

/**
 * Incremental SSE line splitter: byte-chunk safe (StringDecoder) and tolerant
 * of a CRLF split across chunks. onLine receives each line without its
 * terminator; blank lines are delivered too (the caller ignores them).
 */
export async function parseSseLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
    buffer += decoder.end();
    if (buffer.length > 0) {
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
      onLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readSseData(
  stream: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
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
  });
  void sawDone;
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

interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  // Prompt-based tool convention: tool results ride as user messages. Most
  // OpenAI-compatible servers reject role:"tool" without a tool_call_id, and
  // local Ollama models handle user-role context more reliably.
  return messages.map((m) => ({
    role: m.role === 'tool' ? 'user' : m.role,
    content: m.content,
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
  const base = {
    fetchImpl: config.fetchImpl ?? (fetch as FetchLike),
    sleep: config.sleep ?? realSleep,
    random: config.random ?? Math.random,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };

  async function hooks(): Promise<Hooks> {
    const key = config.getKey ? await config.getKey() : await resolveDefaultKey();
    if (!key || key.trim() === '') {
      throw new ProviderError('no API key configured; set one with PUT /api/config or data/secrets.json');
    }
    return { ...base, key };
  }

  function payload(messages: ChatMessage[], streaming: boolean, opts?: CallOptions) {
    return {
      model,
      messages: toWireMessages(messages),
      stream: streaming,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
  }

  return {
    async complete(messages, opts) {
      const h = await hooks();
      const res = await postJson(h, url, payload(messages, false, opts), opts?.signal);
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
      const res = await postJson(h, url, payload(messages, true, opts), opts?.signal);
      if (!res.stream) throw new ProviderError('malformed response: missing stream');
      let full = '';
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
      });
      return full;
    },
  };
}

const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';

export function createOllamaProvider(config: HttpProviderConfig = {}): Provider {
  const endpoint = config.endpoint ?? OLLAMA_DEFAULT_ENDPOINT;
  const model = config.model ?? OLLAMA_DEFAULT_MODEL;
  const url = joinUrl(endpoint, '/api/chat');
  const base: Hooks = {
    fetchImpl: config.fetchImpl ?? (fetch as FetchLike),
    sleep: config.sleep ?? realSleep,
    random: config.random ?? Math.random,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    key: null,
  };

  function payload(messages: ChatMessage[], streaming: boolean, opts?: CallOptions) {
    const options: Record<string, number> = {};
    if (opts?.temperature !== undefined) options.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) options.num_predict = opts.maxTokens;
    return {
      model,
      messages: toWireMessages(messages),
      stream: streaming,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  return {
    async complete(messages, opts) {
      const res = await postJson(base, url, payload(messages, false, opts), opts?.signal);
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
      const res = await postJson(base, url, payload(messages, true, opts), opts?.signal);
      if (!res.stream) throw new ProviderError('malformed response: missing stream');
      let full = '';
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
        const message = (parsed as { message?: unknown } | null)?.message;
        const delta = message && typeof message === 'object'
          ? (message as { content?: unknown }).content
          : undefined;
        if (typeof delta === 'string' && delta !== '') {
          full += delta;
          onDelta(delta);
        }
      });
      return full;
    },
  };
}

const ROLE_MARKER = /\[role:(planner|design|copy|builder|reviewer)\]/;

const MOCK_STYLES = `:root {
  --color-bg: #0f1115;
  --color-surface: #171a21;
  --color-text: #e8eaf0;
  --color-muted: #9aa3b2;
  --color-accent: #5b8cff;
  --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 2rem;
  --radius: 10px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  line-height: 1.6;
}

.hero {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-3) var(--space-2);
  text-align: center;
}

.hero h1 { font-size: 2.5rem; margin-bottom: var(--space-1); }
.hero p { color: var(--color-muted); }

.button {
  display: inline-block;
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-2);
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 1rem;
}

.button:hover { filter: brightness(1.1); }
`;

const MOCK_INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Northwind Studio</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="hero">
    <h1>Northwind Studio</h1>
    <p>We design and build fast, honest websites for small teams.
       No templates, no bloat — just work that loads quickly and reads well.</p>
    <button class="button" id="cta" type="button">See what we make</button>
    <p id="cta-note" hidden>Thanks for stopping by — more case studies are on the way.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const MOCK_APP = `document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('cta');
  const note = document.getElementById('cta-note');
  if (!button || !note) return;
  button.addEventListener('click', () => {
    note.hidden = !note.hidden;
    button.textContent = note.hidden ? 'See what we make' : 'Hide the fine print';
  });
});
`;

const MOCK_README_NOTE = 'README.md is written by the build pipeline after the site files land.';

function mockAskResponse(): string {
  return [
    'Before I plan this build, I need two things pinned down.',
    JSON.stringify({
      tool: 'ask',
      args: {
        id: 'q1',
        question: 'Who is this site for, and what should it achieve?',
        options: [
          'A personal portfolio',
          'A small-business landing page',
          'A product or docs page',
          'An event page',
        ],
      },
    }),
    JSON.stringify({
      tool: 'ask',
      args: {
        id: 'q2',
        question: 'What visual style should it use?',
        options: ['Clean and minimal', 'Bold and colorful', 'Dark and technical', 'Playful'],
      },
    }),
  ].join('\n');
}

function mockPlanResponse(): string {
  return [
    'Here is the plan based on your answers.',
    JSON.stringify({
      tool: 'plan',
      args: {
        summary: 'Build a small static site with a hero page, design tokens, and light interactivity.',
        steps: [
          { id: 's1', title: 'Structure', detail: 'Author index.html with semantic markup and real copy.', files: ['index.html'] },
          { id: 's2', title: 'Design', detail: 'Define design tokens and base styles in styles.css.', files: ['styles.css'] },
          { id: 's3', title: 'Behavior', detail: 'Add progressive interactivity in app.js.', files: ['app.js'] },
          { id: 's4', title: 'Docs', detail: 'Document the site and how to serve it.', files: ['README.md'] },
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

function mockResponseFor(messages: ChatMessage[]): string {
  let role: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'system') {
      const match = ROLE_MARKER.exec(m.content);
      if (match) {
        role = match[1] ?? null;
        break;
      }
    }
  }
  switch (role) {
    case 'planner':
      return hasPlannerAnswers(messages) ? mockPlanResponse() : mockAskResponse();
    case 'design':
      return JSON.stringify({ tool: 'writeFile', args: { path: 'styles.css', content: MOCK_STYLES } });
    case 'copy':
      return JSON.stringify({ tool: 'writeFile', args: { path: 'index.html', content: MOCK_INDEX } });
    case 'builder':
      return JSON.stringify({ tool: 'writeFile', args: { path: 'app.js', content: MOCK_APP } });
    case 'reviewer':
      return [
        JSON.stringify({
          tool: 'reviewNotes',
          args: {
            issues: [
              {
                severity: 'warn',
                file: 'index.html',
                detail: 'The hero has no meta description; add one for search previews.',
              },
            ],
          },
        }),
        JSON.stringify({
          tool: 'finish',
          args: { summary: `Site reviewed: one minor issue noted. ${MOCK_README_NOTE}` },
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
 * present in the transcript; the reviewer emits notes and finish together.
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
