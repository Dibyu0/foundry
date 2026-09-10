import { MAX_FILES, MAX_FILE_BYTES } from '../sites.js';
import { validatePath } from './tools.js';

export const MAX_PLAN_STEPS = 12;
export { MAX_FILES as MAX_SITE_FILES, MAX_FILE_BYTES };

/**
 * Extensions the team may write. The site itself is plain html/css/js;
 * svg/json/txt cover icons and data, md covers the README a plan may call
 * for. Anything else (shell, binaries, markup templates) is junk and gets
 * dropped during normalization.
 */
const WRITABLE_EXTENSIONS = new Set(['html', 'css', 'js', 'svg', 'json', 'txt', 'md']);

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  files: string[];
}

export interface BuildPlan {
  summary: string;
  steps: PlanStep[];
  designNotes?: string;
  /** Multi-page sites: the html pages to generate (index.html first). */
  pages?: string[];
}

/** Sanitize a model-supplied pages array into writable .html paths, index.html first. */
function normalizePages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const p = sanitizeSitePath(entry.endsWith('.html') ? entry : `${entry}.html`);
    if (p === null || !isWritableSiteFile(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 8) break;
  }
  if (out.length === 0) return undefined;
  // A pages list without index.html first is invalid: the entry page must be
  // generated, so it leads the list even when the model buries or omits it.
  const indexAt = out.indexOf('index.html');
  if (indexAt > 0) out.splice(indexAt, 1);
  if (indexAt !== 0) out.unshift('index.html');
  return out.slice(0, 8);
}

/** Review issue in the client-facing shape (web/src/types.ts ReviewIssue). */
export interface ReviewIssue {
  severity: 'info' | 'warn' | 'error';
  text: string;
  file?: string;
}

/**
 * Normalizes a model/user-supplied relative path: trims, converts to POSIX
 * separators, strips leading "./". Returns null for anything the confined
 * store would reject (absolute, drive-letter, UNC, ".." segments, controls).
 */
export function sanitizeSitePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '') return null;
  const v = validatePath(p);
  return v.ok ? v.value : null;
}

export function isWritableSiteFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return WRITABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function asTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Drop-style normalization of model plan output: junk steps and files are
 * removed rather than failing the whole plan, steps are capped at
 * MAX_PLAN_STEPS and unique writable files at MAX_FILES. Returns null when
 * nothing usable remains.
 */
export function normalizePlan(raw: unknown): BuildPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: PlanStep[] = [];
  const seenFiles = new Set<string>();
  for (const rawStep of rawSteps) {
    if (steps.length >= MAX_PLAN_STEPS) break;
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue;
    const so = rawStep as Record<string, unknown>;
    const rawFiles = Array.isArray(so.files) ? so.files : typeof so.file === 'string' ? [so.file] : [];
    const files: string[] = [];
    for (const f of rawFiles) {
      if (seenFiles.size >= MAX_FILES) break;
      const p = sanitizeSitePath(f);
      if (p === null || !isWritableSiteFile(p) || seenFiles.has(p)) continue;
      seenFiles.add(p);
      files.push(p);
    }
    const title = asTrimmedString(so.title ?? so.name ?? so.step, 120);
    const detail = asTrimmedString(so.detail ?? so.description, 2000);
    if (title === null && files.length === 0) continue;
    const id = asTrimmedString(so.id, 60) ?? `step-${steps.length + 1}`;
    steps.push({ id, title: title ?? `Write ${files.join(', ')}`, detail: detail ?? title ?? '', files });
  }
  if (steps.length === 0) return null;
  const summary = asTrimmedString(o.summary ?? o.description ?? o.title, 500) ?? 'Untitled site';
  const plan: BuildPlan = { summary, steps };
  const designNotes = asTrimmedString(o.designNotes ?? o.designDirection ?? o.design ?? o.direction, 2000);
  if (designNotes !== null) plan.designNotes = designNotes;
  const pages = normalizePages(o.pages);
  if (pages !== undefined) plan.pages = pages;
  return plan;
}

/**
 * Sanitizes a user-edited plan before approval. Valid edited fields win;
 * anything missing or unusable falls back to the current plan, and all
 * normal caps/path rules are re-applied to the edited steps. Step id and
 * detail merge by index: the web editor only sends titles/files back, so a
 * step that omits them keeps the current step's values instead of losing
 * the detail text to a from-scratch re-normalization.
 */
export function applyPlanEdits(current: BuildPlan, edits: unknown): BuildPlan {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return current;
  const o = edits as Record<string, unknown>;
  const merged: BuildPlan = {
    summary: current.summary,
    steps: current.steps,
    ...(current.designNotes !== undefined ? { designNotes: current.designNotes } : {}),
    ...(current.pages !== undefined ? { pages: current.pages } : {}),
  };
  const summary = asTrimmedString(o.summary, 500);
  if (summary !== null) merged.summary = summary;
  const designNotes = asTrimmedString(o.designNotes ?? o.designDirection ?? o.design ?? o.direction, 2000);
  if (designNotes !== null) merged.designNotes = designNotes;
  if (Array.isArray(o.pages)) {
    const pages = normalizePages(o.pages);
    if (pages !== undefined) merged.pages = pages;
  }
  if (Array.isArray(o.steps)) {
    const editedSteps: unknown[] = o.steps;
    const normalized = normalizePlan({ summary: merged.summary, steps: editedSteps });
    if (normalized !== null && normalized.steps.length > 0) {
      merged.steps = normalized.steps.map((step, i) => {
        const rawStep: unknown = editedSteps[i];
        const ro =
          rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep)
            ? (rawStep as Record<string, unknown>)
            : null;
        const prev = current.steps[i];
        const id = ro === null ? null : asTrimmedString(ro.id, 60);
        const detail = ro === null ? null : asTrimmedString(ro.detail ?? ro.description, 2000);
        return {
          ...step,
          id: id ?? prev?.id ?? step.id,
          detail: detail ?? prev?.detail ?? step.detail,
        };
      });
    }
  }
  return merged;
}

/** Unique files across all steps, in plan order. */
export function planFiles(plan: BuildPlan): string[] {
  const out: string[] = [];
  for (const step of plan.steps) {
    for (const f of step.files) {
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

/**
 * Html pages the plan declares, in plan order (index.html first for plans
 * built by normalizePlan/applyPlanEdits). Only unique, store-safe .html
 * names survive, so a persisted plan stays safe to consume; an empty result
 * means a single-page plan. Mirrored by roles.ts for prompt rendering.
 */
export function planPages(plan: BuildPlan | undefined): string[] {
  if (plan === undefined) return [];
  const raw: unknown = plan.pages;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const p = sanitizeSitePath(entry);
    if (p === null || !p.toLowerCase().endsWith('.html') || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/** Wire shape for plan state/events: adds the frontend's designDirection alias. */
export function toClientPlan(plan: BuildPlan): Record<string, unknown> {
  return {
    summary: plan.summary,
    steps: plan.steps.map((s) => ({ ...s, files: [...s.files] })),
    ...(plan.designNotes !== undefined
      ? { designNotes: plan.designNotes, designDirection: plan.designNotes }
      : {}),
  };
}
