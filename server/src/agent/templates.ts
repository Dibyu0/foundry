/**
 * Starter recipes the planner picks from when it shapes a build plan. Each
 * recipe is data only: the section structure the plan should follow and the
 * style direction design and copy inherit. The planner prompt embeds
 * TEMPLATE_MENU verbatim and the chosen recipe id travels in the plan's
 * designNotes ("Recipe: <id>"), so the whole team builds against one
 * structure. 'landing' is the default and maps to the premium design recipe
 * in designRecipe.ts.
 */

export interface SiteTemplate {
  /** Stable machine id, e.g. 'landing'. */
  id: string;
  /** Human label, e.g. 'Landing page'. */
  label: string;
  /** When this recipe fits, one line. */
  description: string;
  /** Section structure the plan should follow. */
  sectionsHint: string;
  /** Style direction the design role should take. */
  styleHint: string;
}

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  {
    id: 'landing',
    label: 'Landing page',
    description:
      'The Foundry premium blueprint: one conversion-focused page for a product, service or campaign. The default when the brief is unclear.',
    sectionsHint:
      'the full premium section blueprint in order: sticky glass nav, hero, logo marquee, features grid, stats band, showcase split, testimonials, pricing, faq, closing cta band, footer',
    styleHint:
      'the premium recipe as-is: dark metallic surfaces, real glass, aurora gradient accents, fluid display type, the complete motion system',
  },
  {
    id: 'portfolio',
    label: 'Portfolio',
    description:
      'A personal or studio showcase: the work leads, everything else supports it.',
    sectionsHint:
      'nav, a short intro hero, a work grid of project cards, one or two selected case-study splits, an about section, a contact section, footer',
    styleHint:
      'visual-forward: large CSS/SVG project visuals, restrained type, generous whitespace; motion stays subtle so the work stays the focus',
  },
  {
    id: 'saas',
    label: 'SaaS product site',
    description:
      'A product marketing site that explains the workflow and converts to a plan.',
    sectionsHint:
      'nav, hero, features grid, a how-it-works stepped section, testimonials, pricing with a highlighted middle tier, faq, closing cta band, footer',
    styleHint:
      'product-led: crisp feature cards, CSS/SVG product UI visuals in the hero and how-it-works, conversion-focused accent usage',
  },
  {
    id: 'blog',
    label: 'Blog',
    description:
      'A reading-first publication: post discovery on the front page, comfortable articles behind it.',
    sectionsHint:
      'nav, a post list with featured entry, a post layout (article header, comfortable measure, byline), an about section, a newsletter signup, footer',
    styleHint:
      'reading-first: comfortable line measure, quieter surfaces, display type tuned for headlines; long-form legibility beats spectacle',
  },
  {
    id: 'docs',
    label: 'Docs',
    description:
      'A reference site: find the page fast, scan it faster.',
    sectionsHint:
      'top nav, a sticky sidebar nav of sections, the article column, a per-page toc of headings, a search hint box in the sidebar header, footer',
    styleHint:
      'reference-first: clear heading hierarchy, scannable code and callout blocks, high legibility; decoration stays out of the reading path',
  },
];

/** The recipe the planner falls back to when the brief fits nothing closer. */
export const DEFAULT_TEMPLATE_ID = 'landing';

export function getTemplate(id: string): SiteTemplate | undefined {
  return SITE_TEMPLATES.find((t) => t.id === id);
}

/**
 * The recipe list embedded in the planner prompt. Composed from SITE_TEMPLATES
 * so the prompt can never drift from the data.
 */
export const TEMPLATE_MENU: string = SITE_TEMPLATES.map(
  (t) => `- ${t.id} (${t.label}): ${t.description}\n  Sections: ${t.sectionsHint}\n  Style: ${t.styleHint}`,
).join('\n');
