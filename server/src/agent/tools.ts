export const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 200;
const READ_RESULT_MAX_CHARS = 64 * 1024;
const MAX_QUESTION_CHARS = 1_000;
const MAX_OPTIONS = 8;
const MAX_STEPS = 20;
const MAX_STEP_FILES = 40;
const MAX_ISSUES = 50;
const SCAN_WORK_BUDGET_MIN = 1_048_576;
const SCAN_WORK_BUDGET_FACTOR = 8;

/**
 * Structural view of the confined site store (the real implementation lives
 * in the core workstream's sites.ts). This layer validates tool arguments
 * before the store ever sees them and turns store failures into result
 * strings the model can read.
 */
export interface SiteStore {
  writeFile(path: string, content: string): void | Promise<void>;
  readFile(path: string): string | Promise<string>;
  listFiles(): string[] | Promise<string[]>;
}

export interface RawToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ExtractResult {
  calls: RawToolCall[];
  notes: string[];
  text: string;
}

export interface Question {
  id: string;
  question: string;
  options: string[];
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  files: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type Severity = 'info' | 'warn' | 'error';

export interface ReviewIssue {
  severity: Severity;
  file?: string;
  detail: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Validation<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Validation<T> {
  return { ok: false, error };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validatePath(input: unknown): Validation<string> {
  if (typeof input !== 'string' || input.length === 0) {
    return fail('path must be a non-empty string');
  }
  if (input.length > MAX_PATH_CHARS) return fail(`path is too long (max ${MAX_PATH_CHARS} chars)`);
  if (/[\x00-\x1f]/.test(input)) return fail('path contains control characters');
  if (input.includes('\\')) return fail('path must use POSIX separators ("/" not "\\")');
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) return fail('absolute paths are not allowed');
  for (const segment of input.split('/')) {
    if (segment === '') return fail('path contains an empty segment');
    if (segment === '.') return fail('path contains a "." segment');
    if (segment === '..') return fail('path escapes site root');
  }
  return ok(input);
}

function shortQuestionId(question: string): string {
  let h = 5381;
  for (let i = 0; i < question.length; i += 1) {
    h = ((h << 5) + h + question.charCodeAt(i)) >>> 0;
  }
  return 'q-' + h.toString(36);
}

export function validateWriteFileArgs(args: Record<string, unknown>): Validation<{ path: string; content: string }> {
  const path = validatePath(args.path);
  if (!path.ok) return fail(path.error);
  if (typeof args.content !== 'string') return fail('content must be a string');
  const bytes = Buffer.byteLength(args.content, 'utf8');
  if (bytes > MAX_FILE_BYTES) return fail(`content exceeds the ${MAX_FILE_BYTES / 1024}KB per-file limit`);
  return ok({ path: path.value, content: args.content });
}

export function validateAskArgs(args: Record<string, unknown>): Validation<Question> {
  if (typeof args.question !== 'string' || args.question.trim() === '') {
    return fail('question must be a non-empty string');
  }
  if (args.question.length > MAX_QUESTION_CHARS) return fail(`question is too long (max ${MAX_QUESTION_CHARS} chars)`);
  let options: string[] = [];
  if (args.options !== undefined) {
    if (!Array.isArray(args.options) || args.options.length > MAX_OPTIONS) {
      return fail(`options must be an array of at most ${MAX_OPTIONS} strings`);
    }
    for (const opt of args.options) {
      if (typeof opt !== 'string' || opt.trim() === '') return fail('options must be non-empty strings');
    }
    options = args.options as string[];
  }
  let id: string;
  if (args.id !== undefined) {
    if (typeof args.id !== 'string' || args.id.trim() === '') return fail('id must be a non-empty string');
    id = args.id;
  } else {
    id = shortQuestionId(args.question);
  }
  return ok({ id, question: args.question, options });
}

export function validatePlanArgs(args: Record<string, unknown>): Validation<Plan> {
  if (typeof args.summary !== 'string' || args.summary.trim() === '') {
    return fail('summary must be a non-empty string');
  }
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return fail('steps must be a non-empty array');
  }
  if (args.steps.length > MAX_STEPS) return fail(`plans are limited to ${MAX_STEPS} steps`);
  const steps: PlanStep[] = [];
  for (const raw of args.steps) {
    if (!isRecord(raw)) return fail('each step must be an object');
    if (typeof raw.id !== 'string' || raw.id.trim() === '') return fail('each step needs a non-empty id');
    if (typeof raw.title !== 'string' || raw.title.trim() === '') return fail(`step ${raw.id} needs a non-empty title`);
    if (raw.detail !== undefined && typeof raw.detail !== 'string') return fail(`step ${raw.id} detail must be a string`);
    let files: string[] = [];
    if (raw.files !== undefined) {
      if (!Array.isArray(raw.files) || raw.files.length > MAX_STEP_FILES) {
        return fail(`step ${raw.id} files must be an array of at most ${MAX_STEP_FILES} paths`);
      }
      for (const f of raw.files) {
        const p = validatePath(f);
        if (!p.ok) return fail(`step ${raw.id} files: ${p.error}`);
      }
      files = raw.files as string[];
    }
    steps.push({ id: raw.id, title: raw.title, detail: raw.detail ?? '', files });
  }
  return ok({ summary: args.summary, steps });
}

export function validateReviewNotesArgs(args: Record<string, unknown>): Validation<ReviewIssue[]> {
  if (!Array.isArray(args.issues)) return fail('issues must be an array');
  if (args.issues.length > MAX_ISSUES) return fail(`review notes are limited to ${MAX_ISSUES} issues`);
  const issues: ReviewIssue[] = [];
  for (const raw of args.issues) {
    if (!isRecord(raw)) return fail('each issue must be an object');
    if (typeof raw.severity !== 'string') return fail('each issue needs a severity');
    const sev = raw.severity === 'warning' ? 'warn' : raw.severity;
    if (sev !== 'info' && sev !== 'warn' && sev !== 'error') {
      return fail(`severity must be info, warn or error (got "${raw.severity}")`);
    }
    if (typeof raw.detail !== 'string' || raw.detail.trim() === '') return fail('each issue needs a non-empty detail');
    let file: string | undefined;
    if (raw.file !== undefined) {
      const p = validatePath(raw.file);
      if (!p.ok) return fail(`issue file: ${p.error}`);
      file = p.value;
    }
    issues.push(file !== undefined ? { severity: sev, file, detail: raw.detail } : { severity: sev, detail: raw.detail });
  }
  return ok(issues);
}

export function validateFinishArgs(args: Record<string, unknown>): Validation<{ summary: string }> {
  if (args.summary !== undefined && typeof args.summary !== 'string') return fail('summary must be a string');
  return ok({ summary: typeof args.summary === 'string' ? args.summary : '' });
}

export function isFsTool(name: string): boolean {
  return name === 'writeFile' || name === 'readFile' || name === 'listFiles';
}

export function isKnownTool(name: string): boolean {
  return isFsTool(name) || name === 'ask' || name === 'plan' || name === 'reviewNotes' || name === 'finish';
}

/**
 * Execute a filesystem tool against the confined store. Always returns a
 * result string ("ok: ..." or "error: ...") so the model can read failures
 * and correct itself; never throws for bad args or store errors.
 */
export async function executeFsTool(store: SiteStore, call: RawToolCall): Promise<string> {
  try {
    switch (call.name) {
      case 'writeFile': {
        const v = validateWriteFileArgs(call.args);
        if (!v.ok) return `error: ${v.error}`;
        await store.writeFile(v.value.path, v.value.content);
        return `ok: wrote ${v.value.path} (${Buffer.byteLength(v.value.content, 'utf8')} bytes)`;
      }
      case 'readFile': {
        const v = validatePath(call.args.path);
        if (!v.ok) return `error: ${v.error}`;
        const content = await store.readFile(v.value);
        if (typeof content !== 'string') return 'error: store returned a non-string value';
        if (content.length > READ_RESULT_MAX_CHARS) {
          return content.slice(0, READ_RESULT_MAX_CHARS)
            + `\n... (truncated at ${READ_RESULT_MAX_CHARS} chars)`;
        }
        return content;
      }
      case 'listFiles': {
        const files = await store.listFiles();
        if (!Array.isArray(files)) return 'error: store returned a non-array value';
        return files.length > 0 ? files.join('\n') : '(no files yet)';
      }
      default:
        return `error: unknown tool "${call.name}"`;
    }
  } catch (e) {
    return `error: ${errMsg(e)}`;
  }
}

interface Span {
  start: number;
  end: number;
}

// Scan from text[start] (a "{") to just past its matching "}", honoring JSON
// string state. Returns -1 when the braces never balance.
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function toToolCall(parsed: unknown): RawToolCall | null {
  if (!isRecord(parsed)) return null;
  if (typeof parsed.tool !== 'string' || parsed.tool.trim() === '') return null;
  return { name: parsed.tool, args: isRecord(parsed.args) ? parsed.args : {} };
}

// A closing fence only counts at the start of a line, alone up to trailing
// whitespace. An indexOf-anywhere closer truncates payloads whose content
// itself contains triple backticks (markdown files), losing the tool call.
function findClosingFence(text: string, from: number): number {
  let idx = text.indexOf('```', from);
  while (idx !== -1) {
    if (idx > 0 && text[idx - 1] === '\n') {
      let j = idx + 3;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j += 1;
      if (j >= text.length || text[j] === '\n' || text[j] === '\r') return idx;
    }
    idx = text.indexOf('```', idx + 3);
  }
  return -1;
}

export interface WriteFilePayload {
  start: number;
  end: number;
  path: string;
  chars: number;
  args: Record<string, unknown>;
}

/**
 * Locate every {"tool":"writeFile"} JSON object in text, returning each span
 * and its decoded args. Drives transcript compaction in the runtime; the
 * '"tool"' anchor keeps the scan linear even on large messages.
 */
export function findWriteFilePayloads(text: string): WriteFilePayload[] {
  const out: WriteFilePayload[] = [];
  let from = 0;
  for (;;) {
    const anchor = text.indexOf('"tool"', from);
    if (anchor === -1) break;
    let brace = anchor - 1;
    while (brace >= 0 && (text[brace] === ' ' || text[brace] === '\t' || text[brace] === '\n' || text[brace] === '\r')) {
      brace -= 1;
    }
    if (brace < 0 || text[brace] !== '{') {
      from = anchor + 6;
      continue;
    }
    const end = scanBalanced(text, brace);
    if (end === -1) {
      from = anchor + 6;
      continue;
    }
    from = end;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(brace, end));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.tool !== 'writeFile' || !isRecord(parsed.args)) continue;
    if (typeof parsed.args.path !== 'string' || typeof parsed.args.content !== 'string') continue;
    out.push({ start: brace, end, path: parsed.args.path, chars: parsed.args.content.length, args: parsed.args });
  }
  return out;
}

function looksLikeTool(raw: string): boolean {
  return raw.includes('"tool"');
}

function noteFor(raw: string, why: string): string {
  const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `skipped malformed tool JSON (${why}): ${preview}`;
}

/**
 * Extract every {"tool":..., "args":...} object from a model response, whether
 * bare or inside code fences. Returns the calls, one note per skipped
 * malformed block, and the remaining prose with consumed blocks removed.
 */
export function extractToolCalls(response: string): ExtractResult {
  const found: Array<{ pos: number; call: RawToolCall }> = [];
  const notes: string[] = [];
  const removed: Span[] = [];
  const notedFences: Span[] = [];

  const parseCandidate = (raw: string): { call: RawToolCall | null; malformed: boolean } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { call: null, malformed: looksLikeTool(raw) };
    }
    return { call: toToolCall(parsed), malformed: false };
  };

  // Fenced blocks first: a fence whose entire payload is tool JSON is
  // consumed as calls; a fence with mixed content contributes its valid calls
  // (their spans are removed from the prose); a fence containing broken tool
  // JSON gets one note and is then left alone by the bare scan below.
  let scanFrom = 0;
  for (;;) {
    const open = response.indexOf('```', scanFrom);
    if (open === -1) break;
    const close = findClosingFence(response, open + 3);
    if (close === -1) break;
    const fenceInner = response.slice(open + 3, close);
    const firstNl = fenceInner.indexOf('\n');
    const payloadStart = open + 3 + firstNl + 1;
    const payload = firstNl === -1 ? '' : fenceInner.slice(firstNl + 1);
    const local: Array<{ pos: number; call: RawToolCall; span: Span }> = [];
    let consumedAll = payload.trim() !== '';
    let malformed: string | null = null;
    let i = 0;
    while (i < payload.length) {
      const brace = payload.indexOf('{', i);
      if (brace === -1) {
        consumedAll = payload.slice(i).trim() === '';
        break;
      }
      if (payload.slice(i, brace).trim() !== '') {
        consumedAll = false;
        break;
      }
      const end = scanBalanced(payload, brace);
      if (end === -1) {
        consumedAll = false;
        if (looksLikeTool(payload.slice(brace))) malformed = payload.slice(brace);
        break;
      }
      const raw = payload.slice(brace, end);
      const { call, malformed: isMalformed } = parseCandidate(raw);
      if (call) {
        local.push({ pos: payloadStart + brace, call, span: { start: payloadStart + brace, end: payloadStart + end } });
        i = end;
      } else if (isMalformed) {
        consumedAll = false;
        malformed = raw;
        break;
      } else {
        consumedAll = false;
        break;
      }
    }
    if (consumedAll && local.length > 0) {
      found.push(...local);
      removed.push({ start: open, end: close + 3 });
    } else {
      if (local.length > 0) {
        found.push(...local);
        removed.push(...local.map((l) => l.span));
      }
      if (malformed !== null) {
        notes.push(noteFor(malformed, 'invalid JSON'));
        notedFences.push({ start: open, end: close + 3 });
      }
    }
    scanFrom = close + 3;
  }

  // Bare scan over what remains (spans already consumed or noted are skipped).
  const skipSpans = [...removed, ...notedFences].sort((a, b) => a.start - b.start);
  let skipIdx = 0;
  const skipped = (idx: number): boolean => {
    while (skipIdx < skipSpans.length && idx >= skipSpans[skipIdx]!.end) skipIdx += 1;
    const span = skipSpans[skipIdx];
    return span !== undefined && idx >= span.start;
  };
  // Hard cap on total scanBalanced work: without it, repeated rescans of
  // nested unbalanced starts are quadratic (40k braces took ~4s). Scaled to
  // the response so large legit builds keep their headroom.
  const scanBudget = Math.max(SCAN_WORK_BUDGET_MIN, response.length * SCAN_WORK_BUDGET_FACTOR);
  let scanWork = 0;
  for (let i = 0; i < response.length; i += 1) {
    if (response[i] !== '{' || skipped(i)) continue;
    const end = scanBalanced(response, i);
    scanWork += (end === -1 ? response.length : end) - i;
    if (scanWork > scanBudget) {
      notes.push('tool scan stopped early: work budget exceeded on malformed input; later calls may be missed');
      break;
    }
    if (end === -1) {
      if (looksLikeTool(response.slice(i))) {
        notes.push(noteFor(response.slice(i), 'unbalanced braces'));
        // A truncated tool call must never reach the user as raw JSON; drop
        // the tail from the visible prose (scanning continues unaffected).
        removed.push({ start: i, end: response.length });
      }
      continue;
    }
    const raw = response.slice(i, end);
    const { call, malformed } = parseCandidate(raw);
    if (call) {
      found.push({ pos: i, call });
      removed.push({ start: i, end });
      i = end - 1;
    } else if (malformed) {
      notes.push(noteFor(raw, 'invalid JSON'));
      removed.push({ start: i, end });
      i = end - 1;
    } else if (!raw.includes('"tool"')) {
      // Balanced JSON with no "tool" substring can hold no call or malformed
      // note inside; skipping the block keeps the scan linear on deep nesting.
      i = end - 1;
    }
  }

  found.sort((a, b) => a.pos - b.pos);
  const calls = found.map((f) => f.call);

  let text = '';
  let pos = 0;
  // Removed spans can overlap (a truncated tail may swallow nested spans);
  // merge before slicing so the prose rebuild stays linear.
  const sorted = [...removed].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  for (const span of merged) {
    text += response.slice(pos, span.start);
    pos = span.end;
  }
  text += response.slice(pos);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { calls, notes, text };
}
