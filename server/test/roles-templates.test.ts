import { describe, expect, it } from 'vitest';
import type { BuildPlan } from '../src/agent/plan.js';
import {
  copyPrompt,
  fixErrorPrompt,
  planPages,
  plannerPrompt,
  targetedEditPrompt,
  type RoleContext,
} from '../src/agent/roles.js';
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  SITE_TEMPLATES,
  TEMPLATE_MENU,
} from '../src/agent/templates.js';
import { BLUEPRINT_SPEC, HARD_RULES, ICON_RULES, MOTION_SPEC } from '../src/agent/designRecipe.js';

const CTX: RoleContext = {
  brief: 'A marketing site for a coffee subscription startup.',
  answers: [],
};

const ASCII_ONLY = /^[\x20-\x7E\n]*$/;

describe('starter recipe data', () => {
  it('defines exactly the five documented recipes with unique slug ids', () => {
    expect(SITE_TEMPLATES.length).toBe(5);
    expect(new Set(SITE_TEMPLATES.map((t) => t.id))).toEqual(
      new Set(['landing', 'portfolio', 'saas', 'blog', 'docs']),
    );
    const ids = new Set<string>();
    for (const t of SITE_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(ids.has(t.id), `duplicate recipe ${t.id}`).toBe(false);
      ids.add(t.id);
    }
  });

  it('gives every recipe a non-empty ASCII label, description, sectionsHint and styleHint', () => {
    for (const t of SITE_TEMPLATES) {
      for (const field of [t.label, t.description, t.sectionsHint, t.styleHint]) {
        expect(field.trim(), `${t.id} has an empty field`).not.toBe('');
        expect(field, `${t.id} is not ASCII`).toMatch(ASCII_ONLY);
      }
    }
  });

  it('pins each recipe to its documented section structure', () => {
    const byId = new Map(SITE_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('landing')?.sectionsHint).toMatch(/premium section blueprint/i);
    for (const kw of ['work grid', 'about', 'contact']) {
      expect(byId.get('portfolio')?.sectionsHint, `portfolio missing ${kw}`).toContain(kw);
    }
    for (const kw of ['hero', 'features', 'how-it-works', 'testimonials', 'pricing', 'faq']) {
      expect(byId.get('saas')?.sectionsHint, `saas missing ${kw}`).toContain(kw);
    }
    for (const kw of ['post list', 'post layout', 'about', 'newsletter']) {
      expect(byId.get('blog')?.sectionsHint, `blog missing ${kw}`).toContain(kw);
    }
    for (const kw of ['sidebar', 'article', 'toc', 'search']) {
      expect(byId.get('docs')?.sectionsHint, `docs missing ${kw}`).toContain(kw);
    }
  });

  it('defaults to landing and resolves recipes by id', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('landing');
    expect(getTemplate(DEFAULT_TEMPLATE_ID)?.id).toBe('landing');
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });

  it('composes TEMPLATE_MENU from the data so the prompt cannot drift from it', () => {
    for (const t of SITE_TEMPLATES) {
      expect(TEMPLATE_MENU).toContain(t.id);
      expect(TEMPLATE_MENU).toContain(t.label);
      expect(TEMPLATE_MENU).toContain(t.description);
      expect(TEMPLATE_MENU).toContain(t.sectionsHint);
      expect(TEMPLATE_MENU).toContain(t.styleHint);
    }
    expect(TEMPLATE_MENU).toMatch(ASCII_ONLY);
  });
});

describe('planner prompt: template selection and the multipage contract', () => {
  const prompt = plannerPrompt(CTX);

  it('keeps the [role:planner] marker and the plan tool contract', () => {
    expect(prompt).toContain('[role:planner]');
    expect(prompt).toContain('"tool":"plan"');
  });

  it('mentions all five starter recipes by id and label', () => {
    for (const t of SITE_TEMPLATES) {
      expect(prompt, `planner prompt is missing recipe ${t.id}`).toContain(t.id);
      expect(prompt, `planner prompt is missing label ${t.label}`).toContain(t.label);
    }
    expect(prompt).toContain(TEMPLATE_MENU);
  });

  it('instructs picking the closest recipe (landing when unclear) and naming it in designNotes', () => {
    expect(prompt).toMatch(/pick the closest recipe/i);
    expect(prompt).toContain("'landing' when unclear");
    expect(prompt).toContain('"Recipe: <id>"');
    expect(prompt).toMatch(/designNotes/);
  });

  it('documents the optional pages list for multi-page plans', () => {
    expect(prompt).toContain('"pages"');
    expect(prompt).toContain('index.html');
    expect(prompt).toContain('features.html');
    expect(prompt).toContain('pricing.html');
    expect(prompt).toMatch(/multi-page/);
    expect(prompt).toMatch(/single-page/);
  });
});

describe('planPages', () => {
  it('returns no pages without a plan or without a pages field', () => {
    expect(planPages(undefined)).toEqual([]);
    expect(planPages({ summary: 'x', steps: [] })).toEqual([]);
    expect(planPages({ summary: 'x', steps: [], designNotes: 'Recipe: landing' })).toEqual([]);
  });

  it('keeps only unique, store-safe html page names', () => {
    const plan = {
      summary: 'x',
      steps: [],
      pages: ['index.html', 'features.html', 'features.html', ' pricing.html ', 42, '', 'app.js', '../evil.html'],
    } as unknown as BuildPlan;
    expect(planPages(plan)).toEqual(['index.html', 'features.html', 'pricing.html']);
  });
});

describe('copy prompt: multipage contract', () => {
  const multiPlan = {
    summary: 'A saas marketing site with feature and pricing pages.',
    designNotes: 'Recipe: saas',
    steps: [
      { id: 's1', title: 'Pages', detail: 'All three pages.', files: ['index.html', 'features.html', 'pricing.html'] },
    ],
    pages: ['index.html', 'features.html', 'pricing.html'],
  } as unknown as BuildPlan;
  const multi = copyPrompt({ ...CTX, plan: multiPlan });

  it('writes one shared-asset page per pages entry', () => {
    expect(multi).toContain('[role:copy]');
    expect(multi).toContain('MULTI-PAGE OUTPUT CONTRACT');
    for (const page of ['index.html', 'features.html', 'pricing.html']) {
      expect(multi, `multipage prompt is missing ${page}`).toContain(page);
    }
    expect(multi).toMatch(/one complete html file per page/i);
    expect(multi).toContain('<link rel="stylesheet" href="styles.css">');
    expect(multi).toContain('<script src="app.js" defer></script>');
  });

  it('requires identical header/footer markup, an active nav state per page and relative internal links', () => {
    expect(multi).toMatch(/header\/nav and footer markup is identical/i);
    expect(multi).toContain('aria-current="page"');
    expect(multi).toMatch(/internal links are relative/i);
  });

  it('keeps the premium recipe blocks embedded in multipage mode', () => {
    for (const block of [BLUEPRINT_SPEC, MOTION_SPEC, ICON_RULES, HARD_RULES]) {
      expect(multi).toContain(block);
    }
  });

  it('stays single-page by default and when only one page is named', () => {
    const single = copyPrompt(CTX);
    expect(single).toContain('Write ONE complete index.html');
    expect(single).not.toContain('MULTI-PAGE OUTPUT CONTRACT');
    const onePage = copyPrompt({
      ...CTX,
      plan: { summary: 'x', designNotes: 'Recipe: landing', steps: [], pages: ['index.html'] } as unknown as BuildPlan,
    });
    expect(onePage).not.toContain('MULTI-PAGE OUTPUT CONTRACT');
    expect(onePage).toContain('Write ONE complete index.html');
  });
});

describe('targetedEditPrompt', () => {
  const files = [
    { path: 'index.html', content: '<html><body><h1>Old headline</h1></body></html>' },
    { path: 'styles.css', content: ':root { --color-bg-0: #05070a; }' },
  ];
  const prompt = targetedEditPrompt(
    'A saas site for a coffee startup.',
    'Change the hero headline to mention decaf.',
    files,
  );

  it('keeps the role marker and tool convention, and carries brief, instruction and file contents', () => {
    expect(prompt).toContain('[role:builder]');
    expect(prompt).toContain('"tool":"writeFile"');
    expect(prompt).toContain('"tool":"finish"');
    expect(prompt).toContain('A saas site for a coffee startup.');
    expect(prompt).toContain('Change the hero headline to mention decaf.');
    expect(prompt).toContain('<h1>Old headline</h1>');
    expect(prompt).toContain('--color-bg-0: #05070a');
    expect(prompt).toContain('--- index.html ---');
    expect(prompt).toContain('--- styles.css ---');
  });

  it('instructs changed-files-only, complete contents, design-system preservation and a changed-file summary', () => {
    expect(prompt).toMatch(/changed files only/i);
    expect(prompt).toMatch(/never rewrite a file that stays the same/i);
    expect(prompt).toMatch(/full new content/i);
    expect(prompt).toMatch(/no diffs/i);
    expect(prompt).toMatch(/preserve the design system/i);
    expect(prompt).toMatch(/unrelated section/i);
    expect(prompt).toMatch(/changed-file summary/i);
    expect(prompt).toContain(HARD_RULES);
  });

  it('handles an empty file list honestly', () => {
    expect(targetedEditPrompt('brief', 'do something', [])).toMatch(/no file contents supplied/i);
  });
});

describe('fixErrorPrompt', () => {
  const files = [{ path: 'app.js', content: 'document.querySelector("#nav".className = "x";' }];

  it('includes the error text, the location and the implicated files verbatim', () => {
    const prompt = fixErrorPrompt(
      'A portfolio site.',
      { message: "Uncaught SyntaxError: Unexpected token '.'", file: 'app.js', line: 1 },
      files,
    );
    expect(prompt).toContain('[role:builder]');
    expect(prompt).toContain("Uncaught SyntaxError: Unexpected token '.'");
    expect(prompt).toContain('Location: app.js, line 1');
    expect(prompt).toContain('document.querySelector("#nav".className = "x";');
    expect(prompt).toContain('--- app.js ---');
  });

  it('degrades gracefully when no file or line is reported', () => {
    const prompt = fixErrorPrompt('A portfolio site.', { message: 'ReferenceError: boot is not defined' }, files);
    expect(prompt).toContain('ReferenceError: boot is not defined');
    expect(prompt).toMatch(/not reported/i);
    const fileOnly = fixErrorPrompt('A portfolio site.', { message: 'boom', file: 'index.html' }, files);
    expect(fileOnly).toContain('Location: index.html\n');
    expect(fileOnly).not.toContain('Location: index.html, line');
  });

  it('asks for a root-cause fix and the corrected complete files only', () => {
    const prompt = fixErrorPrompt('A portfolio site.', { message: 'boom' }, files);
    expect(prompt).toMatch(/root cause/i);
    expect(prompt).toMatch(/corrected files only/i);
    expect(prompt).toMatch(/full content/i);
    expect(prompt).toMatch(/never rewrite a file the fix does not touch/i);
    expect(prompt).toContain(HARD_RULES);
  });
});
