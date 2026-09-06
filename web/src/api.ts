import type {
  ActivityEvent,
  BuildEvent,
  BuildState,
  BuildSummary,
  ChatMessage,
  PendingQuestion,
  Phase,
  Plan,
  PlanStep,
  ReviewIssue,
  RoleState,
  ServerConfig,
  SiteFile,
  StreamStatus,
} from './types';
import { PHASES } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Foundry server.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body: unknown = await res.json();
      const err = rec(body)?.error;
      if (typeof err === 'string' && err) message = err;
    } catch {
      /* non-JSON error body — keep the status-based message */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Payload normalization: the contract fixes event/field names, but    */
/* payloads may arrive flat or nested — normalize generously, never    */
/* invent data.                                                        */
/* ------------------------------------------------------------------ */

function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normPhase(v: unknown): Phase {
  const s = str(v)?.toUpperCase();
  if (s && (PHASES as readonly string[]).includes(s)) return s as Phase;
  return 'INTAKE';
}

function normMessage(v: unknown): ChatMessage | null {
  const m = rec(v);
  if (!m) return null;
  const text = str(m.text) ?? str(m.content) ?? str(m.message);
  if (!text) return null;
  const role = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent';
  const msg: ChatMessage = { role, text };
  const agent = str(m.agent) ?? str(m.from);
  if (agent) msg.agent = agent;
  const ts = num(m.ts) ?? num(m.at) ?? num(m.time);
  if (ts) msg.ts = ts;
  return msg;
}

function normQuestion(v: unknown): PendingQuestion | null {
  const q = rec(v);
  if (!q) return null;
  const text = str(q.text) ?? str(q.question);
  const id = str(q.id) ?? str(q.questionId);
  if (!text || !id) return null;
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const options = rawOptions
    .map((o) => {
      if (typeof o === 'string') return { label: o };
      const ro = rec(o);
      const label = ro ? str(ro.label) ?? str(ro.text) ?? str(ro.title) : undefined;
      if (!label) return null;
      const oid = ro ? str(ro.id) ?? str(ro.value) : undefined;
      return oid ? { label, id: oid } : { label };
    })
    .filter((o): o is { label: string; id?: string } => o !== null);
  return { id, text, options };
}

function normPlan(v: unknown): Plan | null {
  const p = rec(v);
  if (!p) return null;
  const summary = str(p.summary) ?? str(p.description) ?? str(p.title);
  if (!summary) return null;
  const rawSteps = Array.isArray(p.steps) ? p.steps : [];
  const steps: PlanStep[] = rawSteps
    .map((s) => {
      if (typeof s === 'string') return { title: s, files: [], done: false };
      const rs = rec(s);
      if (!rs) return null;
      const title = str(rs.title) ?? str(rs.name) ?? str(rs.step);
      if (!title) return null;
      const files = Array.isArray(rs.files) ? rs.files.filter((f): f is string => typeof f === 'string') : [];
      return { title, files, done: rs.done === true };
    })
    .filter((s): s is PlanStep => s !== null);
  const plan: Plan = { summary, steps };
  const design = str(p.designDirection) ?? str(p.design) ?? str(p.direction);
  if (design) plan.designDirection = design;
  return plan;
}

function normFile(v: unknown): SiteFile | null {
  const f = rec(v);
  if (!f) return null;
  const path = str(f.path) ?? str(f.file) ?? str(f.name);
  if (!path) return null;
  const file: SiteFile = { path };
  const bytes = num(f.bytes) ?? num(f.size);
  if (bytes !== undefined) file.bytes = bytes;
  const content = str(f.content);
  if (content !== undefined) file.content = content;
  return file;
}

function normIssue(v: unknown): ReviewIssue | null {
  if (typeof v === 'string') return { severity: 'info', text: v };
  const i = rec(v);
  if (!i) return null;
  const text = str(i.text) ?? str(i.message) ?? str(i.note);
  if (!text) return null;
  const sev = str(i.severity) ?? str(i.level);
  const issue: ReviewIssue = {
    severity: sev === 'error' ? 'error' : sev === 'warn' || sev === 'warning' ? 'warn' : 'info',
    text,
  };
  const file = str(i.file) ?? str(i.path);
  if (file) issue.file = file;
  return issue;
}

function normActivity(v: unknown): ActivityEvent | null {
  const a = rec(v);
  if (!a) return null;
  const role = str(a.role) ?? str(a.agent) ?? str(a.name);
  if (!role) return null;
  const raw = str(a.state) ?? str(a.status) ?? 'active';
  const state: RoleState =
    raw === 'done' ? 'done' : raw === 'error' || raw === 'failed' ? 'error' : raw === 'idle' ? 'idle' : 'active';
  const ev: ActivityEvent = { role, state };
  const note = str(a.note) ?? str(a.text) ?? str(a.message);
  if (note) ev.note = note;
  return ev;
}

export function normalizeEvent(raw: unknown): BuildEvent | null {
  const e = rec(raw);
  if (!e) return null;
  const type = str(e.type);
  switch (type) {
    case 'phase': {
      const phase = normPhase(e.phase ?? e.value);
      return { type: 'phase', phase };
    }
    case 'message': {
      const message = normMessage(e.message ?? e);
      return message ? { type: 'message', message } : null;
    }
    case 'question': {
      const question = normQuestion(e.question ?? e);
      return question ? { type: 'question', question } : null;
    }
    case 'plan': {
      const plan = normPlan(e.plan ?? e);
      return plan ? { type: 'plan', plan } : null;
    }
    case 'file': {
      const file = normFile(e.file ?? e);
      return file ? { type: 'file', file } : null;
    }
    case 'activity': {
      const activity = normActivity(e.activity ?? e);
      return activity ? { type: 'activity', activity } : null;
    }
    case 'review': {
      const list = Array.isArray(e.issues) ? e.issues : e.issue !== undefined ? [e.issue] : [e];
      const issues = list.map(normIssue).filter((i): i is ReviewIssue => i !== null);
      return issues.length ? { type: 'review', issues } : null;
    }
    case 'done': {
      const siteUrl = str(e.siteUrl) ?? str(e.url);
      return siteUrl ? { type: 'done', siteUrl } : { type: 'done' };
    }
    case 'error': {
      return { type: 'error', error: str(e.error) ?? str(e.message) ?? 'Build failed.' };
    }
    default:
      return null;
  }
}

function normState(raw: unknown, id: string): BuildState {
  const s = rec(raw) ?? {};
  const messages = (Array.isArray(s.messages) ? s.messages : [])
    .map(normMessage)
    .filter((m): m is ChatMessage => m !== null);
  const files = (Array.isArray(s.files) ? s.files : [])
    .map(normFile)
    .filter((f): f is SiteFile => f !== null);
  const issues = (Array.isArray(s.issues) ? s.issues : [])
    .map(normIssue)
    .filter((i): i is ReviewIssue => i !== null);
  const state: BuildState = {
    id: str(s.id) ?? id,
    phase: normPhase(s.phase),
    brief: str(s.brief) ?? '',
    messages,
    files,
    issues,
  };
  const question = normQuestion(s.pendingQuestion ?? s.question);
  if (question) state.pendingQuestion = question;
  const plan = normPlan(s.plan);
  if (plan) state.plan = plan;
  const siteUrl = str(s.siteUrl) ?? str(s.url);
  if (siteUrl) state.siteUrl = siteUrl;
  const error = str(s.error);
  if (error) state.error = error;
  const createdAt = num(s.createdAt) ?? num(s.created);
  if (createdAt) state.createdAt = createdAt;
  return state;
}

function normSummary(raw: unknown): BuildSummary | null {
  const s = rec(raw);
  if (!s) return null;
  const id = str(s.id);
  if (!id) return null;
  const out: BuildSummary = { id, phase: normPhase(s.phase), brief: str(s.brief) ?? '' };
  const createdAt = num(s.createdAt) ?? num(s.created);
  if (createdAt) out.createdAt = createdAt;
  return out;
}

/* ------------------------------------------------------------------ */
/* REST wrappers                                                       */
/* ------------------------------------------------------------------ */

export function getConfig(): Promise<ServerConfig> {
  return request<ServerConfig>('/api/config');
}

export function putConfig(cfg: {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
}): Promise<unknown> {
  return request('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
}

export async function createBuild(brief: string): Promise<{ id: string }> {
  const raw = await request<unknown>('/api/builds', { method: 'POST', body: JSON.stringify({ brief }) });
  const id = str(rec(raw)?.id);
  if (!id) throw new ApiError(0, 'Server accepted the build but returned no id.');
  return { id };
}

export async function listBuilds(): Promise<BuildSummary[]> {
  const raw = await request<unknown>('/api/builds');
  const list = Array.isArray(raw) ? raw : Array.isArray(rec(raw)?.builds) ? (rec(raw)?.builds as unknown[]) : [];
  return list.map(normSummary).filter((b): b is BuildSummary => b !== null);
}

export async function getBuild(id: string): Promise<BuildState> {
  const raw = await request<unknown>(`/api/builds/${encodeURIComponent(id)}`);
  return normState(rec(raw)?.build ?? raw, id);
}

export function postAnswer(id: string, questionId: string, answer: string): Promise<unknown> {
  return request(`/api/builds/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ questionId, answer }),
  });
}

export function postApprove(id: string, plan?: Plan): Promise<unknown> {
  return request(`/api/builds/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(plan ? { plan } : {}),
  });
}

export function postCancel(id: string): Promise<unknown> {
  return request(`/api/builds/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
}

export function previewUrl(id: string, siteUrl?: string): string {
  return siteUrl ?? `/preview/${encodeURIComponent(id)}/`;
}

export function downloadUrl(id: string): string {
  return `/api/builds/${encodeURIComponent(id)}/download`;
}

/* ------------------------------------------------------------------ */
/* SSE stream: EventSource with capped auto-reconnect (3 attempts),    */
/* then an honest 'lost' state the user can retry manually.            */
/* ------------------------------------------------------------------ */

export interface StreamHandle {
  close(): void;
  retry(): void;
}

const EVENT_TYPES = ['phase', 'message', 'question', 'plan', 'file', 'activity', 'review', 'done', 'error'] as const;

export function openBuildEvents(
  id: string,
  onEvent: (ev: BuildEvent) => void,
  onStatus: (status: StreamStatus) => void,
): StreamHandle {
  const MAX_RETRIES = 3;
  let failures = 0;
  let es: EventSource | null = null;
  let closed = false;
  let terminal = false;
  let timer: number | undefined;

  function dispatch(data: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const ev = normalizeEvent(parsed);
    if (!ev) return;
    if (ev.type === 'done' || ev.type === 'error') terminal = true;
    onEvent(ev);
    if (terminal) {
      // The build reached a terminal event; the server will close the
      // socket — close on our side so we do not reconnect pointlessly.
      closed = true;
      es?.close();
      es = null;
      onStatus('idle');
    }
  }

  function connect() {
    if (closed) return;
    onStatus(failures === 0 ? 'connecting' : 'reconnecting');
    es = new EventSource(`/api/builds/${encodeURIComponent(id)}/events`);
    es.onopen = () => {
      failures = 0;
      onStatus('live');
    };
    es.onmessage = (e) => dispatch(e.data);
    for (const t of EVENT_TYPES) {
      es.addEventListener(t, (e) => dispatch((e as MessageEvent).data));
    }
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed || terminal) return;
      failures += 1;
      if (failures > MAX_RETRIES) {
        onStatus('lost');
        return;
      }
      onStatus('reconnecting');
      timer = window.setTimeout(connect, 800 * failures);
    };
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      es?.close();
      es = null;
    },
    retry() {
      if (es) return;
      closed = false;
      failures = 0;
      connect();
    },
  };
}
