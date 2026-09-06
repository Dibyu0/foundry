import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/agent/orchestrator.js';
import { createMockProvider, type CallOptions, type ChatMessage, type Provider } from '../src/agent/provider.js';
import { SseHub, type SseEvent } from '../src/sse.js';

export interface CollectedEvent {
  id: string;
  event: SseEvent;
}

export interface World {
  dir: string;
  sitesRoot: string;
  dataDir: string;
  hub: SseHub;
  events: CollectedEvent[];
  orchestrator: Orchestrator;
}

/** Wraps the real hub's send to record every event while keeping replay/ring behavior. */
export function collectHub(hub: SseHub): CollectedEvent[] {
  const events: CollectedEvent[] = [];
  const original = hub.send.bind(hub);
  hub.send = (id: string, event: SseEvent): void => {
    events.push({ id, event });
    original(id, event);
  };
  return events;
}

export async function makeWorld(opts: { provider?: Provider; maxConcurrent?: number } = {}): Promise<World> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-orch-'));
  const sitesRoot = path.join(dir, 'sites');
  const dataDir = path.join(dir, 'data');
  const hub = new SseHub({ heartbeatMs: 600_000 });
  const events = collectHub(hub);
  const orchestrator = await Orchestrator.open({
    sitesRoot,
    dataDir,
    hub,
    getProvider: () => opts.provider ?? createMockProvider(),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
  });
  return { dir, sitesRoot, dataDir, hub, events, orchestrator };
}

export function eventsFor(events: CollectedEvent[], id: string): SseEvent[] {
  return events.filter((e) => e.id === id).map((e) => e.event);
}

export function eventTypes(events: CollectedEvent[], id: string): string[] {
  return eventsFor(events, id).map((e) => e.type);
}

export async function waitFor(pred: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* ------------------------------------------------------------------ */
/* Scripted providers: same role-marker convention as the real mock,  */
/* but each role's replies are under test control.                    */
/* ------------------------------------------------------------------ */

export interface ScriptCtx {
  role: string;
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
}

export type ScriptHandler = (ctx: ScriptCtx) => string | Promise<string>;

export function createScriptedProvider(handlers: Record<string, ScriptHandler>): Provider {
  const complete = async (messages: ChatMessage[], opts?: CallOptions): Promise<string> => {
    const sys = [...messages].reverse().find((m) => m.role === 'system');
    const role = /\[role:([a-z]+)\]/.exec(sys?.content ?? '')?.[1] ?? 'unknown';
    const handler = handlers[role];
    if (handler === undefined) {
      return JSON.stringify({ tool: 'finish', args: { summary: `scripted provider: no script for role ${role}` } });
    }
    return handler({ role, messages, signal: opts?.signal });
  };
  return {
    complete,
    stream: async (messages, onDelta, opts) => {
      const text = await complete(messages, opts);
      onDelta(text);
      return text;
    },
  };
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function toolJson(tool: string, args: unknown): string {
  return JSON.stringify({ tool, args });
}

export function askJson(question: string, options: string[] = ['Option A', 'Option B']): string {
  return toolJson('ask', { question, options });
}

export function planJson(files: string[] = ['styles.css', 'index.html', 'app.js']): string {
  return toolJson('plan', {
    summary: 'Scripted test plan',
    designNotes: 'Clean and testable',
    steps: files.map((f, i) => ({ id: `s${i + 1}`, title: `Write ${f}`, detail: `Produce ${f}`, files: [f] })),
  });
}

export function writeJson(filePath: string, content: string): string {
  return toolJson('writeFile', { path: filePath, content });
}

export const finishJson = toolJson('finish', { summary: 'done' });

export function reviewJson(issues: unknown[] = []): string {
  return toolJson('reviewNotes', { issues });
}

/** Tool results ride as 'tool' (runtime) or 'user' (orchestrator) messages. */
export function isResultMessage(m: ChatMessage): boolean {
  return m.role === 'tool' || m.role === 'user';
}

/** Writes the file on the first turn of the role loop, finishes on the next. */
export function writeThenFinish(filePath: string, content: string): ScriptHandler {
  return ({ messages }) => {
    const done = messages.some((m) => isResultMessage(m) && m.content.includes(`ok: wrote ${filePath}`));
    return done ? finishJson : writeJson(filePath, content);
  };
}

/** Never resolves until the caller's abort signal fires. */
export function hangUntilAbort(): ScriptHandler {
  return ({ signal }) =>
    new Promise<string>((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
}
