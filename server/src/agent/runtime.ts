import { AbortError } from './provider.js';
import type { ChatMessage, Provider } from './provider.js';
import {
  executeFsTool,
  extractToolCalls,
  findWriteFilePayloads,
  isFsTool,
  isKnownTool,
  validateAskArgs,
  validateFinishArgs,
  validatePlanArgs,
  validateReviewNotesArgs,
} from './tools.js';
import type { Plan, Question, ReviewIssue, SiteStore } from './tools.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'writing'; path: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; result: string }
  | { type: 'question'; question: Question }
  | { type: 'plan'; plan: Plan }
  | { type: 'review'; issues: ReviewIssue[] }
  | { type: 'finish'; summary: string }
  | { type: 'note'; message: string }
  | { type: 'error'; message: string };

export type RunStatus =
  | 'finished'
  | 'awaiting-answer'
  | 'awaiting-approval'
  | 'no-tools'
  | 'max-iterations';

export interface RunResult {
  status: RunStatus;
  messages: ChatMessage[];
  response: string;
  questions: Question[];
  plan: Plan | null;
  issues: ReviewIssue[];
  summary: string | null;
}

export interface RuntimeDeps {
  provider: Provider;
  store: SiteStore;
}

export interface RunOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Transcript size budget in chars; older payloads are compacted past it. */
  maxTranscriptChars?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface Runtime {
  run(messages: ChatMessage[], opts?: RunOptions): Promise<RunResult>;
}

const DEFAULT_MAX_ITERATIONS = 12;
const REPEAT_LIMIT = 3;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 120_000;
// The live exchange at the tail (the assistant turn being acted on plus its
// tool results) is never compacted; neither are system or user messages.
const COMPACTION_TAIL = 2;

/**
 * Bounds transcript growth across a run. Assistant messages embed full
 * writeFile payloads (up to 256KB each) and are re-sent whole every turn, so
 * large builds blew the model context mid-build. Two passes, both limited to
 * messages older than the last COMPACTION_TAIL and never touching system or
 * user messages: (1) stub writeFile args.content in older assistant messages
 * in place, keeping the JSON shape; (2) if the transcript still exceeds
 * maxChars, tombstone the oldest assistant/tool payloads until it fits (best
 * effort; the protected tail itself may exceed the budget). Returns how many
 * payloads were stubbed and dropped.
 */
export function compactTranscript(
  messages: ChatMessage[],
  maxChars: number,
): { stubbed: number; dropped: number } {
  const tailStart = Math.max(0, messages.length - COMPACTION_TAIL);
  let stubbed = 0;
  for (let i = 0; i < tailStart; i += 1) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.content.includes('"tool"')) continue;
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const p of findWriteFilePayloads(m.content)) {
      const original = p.args.content;
      if (typeof original !== 'string' || original.startsWith('<written: ')) continue;
      const args = { ...p.args, content: `<written: ${p.path} (${p.chars} chars)>` };
      replacements.push({ start: p.start, end: p.end, text: JSON.stringify({ tool: 'writeFile', args }) });
    }
    if (replacements.length === 0) continue;
    let next = '';
    let cursor = 0;
    for (const r of replacements) {
      next += m.content.slice(cursor, r.start) + r.text;
      cursor = r.end;
    }
    m.content = next + m.content.slice(cursor);
    stubbed += replacements.length;
  }

  let total = 0;
  for (const m of messages) total += m.content.length;
  let dropped = 0;
  for (let i = 0; i < tailStart && total > maxChars; i += 1) {
    const m = messages[i]!;
    if (m.role !== 'assistant' && m.role !== 'tool') continue;
    const len = m.content.length;
    const tag = m.role === 'tool' ? (m.content.match(/^\[[^\]]{1,40}\]/)?.[0] ?? null) : null;
    const tombstone = tag !== null
      ? `<dropped: ${tag} result (${len} chars)>`
      : `<dropped: ${m.role} payload (${len} chars)>`;
    if (tombstone.length >= len) continue;
    m.content = tombstone;
    total -= len - tombstone.length;
    dropped += 1;
  }
  return { stubbed, dropped };
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AbortError());
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new AbortError()), { once: true });
    }),
  ]);
}

const TOOL_SKELETON = '{"tool"';
/** Chars the maybe-tool hold buffer may reach before it is flushed as prose. */
const MAYBE_CAP = 64;

/**
 * Incremental filter over streamed provider chunks: prose flows through as
 * live deltas, tool-call JSON (bare or ```json fenced) is suppressed — it
 * surfaces later as interpreted events, never as raw text. A `{` starts a
 * hold; while the held text could still become `{"tool"` it stays held, a
 * mismatch flushes it as prose, and a match (including chunks that overshoot
 * the prefix, e.g. `{"tool":"ask"` in one delta) suppresses the rest of the
 * response. A fence opener (``` plus optional language tag) is consumed
 * silently. writeFile paths inside the suppressed region are reported live
 * via onWriting so the UI can narrate "Writing styles.css" as it happens.
 */
export function createStreamFilter(
  onProse: (text: string) => void,
  onWriting: (path: string) => void,
): { feed: (chunk: string) => void; finish: () => void } {
  let mode: 'prose' | 'maybe' | 'tool' | 'fence' = 'prose';
  let held = '';
  let toolBuf = '';
  const announced = new Set<string>();

  function watchWriting(): void {
    const m = /"path"\s*:\s*"([^"]{1,200})"/.exec(toolBuf);
    if (m !== null && !announced.has(m[1]!)) {
      announced.add(m[1]!);
      onWriting(m[1]!);
    }
  }

  function feed(chunk: string): void {
    let s = chunk;
    while (s.length > 0) {
      if (mode === 'prose') {
        const brace = s.indexOf('{');
        const tick = s.indexOf('`');
        const cut = brace === -1 ? tick : tick === -1 ? brace : Math.min(brace, tick);
        if (cut === -1) {
          onProse(s);
          return;
        }
        if (cut > 0) onProse(s.slice(0, cut));
        held = s[cut]!;
        mode = s[cut] === '{' ? 'maybe' : 'fence';
        s = s.slice(cut + 1);
        continue;
      }
      if (mode === 'fence') {
        held += s;
        s = '';
        if (/^`{3,}[a-zA-Z0-9_-]*\r?\n/.test(held)) {
          // A real fence opener: swallow it, then scan on as prose.
          held = '';
          mode = 'prose';
        } else if (/^`{3,}[a-zA-Z0-9_-]*$/.test(held) || /^`{1,2}$/.test(held)) {
          // Still a candidate opener (or a lone backtick); keep holding.
        } else {
          onProse(held);
          held = '';
          mode = 'prose';
        }
        continue;
      }
      if (mode === 'maybe') {
        held += s;
        s = '';
        const skeleton = held.replace(/\s+/g, '');
        if (skeleton.startsWith(TOOL_SKELETON)) {
          mode = 'tool';
          toolBuf = held;
          watchWriting();
        } else if (TOOL_SKELETON.startsWith(skeleton)) {
          if (held.length > MAYBE_CAP) {
            // Pathological whitespace flood; give up and show it.
            onProse(held);
            held = '';
            mode = 'prose';
          }
          // else: still a candidate, keep holding.
        } else {
          onProse(held);
          held = '';
          mode = 'prose';
        }
        continue;
      }
      // tool mode: suppress; watch for writeFile paths.
      toolBuf += s;
      s = '';
      watchWriting();
    }
  }

  function finish(): void {
    if ((mode === 'maybe' || mode === 'fence') && held !== '') onProse(held);
    held = '';
  }

  return { feed, finish };
}

/**
 * The agent loop. Each iteration asks the provider for a response, appends it
 * to the transcript, extracts tool calls, executes filesystem tools against
 * the confined store, and appends results as tool-role messages. Control
 * tools (ask/plan) end the run with an awaiting status so the orchestrator
 * can collect user input and resume with the same transcript; finish ends it
 * for good. After each tool result is appended the transcript is compacted
 * (older writeFile payloads stubbed, total chars capped) so large builds do
 * not outgrow the model context. Aborts reject with an AbortError.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  async function run(messages: ChatMessage[], opts: RunOptions = {}): Promise<RunResult> {
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const maxTranscriptChars = opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
    const emit = (event: AgentEvent): void => {
      opts.onEvent?.(event);
    };
    const compact = (): void => {
      const { dropped } = compactTranscript(messages, maxTranscriptChars);
      if (dropped > 0) {
        emit({ type: 'note', message: `transcript exceeded ${maxTranscriptChars} chars; dropped ${dropped} older payload(s)` });
      }
    };
    compact();
    const callProvider = async (): Promise<string> => {
      const filter = createStreamFilter(
        (text) => emit({ type: 'delta', text }),
        (path) => emit({ type: 'writing', path }),
      );
      try {
        return await raceAbort(
          deps.provider.stream(messages, (delta) => filter.feed(delta), { signal: opts.signal }),
          opts.signal,
        );
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        emit({ type: 'error', message: err.message });
        throw err;
      } finally {
        filter.finish();
      }
    };

    const questions: Question[] = [];
    const issues: ReviewIssue[] = [];
    let plan: Plan | null = null;
    let summary: string | null = null;
    let iterations = 0;
    let response = '';
    const recent: string[] = [];

    for (;;) {
      if (opts.signal?.aborted) throw new AbortError();
      if (iterations >= maxIterations) {
        const message = `max iterations reached (${maxIterations})`;
        emit({ type: 'error', message });
        return { status: 'max-iterations', messages, response, questions, plan, issues, summary };
      }
      iterations += 1;

      response = await callProvider();
      if (response.trim() === '') {
        emit({ type: 'note', message: 'provider returned an empty response; retrying once' });
        response = await callProvider();
        if (response.trim() === '') {
          const err = new Error('provider returned an empty response twice');
          emit({ type: 'error', message: err.message });
          throw err;
        }
      }

      messages.push({ role: 'assistant', content: response });

      recent.push(response);
      if (recent.length > REPEAT_LIMIT) recent.shift();
      if (recent.length === REPEAT_LIMIT && recent[0] === recent[1] && recent[1] === recent[2]) {
        const err = new Error(`model repeated the same response ${REPEAT_LIMIT} times; stopping the run`);
        emit({ type: 'error', message: err.message });
        throw err;
      }

      const { calls, notes, text } = extractToolCalls(response);
      if (text) emit({ type: 'text', text });
      for (const note of notes) {
        messages.push({ role: 'tool', content: `note: ${note}` });
        emit({ type: 'note', message: note });
      }
      if (calls.length === 0) {
        return { status: 'no-tools', messages, response, questions, plan, issues, summary };
      }

      let finished = false;
      let wantStop: 'awaiting-answer' | 'awaiting-approval' | null = null;

      for (const call of calls) {
        const fail = (result: string): void => {
          messages.push({ role: 'tool', content: `[${call.name}] ${result}` });
          compact();
          emit({ type: 'tool', name: call.name, args: call.args, result });
        };
        if (!isKnownTool(call.name)) {
          fail(`error: unknown tool "${call.name}"`);
          continue;
        }
        if (isFsTool(call.name)) {
          const result = await executeFsTool(deps.store, call);
          messages.push({ role: 'tool', content: `[${call.name}] ${result}` });
          compact();
          emit({ type: 'tool', name: call.name, args: call.args, result });
          continue;
        }
        switch (call.name) {
          case 'ask': {
            const v = validateAskArgs(call.args);
            if (!v.ok) {
              fail(`error: ${v.error}`);
              break;
            }
            questions.push(v.value);
            emit({ type: 'question', question: v.value });
            wantStop = 'awaiting-answer';
            break;
          }
          case 'plan': {
            const v = validatePlanArgs(call.args);
            if (!v.ok) {
              fail(`error: ${v.error}`);
              break;
            }
            plan = v.value;
            emit({ type: 'plan', plan: v.value });
            if (wantStop !== 'awaiting-answer') wantStop = 'awaiting-approval';
            break;
          }
          case 'reviewNotes': {
            const v = validateReviewNotesArgs(call.args);
            if (!v.ok) {
              fail(`error: ${v.error}`);
              break;
            }
            issues.push(...v.value);
            emit({ type: 'review', issues: v.value });
            break;
          }
          case 'finish': {
            const v = validateFinishArgs(call.args);
            if (!v.ok) {
              fail(`error: ${v.error}`);
              break;
            }
            summary = v.value.summary !== '' ? v.value.summary : 'finished';
            emit({ type: 'finish', summary });
            finished = true;
            break;
          }
        }
      }

      if (finished) {
        return { status: 'finished', messages, response, questions, plan, issues, summary };
      }
      if (wantStop !== null) {
        return { status: wantStop, messages, response, questions, plan, issues, summary };
      }
    }
  }

  return { run };
}
