import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_SPEC,
  DESIGN_TOKENS,
  HARD_RULES,
  ICON_RULES,
  MOTION_FEATURES,
  MOTION_SPEC,
  PREMIUM_DESIGN_RECIPE,
  REVIEW_CHECKLIST,
  SECTION_BLUEPRINT,
  TOKEN_CSS,
} from '../src/agent/designRecipe.js';
import {
  builderPrompt,
  copyPrompt,
  designPrompt,
  reviewerPrompt,
  type RoleContext,
} from '../src/agent/roles.js';

const CTX: RoleContext = {
  brief: 'A premium landing page for a coffee subscription startup.',
  answers: [],
};

const ROLE_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ['design', designPrompt(CTX)],
  ['copy', copyPrompt(CTX)],
  ['builder', builderPrompt(CTX)],
  ['reviewer', reviewerPrompt(CTX)],
];

const TOKEN_NAME = /^--[a-z][a-z0-9-]*$/;
const ASCII_ONLY = /^[\x20-\x7E\n]*$/;

/** Parses TOKEN_CSS into name/value pairs; declarations that do not parse get the __invalid__ marker. */
function parseTokenBlock(css: string): Array<{ name: string; value: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const body = /^:root\s*\{([\s\S]*)\}\s*$/.exec(stripped.trim())?.[1];
  if (body === undefined) return [{ name: '__invalid__', value: 'not a :root block' }];
  const out: Array<{ name: string; value: string }> = [];
  for (const decl of body.split(';')) {
    const d = decl.trim();
    if (d === '') continue;
    const m = /^(--[a-z][a-z0-9-]*)\s*:\s*([\s\S]+)$/.exec(d);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      out.push({ name: m[1], value: m[2].trim() });
    } else {
      out.push({ name: '__invalid__', value: d });
    }
  }
  return out;
}

describe('recipe token system', () => {
  it('is non-empty, well-formed and unique', () => {
    expect(DESIGN_TOKENS.length).toBeGreaterThan(10);
    const names = new Set<string>();
    for (const token of DESIGN_TOKENS) {
      expect(token.name).toMatch(TOKEN_NAME);
      expect(token.value.trim()).not.toBe('');
      expect(token.why.trim()).not.toBe('');
      expect(names.has(token.name), `duplicate token ${token.name}`).toBe(false);
      names.add(token.name);
    }
  });

  it('TOKEN_CSS parses as a :root block and stays in exact sync with DESIGN_TOKENS', () => {
    const parsed = parseTokenBlock(TOKEN_CSS);
    expect(parsed.length).toBe(DESIGN_TOKENS.length);
    for (const decl of parsed) {
      expect(decl.name, `unparseable declaration: ${decl.value}`).toMatch(TOKEN_NAME);
      const token = DESIGN_TOKENS.find((t) => t.name === decl.name);
      expect(token, `${decl.name} is in TOKEN_CSS but not in DESIGN_TOKENS`).toBeDefined();
      expect(token?.value).toBe(decl.value);
    }
  });
});

describe('recipe structure', () => {
  it('defines the 11-section blueprint with unique ids', () => {
    expect(SECTION_BLUEPRINT.length).toBe(11);
    const ids = new Set<string>();
    for (const section of SECTION_BLUEPRINT) {
      expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(ids.has(section.id), `duplicate section ${section.id}`).toBe(false);
      ids.add(section.id);
    }
  });

  it('splits motion features between css and js owners', () => {
    expect(MOTION_FEATURES.length).toBeGreaterThan(5);
    expect(MOTION_FEATURES.some((f) => f.owner === 'css')).toBe(true);
    expect(MOTION_FEATURES.some((f) => f.owner === 'js')).toBe(true);
    const ids = new Set<string>();
    for (const feature of MOTION_FEATURES) {
      expect(['css', 'js']).toContain(feature.owner);
      expect(feature.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(ids.has(feature.id), `duplicate feature ${feature.id}`).toBe(false);
      ids.add(feature.id);
    }
  });

  it('composes PREMIUM_DESIGN_RECIPE from every spec block', () => {
    expect(PREMIUM_DESIGN_RECIPE).toContain(TOKEN_CSS);
    expect(PREMIUM_DESIGN_RECIPE).toContain(MOTION_SPEC);
    expect(PREMIUM_DESIGN_RECIPE).toContain(BLUEPRINT_SPEC);
    expect(PREMIUM_DESIGN_RECIPE).toContain(ICON_RULES);
    expect(PREMIUM_DESIGN_RECIPE).toContain(HARD_RULES);
  });

  it('pins the hard rules: fonts limit, no-lorem, AA, hamburger, reduced motion, print, GPU-only', () => {
    expect(HARD_RULES).toContain('Google Fonts');
    expect(HARD_RULES).toMatch(/lorem ipsum/i);
    expect(HARD_RULES).toContain('4.5:1');
    expect(HARD_RULES).toContain('3:1');
    expect(HARD_RULES).toContain('hamburger');
    expect(HARD_RULES).toContain('prefers-reduced-motion');
    expect(HARD_RULES).toMatch(/print/i);
    expect(HARD_RULES).toContain('transform and opacity only');
  });

  it('keeps every recipe block ASCII (no emojis, no smart punctuation)', () => {
    for (const block of [PREMIUM_DESIGN_RECIPE, TOKEN_CSS, MOTION_SPEC, BLUEPRINT_SPEC, ICON_RULES, HARD_RULES, REVIEW_CHECKLIST]) {
      expect(block).toMatch(ASCII_ONLY);
    }
  });
});

describe('role prompts carry the recipe', () => {
  it('keeps the [role:] markers and tool contracts intact', () => {
    expect(designPrompt(CTX)).toContain('[role:design]');
    expect(copyPrompt(CTX)).toContain('[role:copy]');
    expect(builderPrompt(CTX)).toContain('[role:builder]');
    expect(reviewerPrompt(CTX)).toContain('[role:reviewer]');
    expect(designPrompt(CTX)).toContain('"tool":"writeFile"');
    expect(copyPrompt(CTX)).toContain('"tool":"writeFile"');
    expect(builderPrompt(CTX)).toContain('"tool":"writeFile"');
    expect(reviewerPrompt(CTX)).toContain('reviewNotes');
  });

  it('mentions every motion feature and the reduced-motion rule in every role prompt', () => {
    for (const [role, prompt] of ROLE_PROMPTS) {
      expect(prompt, role).toContain('prefers-reduced-motion');
      for (const feature of MOTION_FEATURES) {
        expect(prompt, `${role} prompt is missing motion feature ${feature.id}`).toContain(feature.id);
      }
    }
  });

  it('mentions every blueprint section in every role prompt', () => {
    for (const [role, prompt] of ROLE_PROMPTS) {
      for (const section of SECTION_BLUEPRINT) {
        expect(prompt, `${role} prompt is missing section #${section.id}`).toContain(`#${section.id}`);
      }
    }
  });

  it('carries the no-lorem rule in every role prompt', () => {
    for (const [role, prompt] of ROLE_PROMPTS) {
      expect(prompt, role).toMatch(/lorem ipsum/i);
    }
  });
});

describe('builder contract', () => {
  it('requires every interactive motion feature, with the js-owned specs spelled out', () => {
    const prompt = builderPrompt(CTX);
    for (const feature of MOTION_FEATURES) {
      expect(prompt, `builder missing ${feature.id}`).toContain(feature.id);
      if (feature.owner === 'js') {
        expect(prompt, `builder missing spec text for ${feature.id}`).toContain(feature.summary);
      }
    }
    expect(prompt).toContain('matchMedia');
  });

  it('keeps the motion spec in front of the builder on fix passes and remaining-file passes', () => {
    const fix = builderPrompt({ ...CTX, issues: [{ severity: 'warn', text: 'nav toggle does not update aria-expanded' }] });
    const remaining = builderPrompt({ ...CTX, remainingFiles: ['about.html'] });
    for (const feature of MOTION_FEATURES) {
      expect(fix).toContain(feature.id);
      expect(remaining).toContain(feature.id);
    }
  });
});

describe('reviewer checklist', () => {
  it('is generated from the recipe: every section and motion feature is checked', () => {
    for (const section of SECTION_BLUEPRINT) {
      expect(REVIEW_CHECKLIST).toContain(section.id);
    }
    for (const feature of MOTION_FEATURES) {
      expect(REVIEW_CHECKLIST).toContain(feature.id);
    }
    expect(REVIEW_CHECKLIST).toContain('backdrop-filter');
    expect(REVIEW_CHECKLIST).toMatch(/lorem ipsum/i);
    expect(reviewerPrompt(CTX)).toContain(REVIEW_CHECKLIST);
  });
});
