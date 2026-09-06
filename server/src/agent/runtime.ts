import { AbortError } from './provider.js';
import type { ChatMessage, Provider } from './provider.js';
import {
  executeFsTool,
  extractToolCalls,
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
  onEvent?: (event: AgentEvent) => void;
}

export interface Runtime {
  run(messages: ChatMessage[], opts?: RunOptions): Promise<RunResult>;
}

const DEFAULT_MAX_ITERATIONS = 12;
const REPEAT_LIMIT = 3;

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

/**
 * The agent loop. Each iteration asks the provider for a response, appends it
 * to the transcript, extracts tool calls, executes filesystem tools against
 * the confined store, and appends results as tool-role messages. Control
 * tools (ask/plan) end the run with an awaiting status so the orchestrator
 * can collect user input and resume with the same transcript; finish ends it
 * for good. Aborts reject with an AbortError.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  async function run(messages: ChatMessage[], opts: RunOptions = {}): Promise<RunResult> {
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const emit = (event: AgentEvent): void => {
      opts.onEvent?.(event);
    };
    const callProvider = async (): Promise<string> => {
      try {
        return await raceAbort(deps.provider.complete(messages, { signal: opts.signal }), opts.signal);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        emit({ type: 'error', message: err.message });
        throw err;
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
          emit({ type: 'tool', name: call.name, args: call.args, result });
        };
        if (!isKnownTool(call.name)) {
          fail(`error: unknown tool "${call.name}"`);
          continue;
        }
        if (isFsTool(call.name)) {
          const result = await executeFsTool(deps.store, call);
          messages.push({ role: 'tool', content: `[${call.name}] ${result}` });
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
