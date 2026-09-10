import { describe, expect, it } from 'vitest';
import {
  applyPlanEdits,
  normalizePlan,
  planPages,
  toClientPlan,
  type BuildPlan,
} from '../src/agent/plan.js';
import { clonePlan } from '../../web/src/components/PlanView.js';
import type { Plan, PlanStep } from '../../web/src/types.js';

/** Steps as they arrive on the wire: the web PlanStep type omits id/detail. */
type WireStep = PlanStep & { id?: string; detail?: string };

function planOrThrow(raw: unknown): BuildPlan {
  const plan = normalizePlan(raw);
  if (plan === null) throw new Error('plan normalization failed');
  return plan;
}

describe('applyPlanEdits step merging', () => {
  const current = (): BuildPlan => ({
    summary: 'current summary',
    steps: [
      { id: 's1', title: 'Markup', detail: 'Semantic html with a hero section.', files: ['index.html'] },
      { id: 's2', title: 'Styles', detail: 'Dark responsive theme.', files: ['styles.css'] },
    ],
  });

  it('preserves id and detail for UI-shaped edits that omit them', () => {
    const edited = applyPlanEdits(current(), {
      steps: [
        { title: 'Renamed markup', files: ['index.html'], done: false },
        { title: 'Styles', files: ['styles.css'], done: false },
      ],
    });
    expect(edited.steps).toEqual([
      { id: 's1', title: 'Renamed markup', detail: 'Semantic html with a hero section.', files: ['index.html'] },
      { id: 's2', title: 'Styles', detail: 'Dark responsive theme.', files: ['styles.css'] },
    ]);
  });

  it('lets an edited step override id and detail while siblings keep theirs', () => {
    const edited = applyPlanEdits(current(), {
      steps: [
        { id: 'hero', title: 'Markup', detail: 'Rewritten detail.', files: ['index.html'] },
        { title: 'Styles', files: ['styles.css'] },
      ],
    });
    expect(edited.steps[0]).toEqual({
      id: 'hero',
      title: 'Markup',
      detail: 'Rewritten detail.',
      files: ['index.html'],
    });
    expect(edited.steps[1]).toEqual({
      id: 's2',
      title: 'Styles',
      detail: 'Dark responsive theme.',
      files: ['styles.css'],
    });
  });

  it('still sanitizes paths and caps steps while merging', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `Step ${i + 1}`, files: [`f${i}.js`, '../evil.js'] }));
    const edited = applyPlanEdits(current(), { steps: many });
    expect(edited.steps).toHaveLength(12);
    for (const step of edited.steps) expect(step.files).toHaveLength(1);
    expect(edited.steps[0]?.files).toEqual(['f0.js']);
    expect(edited.steps[0]?.id).toBe('s1');
    expect(edited.steps[1]?.id).toBe('s2');
    expect(edited.steps[2]?.id).toBe('step-3');
  });

  it('generates id/detail for steps added beyond the current plan', () => {
    const edited = applyPlanEdits(current(), {
      steps: [
        { title: 'Markup', files: ['index.html'] },
        { title: 'Styles', files: ['styles.css'] },
        { title: 'Scripting', files: ['app.js'] },
      ],
    });
    expect(edited.steps[2]).toEqual({ id: 'step-3', title: 'Scripting', detail: 'Scripting', files: ['app.js'] });
  });
});

describe('UI approval round-trip', () => {
  it('clonePlan output approved through applyPlanEdits keeps every step id and detail', () => {
    const current = planOrThrow({
      summary: 'Site',
      steps: [
        { id: 's1', title: 'Markup', detail: 'Semantic html with a hero section.', files: ['index.html'] },
        { id: 's2', title: 'Styles', detail: 'Dark responsive theme.', files: ['styles.css'] },
      ],
    });
    // The wire plan the client renders, cloned by PlanView into the draft
    // that onApprove posts back as plan edits.
    const draft = clonePlan(toClientPlan(current) as unknown as Plan);
    const approved = applyPlanEdits(current, { steps: draft.steps });
    expect(approved.steps).toEqual(current.steps);
  });
});

describe('clonePlan (web PlanView)', () => {
  it('round-trips id, detail, title, files and done, copying the files array', () => {
    const steps: WireStep[] = [
      { id: 's1', title: 'Markup', detail: 'Hero + features.', files: ['index.html'], done: true },
      { id: 's2', title: 'Styles', detail: 'Dark theme.', files: ['styles.css'], done: false },
    ];
    const plan: Plan = { summary: 'Site', designDirection: 'dark', steps };
    const clone = clonePlan(plan);
    expect(clone).toEqual(plan);
    expect(clone.steps).not.toBe(plan.steps);
    expect(clone.steps[0]?.files).not.toBe(plan.steps[0]?.files);
  });

  it('does not invent id or detail for steps that lack them', () => {
    const plan: Plan = { summary: 'Site', steps: [{ title: 'Markup', files: ['index.html'], done: false }] };
    const [step] = clonePlan(plan).steps;
    expect(step).toEqual({ title: 'Markup', files: ['index.html'], done: false });
    expect(step !== undefined && 'id' in step).toBe(false);
    expect(step !== undefined && 'detail' in step).toBe(false);
  });
});

describe('normalizePlan pages', () => {
  const steps = [{ title: 'Pages', files: ['index.html'] }];

  it('prepends index.html when the pages list omits it', () => {
    const plan = planOrThrow({ summary: 'x', steps, pages: ['about', 'contact'] });
    expect(plan.pages).toEqual(['index.html', 'about.html', 'contact.html']);
  });

  it('moves index.html to the front and dedupes entries', () => {
    const plan = planOrThrow({ summary: 'x', steps, pages: ['about.html', 'index.html', 'about', 'index'] });
    expect(plan.pages).toEqual(['index.html', 'about.html']);
  });

  it('keeps the 8-page cap with index.html first', () => {
    const pages = Array.from({ length: 9 }, (_, i) => `page-${i + 1}`);
    const plan = planOrThrow({ summary: 'x', steps, pages });
    expect(plan.pages).toEqual([
      'index.html',
      'page-1.html',
      'page-2.html',
      'page-3.html',
      'page-4.html',
      'page-5.html',
      'page-6.html',
      'page-7.html',
    ]);
  });

  it('drops unusable entries and reports no pages when none survive', () => {
    expect(planOrThrow({ summary: 'x', steps, pages: ['../evil', ''] }).pages).toBeUndefined();
    expect(planOrThrow({ summary: 'x', steps }).pages).toBeUndefined();
  });

  it('re-normalizes edited pages with index.html first', () => {
    const currentPlan = planOrThrow({ summary: 'x', steps });
    const edited = applyPlanEdits(currentPlan, { pages: ['features', 'pricing'] });
    expect(edited.pages).toEqual(['index.html', 'features.html', 'pricing.html']);
  });
});

describe('planPages', () => {
  it('returns no pages without a plan or a pages field', () => {
    expect(planPages(undefined)).toEqual([]);
    expect(planPages({ summary: 'x', steps: [] })).toEqual([]);
  });

  it('keeps only unique, store-safe .html names in plan order', () => {
    const plan = {
      summary: 'x',
      steps: [],
      pages: ['features.html', 'features.html', ' pricing.html ', 42, '', 'app.js', '../evil.html'],
    } as unknown as BuildPlan;
    expect(planPages(plan)).toEqual(['features.html', 'pricing.html']);
  });

  it('reports index.html first for a normalized multipage plan', () => {
    const plan = planOrThrow({
      summary: 'x',
      steps: [{ title: 'Pages', files: ['index.html', 'features.html', 'pricing.html'] }],
      pages: ['features', 'pricing'],
    });
    expect(planPages(plan)).toEqual(['index.html', 'features.html', 'pricing.html']);
  });
});
