import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { listSiteFiles, readSiteFile, writeSiteFile } from '../sites.js';
import type { SseEvent } from '../sse.js';
import { scanSiteEnv, type EnvReport } from './envNotes.js';
import type { CheckpointService } from './checkpoints.js';
import type { ChatMessage, Provider } from './provider.js';
import { createRuntime } from './runtime.js';
import type { AgentEvent } from './runtime.js';
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
  planPages,
  sanitizeSitePath,
  toClientPlan,
  type BuildPlan,
  type ReviewIssue,
} from './plan.js';
import {
  builderPrompt,
  copyPrompt,
  designPrompt,
  fixErrorPrompt,
  plannerPrompt,
  reviewerPrompt,
  targetedEditPrompt,
  type FixErrorInput,
  type RoleContext,
  type RoleId,
  type SiteFileContent,
} from './roles.js';

export type BuildPhase = 'INTAKE' | 'PLANNED' | 'BUILDING' | 'REVIEW' | 'DONE' | 'EDITING' | 'ERROR' | 'CANCELLED';

const TERMINAL_PHASES: ReadonlySet<BuildPhase> = new Set(['DONE', 'ERROR', 'CANCELLED']);
/** Phases in which a drive is (or will be) doing agent work — the only pausable states. */
const PAUSABLE_PHASES: ReadonlySet<BuildPhase> = new Set(['BUILDING', 'REVIEW', 'EDITING']);

export const MAX_BRIEF_CHARS = 4000;
export const MAX_ANSWER_CHARS = 2000;
export const MAX_INSTRUCTION_CHARS = 4000;
export const MAX_ERROR_MESSAGE_CHARS = 4000;
const MAX_QUESTION_ROUNDS = 2;
const MAX_PENDING_QUESTIONS = 4;
const MAX_NUDGES = 3;
/** What autopilot answers when the planner asks; lets it choose and move on. */
const AUTOPILOT_ANSWER = 'You decide — pick whatever fits the brief best and continue.';
const MAX_LIST = 50;
const DEFAULT_MAX_CONCURRENT = 10;
const PROSE_CAP = 2000;
/** An edit round seeds the builder with at most this many current files. */
const MAX_EDIT_FILES = 8;
/** Plans larger than this split the remaining builder work into two parallel rounds. */
const FAN_OUT_PLAN_FILES = 6;
const MAX_FAN_OUT_ROUNDS = 2;
const MAX_ERROR_LINE = 1_000_000;

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
  paused: boolean;
  /** Hands-free mode: plans auto-approve, planner questions auto-answer. */
  autopilot: boolean;
  messages: BuildMessage[];
  files: FileEntry[];
  pendingQuestion?: Question;
  plan?: Record<string, unknown>;
  issues?: ReviewIssue[];
  siteUrl?: string;
  error?: string;
  /** Environment references + secret-exposure warnings, scanned at DONE. */
  envNotes?: EnvReport;
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

/** Thrown at an agent-round boundary when pause() has parked the drive. */
class Paused extends Error {
  constructor() {
    super('paused');
    this.name = 'Paused';
  }
}

/** Thrown when the build is cancelled (or the server shuts down) mid-drive. */
class BuildStopped extends Error {
  constructor() {
    super('build stopped');
    this.name = 'AbortError';
  }
}

/** The follow-up work an EDITING drive performs; persisted so paused edits survive restarts. */
export type PendingWork =
  | { kind: 'edit'; instruction: string }
  | { kind: 'fix'; message: string; file?: string; line?: number };

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
  envNotes: EnvReport | undefined;
  questionRounds: number;
  paused: boolean;
  /** Hands-free mode: plans auto-approve, planner questions auto-answer. */
  autopilot: boolean;
  pendingWork: PendingWork | undefined;
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
  envNotes?: EnvReport;
  questionRounds: number;
  paused?: boolean;
  autopilot?: boolean;
  pendingWork?: PendingWork;
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
  /** Optional checkpoint store: snapshots on initial DONE and after edits. */
  checkpoints?: CheckpointService;
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

const PHASES: ReadonlySet<string> = new Set(['INTAKE', 'PLANNED', 'BUILDING', 'REVIEW', 'DONE', 'EDITING', 'ERROR', 'CANCELLED']);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isAbortLike(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/* ------------------------------------------------------------ */
/* pure helpers (exported for focused tests)                     */
/* ------------------------------------------------------------ */

function truncateNote(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * Builder fan-out partition: plans with more than FAN_OUT_PLAN_FILES files
 * split the remaining work into two parallel rounds over contiguous
 * plan-ordered halves (capped at MAX_FAN_OUT_ROUNDS), so each round's file
 * events preserve plan order within the group.
 */
export function partitionRemaining(plan: BuildPlan, remaining: string[]): string[][] {
  if (planFiles(plan).length <= FAN_OUT_PLAN_FILES || remaining.length < 2) return [remaining];
  const mid = Math.ceil(remaining.length / MAX_FAN_OUT_ROUNDS);
  return [remaining.slice(0, mid), remaining.slice(mid)];
}

/**
 * Word hints that point an edit instruction at a file family even when no
 * file is named outright ("make the headline bigger" -> html + css).
 */
const EDIT_EXT_HINTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['css', ['style', 'styles', 'styling', 'css', 'color', 'colors', 'colour', 'colours', 'font', 'fonts', 'layout', 'design', 'theme', 'spacing', 'animation', 'animations', 'motion', 'gradient', 'hover', 'responsive', 'mobile', 'bigger', 'smaller']],
  ['js', ['script', 'scripts', 'js', 'javascript', 'behavior', 'behaviour', 'interaction', 'interactive', 'counter', 'counters', 'reveal', 'marquee', 'menu', 'toggle', 'carousel', 'slider', 'glow', 'scroll', 'click', 'error', 'broken', 'bug']],
  ['html', ['html', 'markup', 'page', 'copy', 'text', 'headline', 'hero', 'section', 'sections', 'content', 'pricing', 'price', 'faq', 'faqs', 'testimonial', 'testimonials', 'footer', 'header', 'nav', 'form', 'title', 'heading', 'button', 'link', 'image', 'images']],
  ['md', ['readme', 'docs', 'documentation', 'md']],
  ['json', ['json', 'data']],
  ['svg', ['icon', 'icons', 'svg', 'logo']],
];

function editScore(path: string, tokens: readonly string[]): number {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const filename = segments[segments.length - 1] ?? lower;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  let score = 0;
  for (const t of tokens) {
    if (t === lower) score += 6; // full path mentioned: "assets/site.css"
    else if (t === filename) score += 5; // file mentioned: "styles.css"
    else if (t === stem) score += 4; // stem mentioned: "styles"
    else if (segments.includes(t)) score += 3; // directory/segment match
    else if (t.length >= 4 && lower.includes(t)) score += 1; // loose substring
  }
  for (const [hintExt, words] of EDIT_EXT_HINTS) {
    if (hintExt !== ext) continue;
    // Multiple matched hint words rank higher: "hero headline" is markup,
    // not just "something in an html file".
    const hits = words.filter((w) => tokens.includes(w)).length;
    if (hits > 0) score += Math.min(1 + hits, 4);
    break;
  }
  return score;
}

/**
 * Picks the <= max files an edit instruction most likely refers to, using
 * name/path heuristics. Input order is the tie-break (callers pass plan
 * order), so equal scores keep plan order. When nothing matches lexically,
 * the core trio is seeded as the sensible default context; the builder can
 * always readFile anything the seed misses.
 */
export function selectEditFiles(paths: readonly string[], instruction: string, max: number = MAX_EDIT_FILES): string[] {
  const tokens = [
    ...new Set((instruction.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? []).filter((t) => t.length >= 2)),
  ];
  const scored = paths.map((p) => ({ path: p, score: editScore(p, tokens) }));
  if (scored.every((s) => s.score === 0)) {
    for (const core of ['index.html', 'styles.css', 'app.js']) {
      const hit = scored.find((s) => s.path === core);
      if (hit !== undefined) hit.score = 1;
    }
  }
  scored.sort((a, b) => b.score - a.score); // stable: ties keep input order
  return scored
    .filter((s) => s.score > 0)
    .slice(0, Math.max(1, max))
    .map((s) => s.path);
}

const ERROR_PATH_RE = /([A-Za-z0-9_][A-Za-z0-9_\-./]*\.(?:html|css|js|svg|json|txt|md))(?:\s*:\s*(\d{1,7}))?/g;

/** Shape-checks a persisted work item; anything unrecognized is dropped, never trusted. */
function revivePendingWork(raw: unknown): PendingWork | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'edit' && typeof o.instruction === 'string' && o.instruction !== '') {
    return { kind: 'edit', instruction: o.instruction };
  }
  if (o.kind === 'fix' && typeof o.message === 'string' && o.message !== '') {
    const work: PendingWork = { kind: 'fix', message: o.message };
    if (typeof o.file === 'string' && o.file !== '') work.file = o.file;
    if (typeof o.line === 'number' && Number.isInteger(o.line) && o.line >= 1) work.line = o.line;
    return work;
  }
  return undefined;
}

/**
 * Pulls the implicated site file (and optional 1-based line) out of a console
 * error message like "Uncaught TypeError at app.js:42". When `known` paths
 * are given, the first match that is actually part of the site wins.
 */
export function parseErrorLocation(message: string, known?: readonly string[]): { file?: string; line?: number } {
  const validLine = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= MAX_ERROR_LINE ? n : undefined;
  };
  let file: string | undefined;
  let line: number | undefined;
  let fallback: string | undefined;
  let fallbackLine: number | undefined;
  for (const m of message.matchAll(ERROR_PATH_RE)) {
    const candidate = sanitizeSitePath(m[1]);
    if (candidate === null) continue;
    if (known !== undefined && known.includes(candidate)) {
      file = candidate;
      line = validLine(m[2]);
      break;
    }
    if (fallback === undefined) {
      fallback = candidate;
      fallbackLine = validLine(m[2]);
    }
  }
  if (file === undefined && known === undefined && fallback !== undefined) {
    file = fallback;
    line = fallbackLine;
  }
  if (line === undefined) {
    line = validLine(/line\s+(\d{1,7})/i.exec(message)?.[1]);
  }
  const out: { file?: string; line?: number } = {};
  if (file !== undefined) out.file = file;
  if (line !== undefined) out.line = line;
  return out;
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
      const midFlight =
        b.phase === 'BUILDING' || b.phase === 'REVIEW' || b.phase === 'EDITING'
        || (b.phase === 'INTAKE' && b.pendingQuestion === undefined);
      if (midFlight && b.paused && b.phase !== 'INTAKE') {
        // A paused drive holds no in-flight work, so it survives a restart
        // resumable (EDITING resumes from the persisted pendingWork).
        b.messages.push({
          role: 'system',
          text: 'The server restarted; the build is still paused — resume it to continue.',
          ts: o.now(),
        });
      } else if (b.phase === 'EDITING') {
        // The pre-edit site is still intact and live; an interrupted edit may
        // be partially applied, so say so instead of claiming either outcome.
        b.phase = 'DONE';
        b.pendingWork = undefined;
        b.messages.push({
          role: 'system',
          text: 'The edit was interrupted by a server restart; some edited files may be only partially applied.',
          ts: o.now(),
        });
      } else if (
        b.phase === 'INTAKE' &&
        b.pendingQuestion === undefined &&
        b.qaLog.length === 0 &&
        b.plan === undefined
      ) {
        // Never started (was only waiting for a free slot): resume it instead
        // of destroying the brief as 'interrupted'.
        b.messages.push({
          role: 'system',
          text: 'The server restarted; resuming the queued build.',
          ts: o.now(),
        });
        o.builds.set(b.id, b);
        o.persist(b);
        o.activate(b.id);
        continue;
      } else if (midFlight) {
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

  createBuild(briefInput: string, opts?: { autopilot?: boolean }): { id: string; queued: boolean } {
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
      envNotes: undefined,
      questionRounds: 0,
      paused: false,
      autopilot: opts?.autopilot === true,
      pendingWork: undefined,
      abort: undefined,
      running: false,
      queued: false,
      currentRole: undefined,
      settleWaiters: [],
      writeChain: Promise.resolve(),
    };
    this.builds.set(b.id, b);
    this.pushMessage(b, { role: 'user', text: brief });
    if (b.autopilot) {
      this.pushMessage(b, { role: 'system', text: 'Autopilot on — plans auto-approve and questions auto-answer.' });
    }
    this.emit(b, { type: 'phase', phase: 'INTAKE' });
    this.persist(b);
    this.activate(b.id);
    return { id: b.id, queued: b.queued };
  }

  /**
   * Toggles hands-free mode on a build. Enabling it while the build is parked
   * immediately drives forward: a pending plan auto-approves, a pending
   * question chain auto-answers with AUTOPILOT_ANSWER.
   */
  setAutopilot(id: string, enabledInput: unknown): BuildState {
    const enabled = enabledInput === true;
    const b = this.mustGet(id);
    if (b.autopilot === enabled) return this.toState(b);
    b.autopilot = enabled;
    this.pushMessage(b, {
      role: 'system',
      text: enabled ? 'Autopilot on — plans auto-approve and questions auto-answer.' : 'Autopilot off — the build waits for you at plans and questions.',
    });
    this.persist(b);
    if (enabled && b.phase === 'PLANNED' && b.plan !== undefined) {
      return this.approve(id);
    }
    if (enabled && b.phase === 'INTAKE' && b.pendingQuestion !== undefined) {
      const pending = [b.pendingQuestion, ...b.questionQueue];
      for (const q of pending) {
        const entry = b.qaLog.find((e) => e.question.id === q.id && e.answer === undefined);
        if (entry !== undefined) entry.answer = AUTOPILOT_ANSWER;
        else b.qaLog.push({ question: q, answer: AUTOPILOT_ANSWER });
      }
      b.questionQueue = [];
      b.pendingQuestion = undefined;
      this.pushMessage(b, { role: 'user', text: AUTOPILOT_ANSWER });
      this.pushMessage(b, { role: 'system', text: 'Autopilot answered on your behalf.' });
      this.persist(b);
      this.activate(id);
    }
    return this.toState(b);
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

  /**
   * Reconciles a build's file list with the store on disk (used by the
   * checkpoint-restore route so GET /:id reflects restored files). Emits
   * the normal file events and persists; returns the live list.
   */
  async rescanFiles(id: string): Promise<FileEntry[]> {
    const b = this.mustGet(id);
    await this.syncFiles(b);
    this.persist(b);
    return b.files.map((f) => ({ ...f }));
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
    b.paused = false;
    b.pendingWork = undefined;
    b.pendingQuestion = undefined;
    b.questionQueue = [];
    b.phase = 'CANCELLED';
    // A mid-flight role must not spin "active" forever on the timeline.
    if (b.currentRole !== undefined) this.activity(b, b.currentRole, 'error', 'cancelled');
    this.emit(b, { type: 'phase', phase: 'CANCELLED' });
    this.pushMessage(b, { role: 'system', text: 'Build cancelled.' });
    this.persist(b);
    if (b.abort !== undefined) b.abort.abort();
    this.deps.hub.drop?.(id);
    return this.toState(b);
  }

  /**
   * Follow-up edit on a DONE build: reopens it as EDITING and queues one
   * targeted builder round. The instruction is validated here; the round
   * itself runs in drive() -> runEditing().
   */
  edit(id: string, instructionInput: string): BuildState {
    const b = this.mustGet(id);
    const instruction = typeof instructionInput === 'string' ? instructionInput.trim() : '';
    if (instruction === '') throw new ApiError(400, 'instruction must be a non-empty string');
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      throw new ApiError(400, `instruction must be at most ${MAX_INSTRUCTION_CHARS} characters`);
    }
    if (b.phase !== 'DONE') {
      throw new ApiError(409, `only a DONE build accepts edits (phase ${b.phase})`);
    }
    b.pendingWork = { kind: 'edit', instruction };
    this.pushMessage(b, { role: 'user', text: instruction });
    this.setPhase(b, 'EDITING');
    this.persist(b);
    this.activate(id);
    return this.toState(b);
  }

  /**
   * "Fix this error" on a DONE build: one builder round fed with the console
   * error text plus the implicated file's content, then back to DONE.
   */
  fixError(id: string, messageInput: string, opts: { file?: unknown; line?: unknown } = {}): BuildState {
    const b = this.mustGet(id);
    const message = typeof messageInput === 'string' ? messageInput.trim() : '';
    if (message === '') throw new ApiError(400, 'message must be a non-empty string');
    if (message.length > MAX_ERROR_MESSAGE_CHARS) {
      throw new ApiError(400, `message must be at most ${MAX_ERROR_MESSAGE_CHARS} characters`);
    }
    if (b.phase !== 'DONE') {
      throw new ApiError(409, `only a DONE build accepts error fixes (phase ${b.phase})`);
    }
    let file: string | undefined;
    if (opts.file !== undefined) {
      const sanitized = sanitizeSitePath(opts.file);
      if (sanitized === null) throw new ApiError(400, 'file must be a valid relative site path');
      if (!b.files.some((f) => f.path === sanitized)) {
        throw new ApiError(400, `file is not part of this site: ${sanitized}`);
      }
      file = sanitized;
    }
    let line: number | undefined;
    if (opts.line !== undefined) {
      if (typeof opts.line !== 'number' || !Number.isInteger(opts.line) || opts.line < 1 || opts.line > MAX_ERROR_LINE) {
        throw new ApiError(400, `line must be an integer between 1 and ${MAX_ERROR_LINE}`);
      }
      line = opts.line;
    }
    const work: PendingWork = { kind: 'fix', message };
    if (file !== undefined) work.file = file;
    if (line !== undefined) work.line = line;
    b.pendingWork = work;
    this.pushMessage(b, {
      role: 'user',
      text: `Fix this error${file !== undefined ? ` in ${file}${line !== undefined ? `:${line}` : ''}` : ''}: ${message}`,
    });
    this.setPhase(b, 'EDITING');
    this.persist(b);
    this.activate(id);
    return this.toState(b);
  }

  /**
   * Parks the state machine at the next agent-round boundary (never mid
   * tool-call). When a round is in flight the pause is honest about being
   * pending: the event carries pending: true and the drive parks when the
   * current reply completes. Paused state is persisted, so a paused build
   * stays resumable across restarts.
   */
  pause(id: string): BuildState {
    const b = this.mustGet(id);
    if (!PAUSABLE_PHASES.has(b.phase)) {
      throw new ApiError(409, `build is not doing agent work (phase ${b.phase})`);
    }
    if (b.paused) return this.toState(b);
    b.paused = true;
    // A queued build yields its slot; resume() re-queues through activate().
    const qi = this.queue.indexOf(id);
    if (qi !== -1) this.queue.splice(qi, 1);
    b.queued = false;
    const pending = b.running;
    this.emit(b, { type: 'pause', paused: true, pending });
    this.pushMessage(b, {
      role: 'system',
      text: pending
        ? 'Pause requested — the current agent round will finish first.'
        : 'Build paused.',
    });
    this.persist(b);
    return this.toState(b);
  }

  resume(id: string): BuildState {
    const b = this.mustGet(id);
    if (TERMINAL_PHASES.has(b.phase)) {
      throw new ApiError(409, `build cannot be resumed (phase ${b.phase})`);
    }
    if (!b.paused) throw new ApiError(409, `build is not paused (phase ${b.phase})`);
    b.paused = false;
    this.emit(b, { type: 'pause', paused: false, pending: false });
    this.pushMessage(b, { role: 'system', text: 'Build resumed.' });
    this.persist(b);
    this.activate(id);
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
    if (b.paused) return;
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
      if (b.paused) {
        // Normally pause() already dequeued it; never start a paused build.
        b.queued = false;
        continue;
      }
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
      // REVIEW re-enters runBuilding: a build parked during review resumes
      // here, and runBuilding skips the stages already on disk.
      if (b.phase === 'BUILDING' || b.phase === 'REVIEW') await this.runBuilding(b, provider);
      if (b.phase === 'EDITING') await this.runEditing(b, provider);
    } catch (err) {
      if (err instanceof Parked) {
        // Parked for user input; state was persisted at the park point.
      } else if (err instanceof Paused) {
        // Parked at an agent-round boundary; resume() re-activates the drive.
        this.persist(b);
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

    // Resume-safe: a build re-driven after parking between rounds skips the
    // stages whose output is already on disk and continues where it stopped.
    const onDisk = new Set((await listSiteFiles(this.deps.sitesRoot, b.id)).map((e) => e.path));

    if (!onDisk.has('styles.css')) {
      b.currentRole = 'design';
      this.activity(b, 'design', 'active', 'writing styles.css');
      try {
        await this.agentLoop(b, 'design', {
          prompt: designPrompt(this.roleContext(b)),
          kickoff: 'Write the complete styles.css now, then finish.',
          provider,
          maxTurns: 6,
          requiredFiles: ['styles.css'],
        });
        this.activity(b, 'design', 'done');
      } finally {
        b.currentRole = undefined;
      }
    }

    this.throwIfStopped(b);
    this.throwIfPaused(b);
    const pair: Array<{ role: 'copy' | 'builder'; run: Promise<void> }> = [];
    // Multipage builds: every planned page is a copy deliverable, not just
    // index.html — otherwise the loop exits after the first page lands and
    // the nav links point at files that never get written.
    const pages = b.plan !== undefined ? planPages(b.plan) : [];
    const copyTargets = pages.length > 1 ? pages.filter((p) => !onDisk.has(p)) : [];
    if (copyTargets.length > 0) {
      this.activity(b, 'copy', 'active', `writing ${copyTargets.length} page(s)`);
      pair.push({
        role: 'copy',
        run: (async () => {
          b.currentRole = 'copy';
          try {
            await this.agentLoop(b, 'copy', {
              prompt: copyPrompt(this.roleContext(b)),
              kickoff: `Write every planned page now (${copyTargets.join(', ')}), one complete file per page, then finish.`,
              provider,
              maxTurns: 8 + copyTargets.length * 2,
              requiredFiles: copyTargets,
            });
          } finally {
            b.currentRole = undefined;
          }
        })(),
      });
    } else if (!onDisk.has('index.html')) {
      this.activity(b, 'copy', 'active', 'writing index.html');
      pair.push({
        role: 'copy',
        run: (async () => {
          b.currentRole = 'copy';
          try {
            await this.agentLoop(b, 'copy', {
              prompt: copyPrompt(this.roleContext(b)),
              kickoff: 'Write the complete index.html now, then finish.',
              provider,
              maxTurns: 8,
              requiredFiles: ['index.html'],
            });
          } finally {
            b.currentRole = undefined;
          }
        })(),
      });
    }
    if (!onDisk.has('app.js')) {
      this.activity(b, 'builder', 'active', 'writing app.js');
      pair.push({
        role: 'builder',
        run: (async () => {
          b.currentRole = 'builder';
          try {
            await this.agentLoop(b, 'builder', {
              prompt: builderPrompt(this.roleContext(b)),
              kickoff: 'Write the complete app.js now, then finish.',
              provider,
              maxTurns: 10,
              requiredFiles: ['app.js'],
            });
          } finally {
            b.currentRole = undefined;
          }
        })(),
      });
    }
    const pairResults = await Promise.allSettled(pair.map((p) => p.run));
    this.throwIfStopped(b);
    this.throwIfPaused(b);
    for (const [i, result] of pairResults.entries()) {
      const p = pair[i];
      if (p === undefined) continue;
      if (result.status === 'fulfilled') this.activity(b, p.role, 'done');
      else {
        this.activity(b, p.role, 'error', errMsg(result.reason));
        throw result.reason;
      }
    }
    const written = new Set((await listSiteFiles(this.deps.sitesRoot, b.id)).map((e) => e.path));
    const remaining = planFiles(plan).filter((f) => !written.has(f));
    if (remaining.length > 0) {
      this.throwIfStopped(b);
      this.throwIfPaused(b);
      b.currentRole = 'builder';
      // Fan-out: big plans split the remaining work into two parallel builder
      // rounds over contiguous plan-ordered groups, so each round's file
      // events keep plan order within the group (syncFiles sorts per sync).
      const groups = partitionRemaining(plan, remaining);
      try {
        if (groups.length === 1) {
          const group = groups[0] ?? remaining;
          this.activity(b, 'builder', 'active', `writing remaining files: ${group.join(', ')}`);
          await this.agentLoop(b, 'builder', {
            prompt: builderPrompt({ ...this.roleContext(b), remainingFiles: group }),
            kickoff: `Write the remaining planned files now: ${group.join(', ')}`,
            provider,
            maxTurns: 6,
            bestEffort: true,
            targetFiles: new Set(group),
          });
          this.activity(b, 'builder', 'done');
        } else {
          for (const group of groups) {
            this.activity(b, 'builder', 'active', `writing remaining files: ${group.join(', ')}`);
          }
          const results = await Promise.allSettled(
            groups.map((group) =>
              this.agentLoop(b, 'builder', {
                prompt: builderPrompt({ ...this.roleContext(b), remainingFiles: group }),
                kickoff: `Write the remaining planned files now: ${group.join(', ')}`,
                provider,
                maxTurns: 6,
                bestEffort: true,
                targetFiles: new Set(group),
              }),
            ),
          );
          this.throwIfStopped(b);
          this.throwIfPaused(b);
          for (const result of results) {
            if (result.status === 'fulfilled') this.activity(b, 'builder', 'done');
            else {
              if (result.reason instanceof Paused || result.reason instanceof BuildStopped) throw result.reason;
              this.activity(b, 'builder', 'error', errMsg(result.reason));
              throw result.reason;
            }
          }
        }
      } finally {
        b.currentRole = undefined;
      }
      const skipped = remaining.filter((f) => !b.files.some((x) => x.path === f));
      if (skipped.length > 0) {
        this.pushMessage(b, {
          role: 'system',
          text: `The builder did not produce: ${skipped.join(', ')} — continuing without them.`,
        });
      }
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
      this.throwIfPaused(b);
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
      // The fix pass consumed the findings; a finished build must not keep
      // rendering them as open issues.
      b.issues = undefined;
      this.emit(b, { type: 'review', issues: [] });
    }

    b.siteUrl = `${this.previewBase}/${encodeURIComponent(b.id)}/`;
    this.pushMessage(b, { role: 'system', text: 'Build complete — the preview is live.' });
    await this.scanEnvNotes(b);
    await this.snapshotCheckpoint(b, 'initial build');
    // A pause requested during the final I/O window is moot — the work is
    // done; completing with paused:true would wedge resume/pause/edit.
    b.paused = false;
    this.setPhase(b, 'DONE');
    this.emit(b, { type: 'done', siteUrl: b.siteUrl });
    this.persist(b);
    this.deps.hub.drop?.(b.id);
  }

  /** Env-reference scan at DONE: never fails a build, only reports. */
  private async scanEnvNotes(b: BuildRecord): Promise<void> {
    try {
      b.envNotes = await scanSiteEnv(this.deps.sitesRoot, b.id);
      this.emit(b, { type: 'env', report: b.envNotes });
    } catch (err) {
      console.error(`env scan failed for build ${b.id}:`, err);
    }
  }

  /** Checkpoint snapshot (initial build / edit / fix): best-effort. */
  private async snapshotCheckpoint(b: BuildRecord, label: string): Promise<void> {
    if (this.deps.checkpoints === undefined) return;
    try {
      await this.deps.checkpoints.snapshot(b.id, label.slice(0, 200));
    } catch (err) {
      console.error(`checkpoint snapshot failed for build ${b.id}:`, err);
    }
  }

  /* ------------------------------------------------------------ */
  /* follow-up edits and error fixes (EDITING)                     */
  /* ------------------------------------------------------------ */

  private async runEditing(b: BuildRecord, provider: Provider): Promise<void> {
    const work = b.pendingWork;
    if (work === undefined) {
      // Only reachable if the work item was lost; never pretend an edit ran.
      this.pushMessage(b, {
        role: 'system',
        text: 'The edit request was lost before it could run — no changes were made.',
      });
      this.setPhase(b, 'DONE');
      this.emit(b, { type: 'done', siteUrl: this.siteUrlFor(b) });
      this.persist(b);
      return;
    }
    try {
      if (work.kind === 'fix') await this.runFixRound(b, provider, work);
      else await this.runEditRound(b, provider, work.instruction);
      b.pendingWork = undefined;
    } catch (err) {
      // Paused keeps the work item so resume() restarts the round; stops and
      // cancels propagate to drive()'s own handling.
      if (err instanceof Paused || err instanceof Parked || isAbortLike(err) || b.phase === 'CANCELLED') throw err;
      b.pendingWork = undefined;
      // A failed edit must not kill a working site: report it honestly and
      // hand the build back to DONE with the previous version still live.
      const message = errMsg(err);
      b.currentRole = undefined;
      this.activity(b, 'builder', 'error', message);
      this.pushMessage(b, {
        role: 'system',
        text: `The edit failed: ${message} — the previous version is still live.`,
      });
      this.setPhase(b, 'DONE');
      this.emit(b, { type: 'done', siteUrl: this.siteUrlFor(b) });
    }
    this.persist(b);
    this.deps.hub.drop?.(b.id);
  }

  private async runEditRound(b: BuildRecord, provider: Provider, instruction: string): Promise<void> {
    const selected = selectEditFiles(this.planOrderedFiles(b), instruction, MAX_EDIT_FILES);
    const loaded: SiteFileContent[] = [];
    for (const p of selected) {
      try {
        loaded.push({ path: p, content: (await readSiteFile(this.deps.sitesRoot, b.id, p)).toString('utf8') });
      } catch {
        // Vanished between listing and reading; the builder can listFiles itself.
      }
    }
    const before = await this.fileSizeMap(b);
    b.currentRole = 'builder';
    this.activity(b, 'builder', 'active', `editing: ${truncateNote(instruction)}`);
    try {
      await this.agentLoop(b, 'builder', {
        prompt: targetedEditPrompt(b.brief, instruction, loaded),
        kickoff: `Apply this edit now: ${instruction} — rewrite only the files that change, then finish.`,
        provider,
        maxTurns: 8,
        bestEffort: true,
      });
    } finally {
      b.currentRole = undefined;
    }
    this.throwIfStopped(b);
    this.throwIfPaused(b);
    this.activity(b, 'builder', 'done');
    const touched = await this.changedFilePaths(b, before);
    if (touched.length === 0) {
      this.pushMessage(b, { role: 'system', text: 'The edit did not change any files.' });
    } else {
      this.pushMessage(b, { role: 'system', text: `Edit applied — changed: ${touched.join(', ')}.` });
    }
    if (touched.length > 3) {
      // A wide-reaching edit gets a fresh review pass and a fix pass on
      // findings. The phase stays EDITING throughout so resume() dispatches
      // correctly; the reviewer shows up through its activity events.
      b.currentRole = 'reviewer';
      this.activity(b, 'reviewer', 'active', 'reviewing the edit');
      try {
        await this.agentLoop(b, 'reviewer', {
          prompt: reviewerPrompt(this.roleContext(b)),
          kickoff: 'Review the edited site now: listFiles, read every file, then reviewNotes and finish.',
          provider,
          maxTurns: 10,
          requireReviewNotes: true,
        });
      } finally {
        b.currentRole = undefined;
      }
      this.activity(b, 'reviewer', 'done');
      this.throwIfStopped(b);
      this.throwIfPaused(b);
      const issues = b.issues ?? [];
      if (issues.length > 0) {
        b.currentRole = 'builder';
        this.activity(b, 'builder', 'active', `fixing ${issues.length} review issue(s)`);
        try {
          await this.agentLoop(b, 'builder', {
            prompt: builderPrompt({ ...this.roleContext(b), issues }),
            kickoff: 'Fix the review issues now: rewrite each affected file completely, then finish.',
            provider,
            maxTurns: 10,
            bestEffort: true,
            completeOnAnyWrite: true,
          });
        } finally {
          b.currentRole = undefined;
        }
        this.activity(b, 'builder', 'done');
        b.issues = undefined;
        this.emit(b, { type: 'review', issues: [] });
      }
    }
    this.emit(b, {
      type: 'checkpoint',
      checkpoint: { kind: 'edit', instruction, files: touched, at: this.now() },
    });
    await this.snapshotCheckpoint(b, `edit: ${instruction}`);
    if (touched.length > 0) {
      this.pushMessage(b, { role: 'system', text: 'Edit complete — the preview is up to date.' });
    }
    b.paused = false;
    this.setPhase(b, 'DONE');
    this.emit(b, { type: 'done', siteUrl: this.siteUrlFor(b) });
  }

  private async runFixRound(
    b: BuildRecord,
    provider: Provider,
    work: { kind: 'fix'; message: string; file?: string; line?: number },
  ): Promise<void> {
    const parsed = parseErrorLocation(work.message, b.files.map((f) => f.path));
    let file = work.file ?? parsed.file;
    if (file !== undefined && !b.files.some((f) => f.path === file)) file = undefined;
    const line = work.line ?? parsed.line;
    // Console errors are most often script errors; prefer app.js over nothing.
    if (file === undefined && b.files.some((f) => f.path === 'app.js')) file = 'app.js';
    let content: string | undefined;
    if (file !== undefined) {
      try {
        content = (await readSiteFile(this.deps.sitesRoot, b.id, file)).toString('utf8');
      } catch {
        content = undefined; // vanished; the builder can readFile/listFiles itself
      }
    }
    const where = file !== undefined ? ` in ${file}${line !== undefined ? `:${line}` : ''}` : '';
    const before = await this.fileSizeMap(b);
    b.currentRole = 'builder';
    this.activity(b, 'builder', 'active', `fixing the reported error${where}`);
    try {
      const errorInput: FixErrorInput = { message: work.message };
      if (file !== undefined) errorInput.file = file;
      if (line !== undefined) errorInput.line = line;
      const implicated: SiteFileContent[] = file !== undefined && content !== undefined ? [{ path: file, content }] : [];
      await this.agentLoop(b, 'builder', {
        prompt: fixErrorPrompt(b.brief, errorInput, implicated),
        kickoff: `Fix this site error now${where}: ${work.message}`,
        provider,
        maxTurns: 6,
        bestEffort: true,
        completeOnAnyWrite: true,
      });
    } finally {
      b.currentRole = undefined;
    }
    this.throwIfStopped(b);
    this.throwIfPaused(b);
    const touched = await this.changedFilePaths(b, before);
    if (touched.length === 0) {
      this.activity(b, 'builder', 'done', 'no file changes');
      this.pushMessage(b, { role: 'system', text: 'The builder did not change any files for this error.' });
    } else {
      this.activity(b, 'builder', 'done', `fixed${where}: ${touched.join(', ')}`);
      this.pushMessage(b, { role: 'system', text: `Fix applied — changed: ${touched.join(', ')}.` });
    }
    this.emit(b, {
      type: 'checkpoint',
      checkpoint: { kind: 'fix', message: work.message, files: touched, at: this.now() },
    });
    await this.snapshotCheckpoint(b, `fix: ${work.message}`);
    b.paused = false;
    this.setPhase(b, 'DONE');
    this.emit(b, { type: 'done', siteUrl: this.siteUrlFor(b) });
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
    // Emit in plan order so files appear the way the plan announced them;
    // files outside the plan fall back to alphabetical after the planned ones.
    const planned = b.plan !== undefined ? planFiles(b.plan) : [];
    const rank = (p: string): number => {
      const i = planned.indexOf(p);
      return i === -1 ? planned.length : i;
    };
    changed.sort((x, y) => rank(x.path) - rank(y.path) || x.path.localeCompare(y.path));
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
    // Streamed prose is coalesced into ~120ms / 400-char SSE frames so a
    // chatty provider cannot flood the channel one token at a time.
    let deltaBuf = '';
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = (): void => {
      if (deltaBuf === '') return;
      const text = deltaBuf;
      deltaBuf = '';
      this.emit(b, { type: 'delta', role, text });
    };
    const onRuntimeEvent = (ev: AgentEvent): void => {
      if (ev.type === 'delta') {
        deltaBuf += ev.text;
        if (deltaBuf.length >= 400) {
          if (deltaTimer !== null) {
            clearTimeout(deltaTimer);
            deltaTimer = null;
          }
          flushDelta();
        } else if (deltaTimer === null) {
          deltaTimer = setTimeout(() => {
            deltaTimer = null;
            flushDelta();
          }, 120);
          // A pending flush must never pin the process or a test's event loop.
          if (typeof deltaTimer === 'object' && 'unref' in deltaTimer) deltaTimer.unref();
        }
      } else if (ev.type === 'writing') {
        this.activity(b, role, 'active', `Writing ${ev.path}`);
      }
    };
    try {
      for (;;) {
        turn += 1;
        if (turn > opts.maxTurns) {
          if (opts.bestEffort) return;
          throw new Error(`${role} did not finish its job within ${opts.maxTurns} replies`);
        }
        this.throwIfStopped(b);
        this.throwIfPaused(b);
        const signal = b.abort?.signal;
        const result = await runtime.run(messages, {
          ...(signal !== undefined ? { signal } : {}),
          maxIterations: 1,
          onEvent: onRuntimeEvent,
        });
        if (deltaTimer !== null) {
          clearTimeout(deltaTimer);
          deltaTimer = null;
        }
        flushDelta();
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
            if (b.autopilot) {
              for (const q of [first, ...b.questionQueue]) {
                const entry = b.qaLog.find((e) => e.question.id === q.id && e.answer === undefined);
                if (entry !== undefined) entry.answer = AUTOPILOT_ANSWER;
              }
              b.questionQueue = [];
              b.pendingQuestion = undefined;
              this.pushMessage(b, { role: 'user', text: AUTOPILOT_ANSWER });
              this.pushMessage(b, { role: 'system', text: 'Autopilot answered on your behalf.' });
              this.persist(b);
              messages.push({ role: 'user', content: AUTOPILOT_ANSWER });
              continue;
            }
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
          if (b.autopilot) {
            // Hands-free: approve in place and let the drive flow into the
            // build stages without parking for a click.
            this.pushMessage(b, { role: 'system', text: 'Plan auto-approved — build started.' });
            this.setPhase(b, 'BUILDING');
            this.activity(b, 'planner', 'done');
            this.persist(b);
            return;
          }
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
    } finally {
      if (deltaTimer !== null) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
      flushDelta();
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

  private siteUrlFor(b: BuildRecord): string {
    return b.siteUrl ?? `${this.previewBase}/${encodeURIComponent(b.id)}/`;
  }

  private async fileSizeMap(b: BuildRecord): Promise<Map<string, number>> {
    const entries = await listSiteFiles(this.deps.sitesRoot, b.id);
    return new Map(entries.map((e) => [e.path, e.size]));
  }

  /** Recorded files ordered the way syncFiles emits them: plan order, then alphabetical. */
  private planOrderedFiles(b: BuildRecord): string[] {
    const planned = b.plan !== undefined ? planFiles(b.plan) : [];
    const rank = (p: string): number => {
      const i = planned.indexOf(p);
      return i === -1 ? planned.length : i;
    };
    return b.files.map((f) => f.path).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  }

  /**
   * Paths created or size-changed since `before`, in plan order. A same-size
   * rewrite is invisible here, exactly as in syncFiles' event diffing.
   */
  private async changedFilePaths(b: BuildRecord, before: Map<string, number>): Promise<string[]> {
    const entries = await listSiteFiles(this.deps.sitesRoot, b.id);
    const planned = b.plan !== undefined ? planFiles(b.plan) : [];
    const rank = (p: string): number => {
      const i = planned.indexOf(p);
      return i === -1 ? planned.length : i;
    };
    return entries
      .filter((e) => before.get(e.path) !== e.size)
      .map((e) => e.path)
      .sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  }

  private mustGet(id: string): BuildRecord {
    const b = this.builds.get(id);
    if (b === undefined) throw new ApiError(404, `unknown build id: ${id}`);
    return b;
  }

  private throwIfStopped(b: BuildRecord): void {
    if (b.abort?.signal.aborted === true || b.phase === 'CANCELLED') throw new BuildStopped();
  }

  /** Round-boundary check: parks the drive when pause() has been requested. */
  private throwIfPaused(b: BuildRecord): void {
    if (b.paused) throw new Paused();
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
      paused: b.paused,
      autopilot: b.autopilot,
      messages: b.messages.map((m) => ({ ...m })),
      files: b.files.map((f) => ({ ...f })),
      ...(b.pendingQuestion !== undefined ? { pendingQuestion: b.pendingQuestion } : {}),
      ...(b.plan !== undefined ? { plan: toClientPlan(b.plan) } : {}),
      ...(b.issues !== undefined ? { issues: b.issues.map((i) => ({ ...i })) } : {}),
      ...(b.siteUrl !== undefined ? { siteUrl: b.siteUrl } : {}),
      ...(b.error !== undefined ? { error: b.error } : {}),
      ...(b.envNotes !== undefined ? { envNotes: b.envNotes } : {}),
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
      ...(b.envNotes !== undefined ? { envNotes: b.envNotes } : {}),
      questionRounds: b.questionRounds,
      ...(b.paused ? { paused: true } : {}),
      ...(b.autopilot ? { autopilot: true } : {}),
      ...(b.pendingWork !== undefined ? { pendingWork: b.pendingWork } : {}),
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
      envNotes:
        s.envNotes && typeof s.envNotes === 'object' && !Array.isArray(s.envNotes)
          ? s.envNotes
          : undefined,
      questionRounds: typeof s.questionRounds === 'number' ? s.questionRounds : 0,
      paused: s.paused === true,
      autopilot: s.autopilot === true,
      pendingWork: revivePendingWork(s.pendingWork),
      abort: undefined,
      running: false,
      queued: false,
      currentRole: undefined,
      settleWaiters: [],
      writeChain: Promise.resolve(),
    };
  }
}
