import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { listSiteFiles, readSiteFile, writeSiteFile } from '../sites.js';
import type { SseEvent } from '../sse.js';
import type { ChatMessage, Provider } from './provider.js';
import { createRuntime } from './runtime.js';
import {
  extractToolCalls,
  validateReviewNotesArgs,
  type Question,
  type SiteStore,
} from './tools.js';
import {
  applyPlanEdits,
  normalizePlan,
  planFiles,
  toClientPlan,
  type BuildPlan,
  type ReviewIssue,
} from './plan.js';
import {
  builderPrompt,
  copyPrompt,
  designPrompt,
  plannerPrompt,
  reviewerPrompt,
  type RoleContext,
  type RoleId,
} from './roles.js';

export type BuildPhase = 'INTAKE' | 'PLANNED' | 'BUILDING' | 'REVIEW' | 'DONE' | 'ERROR' | 'CANCELLED';

const TERMINAL_PHASES: ReadonlySet<BuildPhase> = new Set(['DONE', 'ERROR', 'CANCELLED']);

export const MAX_BRIEF_CHARS = 4000;
export const MAX_ANSWER_CHARS = 2000;
const MAX_QUESTION_ROUNDS = 2;
const MAX_PENDING_QUESTIONS = 4;
const MAX_NUDGES = 3;
const MAX_LIST = 50;
const DEFAULT_MAX_CONCURRENT = 10;
const PROSE_CAP = 2000;

const TOOL_NUDGE =
  'You did not emit a tool call. Reply with exactly one tool call per line, e.g. {"tool":"<name>","args":{...}} — no markdown fences.';

export interface BuildMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
  agent?: string;
  ts: number;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

interface QaEntry {
  question: Question;
  answer?: string;
}

export interface BuildSummary {
  id: string;
  brief: string;
  phase: BuildPhase;
  createdAt: number;
  queued: boolean;
}

export interface BuildState {
  id: string;
  brief: string;
  phase: BuildPhase;
  createdAt: number;
  updatedAt: number;
  queued: boolean;
  messages: BuildMessage[];
  files: FileEntry[];
  pendingQuestion?: Question;
  plan?: Record<string, unknown>;
  issues?: ReviewIssue[];
  siteUrl?: string;
  error?: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Thrown by the intake loop when the build parks waiting for user input. */
class Parked extends Error {
  constructor() {
    super('parked');
    this.name = 'Parked';
  }
}

/** Thrown when the build is cancelled (or the server shuts down) mid-drive. */
class BuildStopped extends Error {
  constructor() {
    super('build stopped');
    this.name = 'AbortError';
  }
}

interface BuildRecord {
  id: string;
  brief: string;
  phase: BuildPhase;
  createdAt: number;
  updatedAt: number;
  messages: BuildMessage[];
  qaLog: QaEntry[];
  pendingQuestion: Question | undefined;
  questionQueue: Question[];
  plan: BuildPlan | undefined;
  files: FileEntry[];
  issues: ReviewIssue[] | undefined;
  siteUrl: string | undefined;
  error: string | undefined;
  questionRounds: number;
  // runtime-only (never persisted)
  abort: AbortController | undefined;
  running: boolean;
  queued: boolean;
  currentRole: RoleId | undefined;
  settleWaiters: Array<() => void>;
  writeChain: Promise<void>;
}

interface Snapshot {
  version: 1;
  id: string;
  brief: string;
  phase: BuildPhase;
  createdAt: number;
  updatedAt: number;
  messages: BuildMessage[];
  qaLog: QaEntry[];
  pendingQuestion?: Question;
  questionQueue: Question[];
  plan?: BuildPlan;
  files: FileEntry[];
  issues?: ReviewIssue[];
  siteUrl?: string;
  error?: string;
  questionRounds: number;
}

export interface SseHubLike {
  send(id: string, event: SseEvent): void;
  drop?(id: string): void;
}

export interface OrchestratorDeps {
  /** Root of the confined site store (sites.ts functions). */
  sitesRoot: string;
  /** Snapshots go to <dataDir>/builds/<id>.json. */
  dataDir: string;
  hub: SseHubLike;
  /** Resolved once per drive so PUT /api/config takes effect without a restart. */
  getProvider: () => Provider | Promise<Provider>;
  maxConcurrent?: number;
  previewBase?: string;
  now?: () => number;
}

interface AgentLoopOptions {
  prompt: string;
  kickoff: string;
  provider: Provider;
  maxTurns: number;
  priorTranscript?: ChatMessage[];
  /** Hard per-role output contract (round-1 roles): loop fails without these. */
  requiredFiles?: string[];
  /** Round-2 remaining set: best-effort, leftovers are reported not fatal. */
  targetFiles?: Set<string>;
  bestEffort?: boolean;
  requireReviewNotes?: boolean;
  completeOnAnyWrite?: boolean;
}

const ROLE_TOOLS: Record<RoleId, ReadonlySet<string>> = {
  planner: new Set(['ask', 'plan']),
  design: new Set(['writeFile', 'readFile', 'listFiles', 'finish']),
  copy: new Set(['writeFile', 'readFile', 'listFiles', 'finish']),
  builder: new Set(['writeFile', 'readFile', 'listFiles', 'finish']),
  reviewer: new Set(['readFile', 'listFiles', 'reviewNotes', 'finish']),
};

const PHASES: ReadonlySet<string> = new Set(['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW', 'DONE', 'ERROR', 'CANCELLED']);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isAbortLike(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * The build state machine. One record per build id; a single active drive
 * per build (parked builds hold no resources). State changes are persisted
 * as JSON snapshots and broadcast through the SSE hub.
 */
export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly buildsDir: string;
  private readonly maxConcurrent: number;
  private readonly previewBase: string;
  private readonly now: () => number;
  private readonly builds = new Map<string, BuildRecord>();
  private readonly queue: string[] = [];
  private activeCount = 0;

  private constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.buildsDir = path.join(deps.dataDir, 'builds');
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.previewBase = deps.previewBase ?? '/preview';
    this.now = deps.now ?? Date.now;
  }

  /** Loads snapshots; mid-flight builds resume as honestly interrupted. */
  static async open(deps: OrchestratorDeps): Promise<Orchestrator> {
    const o = new Orchestrator(deps);
    await fsp.mkdir(o.buildsDir, { recursive: true });
    let names: string[] = [];
    try {
      names = await fsp.readdir(o.buildsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let b: BuildRecord | null = null;
      try {
        const raw: unknown = JSON.parse(await fsp.readFile(path.join(o.buildsDir, name), 'utf8'));
        b = o.revive(raw);
      } catch (err) {
        console.error(`[foundry] ignoring unreadable build snapshot ${name}: ${errMsg(err)}`);
        continue;
      }
      if (b === null) {
        console.error(`[foundry] ignoring malformed build snapshot ${name}`);
        continue;
      }
      if (b.phase === 'BUILDING' || b.phase === 'REVIEW' || (b.phase === 'INTAKE' && b.pendingQuestion === undefined)) {
        b.phase = 'ERROR';
        b.error = 'interrupted by server restart';
        b.pendingQuestion = undefined;
        b.questionQueue = [];
        b.messages.push({ role: 'system', text: 'The build was interrupted by a server restart.', ts: o.now() });
      }
      o.builds.set(b.id, b);
      o.persist(b);
    }
    await o.flush();
    return o;
  }

  createBuild(briefInput: string): { id: string; queued: boolean } {
    const brief = typeof briefInput === 'string' ? briefInput.trim() : '';
    if (brief === '') throw new ApiError(400, 'brief must be a non-empty string');
    if (brief.length > MAX_BRIEF_CHARS) {
      throw new ApiError(400, `brief must be at most ${MAX_BRIEF_CHARS} characters`);
    }
    const now = this.now();
    const b: BuildRecord = {
      id: randomUUID(),
      brief,
      phase: 'INTAKE',
      createdAt: now,
      updatedAt: now,
      messages: [],
      qaLog: [],
      pendingQuestion: undefined,
      questionQueue: [],
      plan: undefined,
      files: [],
      issues: undefined,
      siteUrl: undefined,
      error: undefined,
      questionRounds: 0,
      abort: undefined,
      running: false,
      queued: false,
      currentRole: undefined,
      settleWaiters: [],
      writeChain: Promise.resolve(),
    };
    this.builds.set(b.id, b);
    this.pushMessage(b, { role: 'user', text: brief });
    this.emit(b, { type: 'phase', phase: 'INTAKE' });
    this.persist(b);
    this.activate(b.id);
    return { id: b.id, queued: b.queued };
  }

  list(): BuildSummary[] {
    return [...this.builds.values()]
      .map((b) => ({ id: b.id, brief: b.brief, phase: b.phase, createdAt: b.createdAt, queued: b.queued }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_LIST);
  }

  get(id: string): BuildState | undefined {
    const b = this.builds.get(id);
    return b === undefined ? undefined : this.toState(b);
  }

  answer(id: string, questionId: string, answerInput: string): BuildState {
    const b = this.mustGet(id);
    const text = typeof answerInput === 'string' ? answerInput.trim() : '';
    if (text === '') throw new ApiError(400, 'answer must be a non-empty string');
    if (text.length > MAX_ANSWER_CHARS) {
      throw new ApiError(400, `answer must be at most ${MAX_ANSWER_CHARS} characters`);
    }
    if (b.phase !== 'INTAKE' || b.pendingQuestion === undefined) {
      throw new ApiError(409, `build is not waiting for an answer (phase ${b.phase})`);
    }
    if (b.pendingQuestion.id !== questionId) {
      throw new ApiError(409, 'questionId does not match the pending question');
    }
    const entry = b.qaLog.find((e) => e.question.id === questionId && e.answer === undefined);
    if (entry !== undefined) entry.answer = text;
    else b.qaLog.push({ question: b.pendingQuestion, answer: text });
    this.pushMessage(b, { role: 'user', text });
    const next = b.questionQueue.shift();
    b.pendingQuestion = next;
    this.persist(b);
    if (next !== undefined) {
      this.emit(b, { type: 'question', question: next });
    } else {
      this.activate(id);
    }
    return this.toState(b);
  }

  approve(id: string, edits?: unknown): BuildState {
    const b = this.mustGet(id);
    if (b.phase !== 'PLANNED' || b.plan === undefined) {
      throw new ApiError(409, `build is not waiting for plan approval (phase ${b.phase})`);
    }
    if (edits !== undefined) {
      if (!edits || typeof edits !== 'object' || Array.isArray(edits)) {
        throw new ApiError(400, 'plan edits must be an object');
      }
      b.plan = applyPlanEdits(b.plan, edits);
      this.emit(b, { type: 'plan', plan: toClientPlan(b.plan) });
    }
    this.pushMessage(b, { role: 'system', text: 'Plan approved — build started.' });
    this.setPhase(b, 'BUILDING');
    this.persist(b);
    this.activate(id);
    return this.toState(b);
  }

  cancel(id: string): BuildState {
    const b = this.mustGet(id);
    if (TERMINAL_PHASES.has(b.phase)) return this.toState(b);
    const qi = this.queue.indexOf(id);
    if (qi !== -1) this.queue.splice(qi, 1);
    b.queued = false;
    b.pendingQuestion = undefined;
    b.questionQueue = [];
    b.phase = 'CANCELLED';
    this.emit(b, { type: 'phase', phase: 'CANCELLED' });
    this.pushMessage(b, { role: 'system', text: 'Build cancelled.' });
    this.persist(b);
    if (b.abort !== undefined) b.abort.abort();
    this.deps.hub.drop?.(id);
    return this.toState(b);
  }

  /** Resolves when the build's current drive (if any) has fully stopped. */
  whenSettled(id: string): Promise<void> {
    const b = this.builds.get(id);
    if (b === undefined || !b.running) return Promise.resolve();
    return new Promise((resolve) => {
      b.settleWaiters.push(resolve);
    });
  }

  /** Waits for all queued snapshot writes to land. */
  flush(): Promise<void> {
    return Promise.all([...this.builds.values()].map((b) => b.writeChain)).then(() => undefined);
  }

  /** Aborts in-flight drives without rewriting phases; snapshots resume as interrupted. */
  async shutdown(): Promise<void> {
    const running = [...this.builds.values()].filter((b) => b.running);
    for (const b of running) b.abort?.abort();
    await Promise.all(running.map((b) => this.whenSettled(b.id)));
    await this.flush();
  }

  /* ------------------------------------------------------------ */
  /* drive loop                                                    */
  /* ------------------------------------------------------------ */

  private activate(id: string): void {
    const b = this.builds.get(id);
    if (b === undefined || b.running || TERMINAL_PHASES.has(b.phase)) return;
    if (b.phase === 'INTAKE' && b.pendingQuestion !== undefined) return;
    if (b.phase === 'PLANNED') return;
    if (this.activeCount >= this.maxConcurrent) {
      if (!b.queued) {
        b.queued = true;
        this.queue.push(id);
        this.pushMessage(b, {
          role: 'system',
          text: `Queued — waiting for a free build slot (max ${this.maxConcurrent} concurrent).`,
        });
        this.persist(b);
      }
      return;
    }
    b.queued = false;
    b.running = true;
    b.abort = new AbortController();
    this.activeCount += 1;
    const settle = (): void => {
      b.running = false;
      b.abort = undefined;
      this.activeCount -= 1;
      for (const w of b.settleWaiters.splice(0)) w();
      this.drainQueue();
    };
    void this.drive(b).then(settle, settle);
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) break;
      const b = this.builds.get(id);
      if (b === undefined || b.running || TERMINAL_PHASES.has(b.phase)) continue;
      if (b.phase === 'INTAKE' && b.pendingQuestion !== undefined) continue;
      if (b.phase === 'PLANNED') continue;
      b.queued = false;
      this.pushMessage(b, { role: 'system', text: 'A build slot freed up — starting work.' });
      this.activate(id);
      return;
    }
  }

  private async drive(b: BuildRecord): Promise<void> {
    try {
      const provider = await this.deps.getProvider();
      this.throwIfStopped(b);
      if (b.phase === 'INTAKE') await this.runIntake(b, provider);
      if (b.phase === 'BUILDING') await this.runBuilding(b, provider);
    } catch (err) {
      if (err instanceof Parked) {
        // Parked for user input; state was persisted at the park point.
      } else if (b.phase === 'CANCELLED' || isAbortLike(err)) {
        // Cancelled (or shut down) mid-drive; cancel() already reported it.
      } else {
        this.fail(b, err);
      }
    } finally {
      this.persist(b);
    }
  }

  private async runIntake(b: BuildRecord, provider: Provider): Promise<void> {
    b.currentRole = 'planner';
    this.activity(b, 'planner', 'active', 'shaping the plan');
    try {
      await this.agentLoop(b, 'planner', {
        prompt: plannerPrompt(this.roleContext(b)),
        kickoff: 'Begin. Ask a clarifying question only if the brief leaves something material open; otherwise emit the plan now.',
        provider,
        maxTurns: 8,
        priorTranscript: this.plannerTranscript(b),
      });
    } finally {
      b.currentRole = undefined;
    }
  }

  private async runBuilding(b: BuildRecord, provider: Provider): Promise<void> {
    const plan = b.plan;
    if (plan === undefined) throw new Error('cannot build without an approved plan');

    b.currentRole = 'design';
    this.activity(b, 'design', 'active', 'writing styles.css');
    await this.agentLoop(b, 'design', {
      prompt: designPrompt(this.roleContext(b)),
      kickoff: 'Write the complete styles.css now, then finish.',
      provider,
      maxTurns: 6,
      requiredFiles: ['styles.css'],
    });
    this.activity(b, 'design', 'done');
    b.currentRole = undefined;

    this.throwIfStopped(b);
    b.currentRole = 'copy';
    this.activity(b, 'copy', 'active', 'writing index.html');
    this.activity(b, 'builder', 'active', 'writing app.js');
    const [copyResult, builderResult] = await Promise.allSettled([
      this.agentLoop(b, 'copy', {
        prompt: copyPrompt(this.roleContext(b)),
        kickoff: 'Write the complete index.html now, then finish.',
        provider,
        maxTurns: 8,
        requiredFiles: ['index.html'],
      }),
      (async () => {
        b.currentRole = 'builder';
        await this.agentLoop(b, 'builder', {
          prompt: builderPrompt(this.roleContext(b)),
          kickoff: 'Write the complete app.js now, then finish.',
          provider,
          maxTurns: 10,
          requiredFiles: ['app.js'],
        });
      })(),
    ]);
    this.throwIfStopped(b);
    for (const [role, result] of [['copy', copyResult], ['builder', builderResult]] as const) {
      if (result.status === 'fulfilled') this.activity(b, role, 'done');
      else {
        this.activity(b, role, 'error', errMsg(result.reason));
        throw result.reason;
      }
    }
    b.currentRole = undefined;

    const written = new Set((await listSiteFiles(this.deps.sitesRoot, b.id)).map((e) => e.path));
    const remaining = planFiles(plan).filter((f) => !written.has(f));
    if (remaining.length > 0) {
      this.throwIfStopped(b);
      b.currentRole = 'builder';
      this.activity(b, 'builder', 'active', `writing remaining files: ${remaining.join(', ')}`);
      await this.agentLoop(b, 'builder', {
        prompt: builderPrompt({ ...this.roleContext(b), remainingFiles: remaining }),
        kickoff: `Write the remaining planned files now: ${remaining.join(', ')}`,
        provider,
        maxTurns: 6,
        bestEffort: true,
        targetFiles: new Set(remaining),
      });
      const skipped = remaining.filter((f) => !b.files.some((x) => x.path === f));
      if (skipped.length > 0) {
        this.pushMessage(b, {
          role: 'system',
          text: `The builder did not produce: ${skipped.join(', ')} — continuing without them.`,
        });
      }
      this.activity(b, 'builder', 'done');
      b.currentRole = undefined;
    }

    this.setPhase(b, 'REVIEW');
    b.currentRole = 'reviewer';
    this.activity(b, 'reviewer', 'active', 'reviewing the site');
    await this.agentLoop(b, 'reviewer', {
      prompt: reviewerPrompt(this.roleContext(b)),
      kickoff: 'Review the site now: listFiles, read every file, then reviewNotes and finish.',
      provider,
      maxTurns: 10,
      requireReviewNotes: true,
    });
    this.activity(b, 'reviewer', 'done');
    b.currentRole = undefined;

    const issues = b.issues ?? [];
    if (issues.length > 0) {
      this.throwIfStopped(b);
      b.currentRole = 'builder';
      this.activity(b, 'builder', 'active', `fixing ${issues.length} review issue(s)`);
      await this.agentLoop(b, 'builder', {
        prompt: builderPrompt({ ...this.roleContext(b), issues }),
        kickoff: 'Fix the review issues now: rewrite each affected file completely, then finish.',
        provider,
        maxTurns: 10,
        bestEffort: true,
        completeOnAnyWrite: true,
      });
      this.activity(b, 'builder', 'done');
      b.currentRole = undefined;
    }

    b.siteUrl = `${this.previewBase}/${encodeURIComponent(b.id)}/`;
    this.pushMessage(b, { role: 'system', text: 'Build complete — the preview is live.' });
    this.setPhase(b, 'DONE');
    this.emit(b, { type: 'done', siteUrl: b.siteUrl });
    this.persist(b);
    this.deps.hub.drop?.(b.id);
  }

  /* ------------------------------------------------------------ */
  /* the per-role tool loop                                        */
  /* ------------------------------------------------------------ */

  /**
   * Site store adapter handed to the runtime (its intended seam). Enforces
   * per-role fs-tool gating and the abort signal inside the runtime's tool
   * execution, surfacing both as model-readable error results.
   */
  private storeFor(b: BuildRecord, role: RoleId): SiteStore {
    const id = b.id;
    const root = this.deps.sitesRoot;
    return {
      writeFile: async (p, c) => {
        if (!ROLE_TOOLS[role].has('writeFile')) throw new Error(`the ${role} role cannot use tool "writeFile"`);
        this.throwIfStopped(b);
        await writeSiteFile(root, id, p, c);
      },
      readFile: async (p) => {
        if (!ROLE_TOOLS[role].has('readFile')) throw new Error(`the ${role} role cannot use tool "readFile"`);
        return (await readSiteFile(root, id, p)).toString('utf8');
      },
      listFiles: async () => {
        if (!ROLE_TOOLS[role].has('listFiles')) throw new Error(`the ${role} role cannot use tool "listFiles"`);
        return (await listSiteFiles(root, id)).map((e) => e.path);
      },
    };
  }

  /** Reconciles b.files with the store on disk, emitting one file event per new/changed file. */
  private async syncFiles(b: BuildRecord): Promise<void> {
    const entries = await listSiteFiles(this.deps.sitesRoot, b.id);
    const changed: FileEntry[] = [];
    for (const e of entries) {
      const prev = b.files.find((f) => f.path === e.path);
      if (prev === undefined) {
        const entry = { path: e.path, bytes: e.size };
        b.files.push(entry);
        changed.push(entry);
      } else if (prev.bytes !== e.size) {
        prev.bytes = e.size;
        changed.push({ ...prev });
      }
    }
    for (const f of changed) this.emit(b, { type: 'file', file: f });
    if (changed.length > 0) this.persist(b);
  }

  /**
   * Drives one role. The runtime owns each provider round (abort race,
   * transcript, tool extraction, fs execution, argument validation) and runs
   * with maxIterations: 1 so the orchestrator keeps the higher-level policy:
   * parking for questions/approval, per-role completion contracts, the
   * question-round cap, and best-effort passes.
   */
  private async agentLoop(b: BuildRecord, role: RoleId, opts: AgentLoopOptions): Promise<void> {
    const runtime = createRuntime({ provider: opts.provider, store: this.storeFor(b, role) });
    const messages: ChatMessage[] = [
      { role: 'system', content: opts.prompt },
      { role: 'user', content: opts.kickoff },
      ...(opts.priorTranscript ?? []),
    ];
    let sawReviewNotes = false;
    let turn = 0;
    let nudges = 0;
    let blockedAsks = 0;
    for (;;) {
      turn += 1;
      if (turn > opts.maxTurns) {
        if (opts.bestEffort) return;
        throw new Error(`${role} did not finish its job within ${opts.maxTurns} replies`);
      }
      this.throwIfStopped(b);
      const signal = b.abort?.signal;
      const result = await runtime.run(messages, {
        ...(signal !== undefined ? { signal } : {}),
        maxIterations: 1,
      });
      this.throwIfStopped(b);
      await this.syncFiles(b);

      // The response is re-extracted (the runtime keeps its own copy) for the
      // pieces the runtime intentionally does not interpret: prose shown to
      // the user, raw plan args (its validator would strip designNotes), and
      // attempted writeFile targets for drift detection.
      const extracted = extractToolCalls(result.response);
      this.pushProse(b, role, extracted.text);
      const writeCalls = extracted.calls.filter((c) => c.name === 'writeFile');

      if (result.questions.length > 0 && ROLE_TOOLS[role].has('ask')) {
        if (b.questionRounds >= MAX_QUESTION_ROUNDS) {
          blockedAsks += 1;
          messages.push({
            role: 'tool',
            content: 'error: question limit reached (2 rounds) — emit the plan tool now',
          });
        } else {
          b.questionRounds += 1;
          const first = result.questions[0];
          if (first !== undefined) {
            b.pendingQuestion = first;
            for (const q of result.questions.slice(1)) b.questionQueue.push(q);
            b.questionQueue = b.questionQueue.slice(0, MAX_PENDING_QUESTIONS);
            for (const q of result.questions) b.qaLog.push({ question: q });
            this.emit(b, { type: 'question', question: first });
            this.persist(b);
          }
          throw new Parked();
        }
      }
      if (blockedAsks >= 2) {
        throw new Error('planner kept asking questions past the 2-round limit without producing a plan');
      }

      if (ROLE_TOOLS[role].has('plan')) {
        let planAccepted: BuildPlan | null = null;
        for (const call of extracted.calls) {
          if (call.name !== 'plan') continue;
          const plan = normalizePlan(call.args);
          if (plan !== null) planAccepted = plan;
          else {
            messages.push({
              role: 'tool',
              content: 'error: plan needs {summary, steps:[{title, detail, files[]}]} with at least one real step',
            });
          }
        }
        if (planAccepted !== null) {
          b.plan = planAccepted;
          b.pendingQuestion = undefined;
          b.questionQueue = [];
          this.emit(b, { type: 'plan', plan: toClientPlan(planAccepted) });
          this.setPhase(b, 'PLANNED');
          this.activity(b, 'planner', 'done');
          this.persist(b);
          throw new Parked();
        }
      }

      const notesCall = ROLE_TOOLS[role].has('reviewNotes')
        ? extracted.calls.find((c) => c.name === 'reviewNotes')
        : undefined;
      if (notesCall !== undefined) {
        const v = validateReviewNotesArgs(notesCall.args);
        if (v.ok) {
          const issues: ReviewIssue[] = v.value.map((i) => ({
            severity: i.severity,
            text: i.detail,
            ...(i.file !== undefined ? { file: i.file } : {}),
          }));
          b.issues = issues;
          sawReviewNotes = true;
          this.emit(b, { type: 'review', issues });
          this.persist(b);
        }
      }

      const finishSeen = result.summary !== null && ROLE_TOOLS[role].has('finish');
      if (finishSeen && result.summary !== null && result.summary !== 'finished') {
        this.pushProse(b, role, result.summary);
      }

      const requiredMissing = (opts.requiredFiles ?? []).filter((f) => !b.files.some((x) => x.path === f));
      if (finishSeen) {
        if (opts.requireReviewNotes === true && !sawReviewNotes) {
          nudges += 1;
          messages.push({
            role: 'tool',
            content: 'error: you called finish without reviewNotes — emit reviewNotes first (an empty issues array is fine)',
          });
          if (nudges > MAX_NUDGES) throw new Error(`${role} finished without ever emitting reviewNotes`);
          continue;
        }
        if (requiredMissing.length > 0 && opts.bestEffort !== true) {
          throw new Error(`${role} finished without writing ${requiredMissing.join(', ')}`);
        }
        return;
      }
      if ((opts.requiredFiles?.length ?? 0) > 0 && requiredMissing.length === 0) return;
      if (opts.targetFiles !== undefined && [...opts.targetFiles].every((f) => b.files.some((x) => x.path === f))) {
        return;
      }
      if (opts.completeOnAnyWrite === true && writeCalls.length > 0) return;
      // Off-target writes in a best-effort pass mean the model is drifting
      // (the mock provider rewrites app.js here); stop instead of spinning.
      if (
        opts.bestEffort === true &&
        writeCalls.length > 0 &&
        !writeCalls.some((c) => typeof c.args.path === 'string' && opts.targetFiles?.has(c.args.path) === true)
      ) {
        return;
      }
      if (extracted.calls.length === 0) {
        nudges += 1;
        messages.push({ role: 'tool', content: TOOL_NUDGE });
        if (nudges > MAX_NUDGES) {
          if (opts.bestEffort) return;
          throw new Error(`${role} is not emitting tool calls`);
        }
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* intake transcript rebuild                                     */
  /* ------------------------------------------------------------ */

  /** Replays the ask/answer history so a resumed planner sees its own questions. */
  private plannerTranscript(b: BuildRecord): ChatMessage[] {
    if (b.qaLog.length === 0) return [];
    const asks = b.qaLog
      .map((e) =>
        JSON.stringify({
          tool: 'ask',
          args: { id: e.question.id, question: e.question.question, options: e.question.options },
        }),
      )
      .join('\n');
    const answered = b.qaLog.filter((e) => e.answer !== undefined);
    const out: ChatMessage[] = [{ role: 'assistant', content: asks }];
    if (answered.length > 0) {
      const lines = answered.map((e) => `Q: ${e.question.question}\nA: ${e.answer ?? ''}`);
      out.push({ role: 'user', content: `The user answered:\n${lines.join('\n')}` });
    }
    return out;
  }

  private roleContext(b: BuildRecord): RoleContext {
    return {
      brief: b.brief,
      answers: b.qaLog
        .filter((e) => e.answer !== undefined)
        .map((e) => ({ question: e.question.question, answer: e.answer ?? '' })),
      plan: b.plan,
      writtenFiles: b.files.map((f) => f.path),
      questionRounds: b.questionRounds,
      maxQuestionRounds: MAX_QUESTION_ROUNDS,
    };
  }

  /* ------------------------------------------------------------ */
  /* state helpers                                                 */
  /* ------------------------------------------------------------ */

  private mustGet(id: string): BuildRecord {
    const b = this.builds.get(id);
    if (b === undefined) throw new ApiError(404, `unknown build id: ${id}`);
    return b;
  }

  private throwIfStopped(b: BuildRecord): void {
    if (b.abort?.signal.aborted === true || b.phase === 'CANCELLED') throw new BuildStopped();
  }

  private fail(b: BuildRecord, err: unknown): void {
    const message = errMsg(err);
    b.error = message;
    if (b.currentRole !== undefined) this.activity(b, b.currentRole, 'error', message);
    this.pushMessage(b, { role: 'system', text: `Build failed: ${message}` });
    this.setPhase(b, 'ERROR');
    this.emit(b, { type: 'error', error: message });
    this.persist(b);
    this.deps.hub.drop?.(b.id);
  }

  private emit(b: BuildRecord, event: SseEvent): void {
    this.deps.hub.send(b.id, event);
  }

  private setPhase(b: BuildRecord, phase: BuildPhase): void {
    if (b.phase === phase) return;
    b.phase = phase;
    this.emit(b, { type: 'phase', phase });
    this.persist(b);
  }

  private pushMessage(b: BuildRecord, msg: Omit<BuildMessage, 'ts'>): void {
    const m: BuildMessage = { ...msg, ts: this.now() };
    b.messages.push(m);
    this.emit(b, { type: 'message', message: m });
    this.persist(b);
  }

  private pushProse(b: BuildRecord, role: RoleId, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    this.pushMessage(b, {
      role: 'agent',
      agent: role,
      text: trimmed.length > PROSE_CAP ? `${trimmed.slice(0, PROSE_CAP)}...` : trimmed,
    });
  }

  private activity(b: BuildRecord, role: RoleId, state: 'active' | 'done' | 'error', note?: string): void {
    this.emit(b, { type: 'activity', activity: { role, state, ...(note !== undefined ? { note } : {}) } });
  }

  private toState(b: BuildRecord): BuildState {
    return {
      id: b.id,
      brief: b.brief,
      phase: b.phase,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      queued: b.queued,
      messages: b.messages.map((m) => ({ ...m })),
      files: b.files.map((f) => ({ ...f })),
      ...(b.pendingQuestion !== undefined ? { pendingQuestion: b.pendingQuestion } : {}),
      ...(b.plan !== undefined ? { plan: toClientPlan(b.plan) } : {}),
      ...(b.issues !== undefined ? { issues: b.issues.map((i) => ({ ...i })) } : {}),
      ...(b.siteUrl !== undefined ? { siteUrl: b.siteUrl } : {}),
      ...(b.error !== undefined ? { error: b.error } : {}),
    };
  }

  /* ------------------------------------------------------------ */
  /* persistence                                                   */
  /* ------------------------------------------------------------ */

  private persist(b: BuildRecord): void {
    b.updatedAt = this.now();
    const snapshot: Snapshot = {
      version: 1,
      id: b.id,
      brief: b.brief,
      phase: b.phase,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      messages: b.messages,
      qaLog: b.qaLog,
      ...(b.pendingQuestion !== undefined ? { pendingQuestion: b.pendingQuestion } : {}),
      questionQueue: b.questionQueue,
      ...(b.plan !== undefined ? { plan: b.plan } : {}),
      files: b.files,
      ...(b.issues !== undefined ? { issues: b.issues } : {}),
      ...(b.siteUrl !== undefined ? { siteUrl: b.siteUrl } : {}),
      ...(b.error !== undefined ? { error: b.error } : {}),
      questionRounds: b.questionRounds,
    };
    const json = JSON.stringify(snapshot);
    const file = path.join(this.buildsDir, `${b.id}.json`);
    const tmp = path.join(this.buildsDir, `.${b.id}.${process.pid}.tmp`);
    b.writeChain = b.writeChain
      .then(async () => {
        await fsp.mkdir(this.buildsDir, { recursive: true });
        await fsp.writeFile(tmp, json, 'utf8');
        await fsp.rename(tmp, file);
      })
      .catch((err: unknown) => {
        console.error(`[foundry] failed to persist build ${b.id}: ${errMsg(err)}`);
      });
  }

  private revive(raw: unknown): BuildRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const s = raw as Partial<Snapshot>;
    if (typeof s.id !== 'string' || s.id === '') return null;
    if (typeof s.brief !== 'string') return null;
    if (typeof s.phase !== 'string' || !PHASES.has(s.phase)) return null;
    const now = this.now();
    return {
      id: s.id,
      brief: s.brief,
      phase: s.phase as BuildPhase,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : now,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : now,
      messages: Array.isArray(s.messages) ? s.messages : [],
      qaLog: Array.isArray(s.qaLog) ? s.qaLog : [],
      pendingQuestion: s.pendingQuestion,
      questionQueue: Array.isArray(s.questionQueue) ? s.questionQueue : [],
      plan: s.plan,
      files: Array.isArray(s.files) ? s.files : [],
      issues: Array.isArray(s.issues) ? s.issues : undefined,
      siteUrl: typeof s.siteUrl === 'string' ? s.siteUrl : undefined,
      error: typeof s.error === 'string' ? s.error : undefined,
      questionRounds: typeof s.questionRounds === 'number' ? s.questionRounds : 0,
      abort: undefined,
      running: false,
      queued: false,
      currentRole: undefined,
      settleWaiters: [],
      writeChain: Promise.resolve(),
    };
  }
}
