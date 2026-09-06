/**
 * The Foundry premium design recipe: the single source of truth for how
 * generated sites look, move, and are structured. Role prompts (roles.ts)
 * embed these blocks verbatim so the whole team builds against one contract
 * and every build lands as a coherent 2026-grade product site: dark metallic
 * surfaces, real glass, gradient accents, honest motion.
 *
 * Everything here must stay implementable with plain html/css/js: the
 * preview has no build step and allows no external scripts or frameworks.
 * Keep the structured lists (DESIGN_TOKENS, MOTION_FEATURES,
 * SECTION_BLUEPRINT) in sync with the composed text blocks; the test suite
 * pins that contract.
 */

export interface RecipeToken {
  /** CSS custom property name, e.g. --color-bg-0. */
  name: string;
  /** The value the design role defines on :root. */
  value: string;
  /** What the token is for (prompt guidance, not emitted into CSS). */
  why: string;
}

export interface MotionFeature {
  /** Stable machine-checkable id, e.g. scroll-reveal. */
  id: string;
  /** Who implements it: 'css' (design role) or 'js' (builder role). */
  owner: 'css' | 'js';
  /** One-line spec the roles must implement. */
  summary: string;
}

export interface BlueprintSection {
  /** Stable id used as the section's id hook in index.html, e.g. features. */
  id: string;
  /** Human name, e.g. "Features grid". */
  name: string;
  /** Required content and behavior of the section. */
  spec: string;
}

export const DESIGN_TOKENS: readonly RecipeToken[] = [
  // Surfaces: layered near-black with blue/steel tints, darkest at the page base.
  { name: '--color-bg-0', value: '#05070a', why: 'page base; deepest near-black with a blue tint' },
  { name: '--color-bg-1', value: '#0a0d13', why: 'default section background' },
  { name: '--color-bg-2', value: '#10151d', why: 'raised surface (bands, wells)' },
  { name: '--color-steel-1', value: '#161d29', why: 'steel panel for cards and solid navs' },
  { name: '--color-steel-2', value: '#1e2735', why: 'lighter steel for hover states and the highlighted pricing tier' },
  // Text.
  { name: '--color-text-hi', value: '#f4f7fb', why: 'headlines and high-emphasis text' },
  { name: '--color-text', value: '#c6cdd9', why: 'body text; AA on bg-0/bg-1' },
  { name: '--color-muted', value: '#8d96a8', why: 'captions and secondary text; never go dimmer than this' },
  // Accents: one vivid cool, one warm metallic.
  { name: '--color-accent', value: '#5e8cff', why: 'the vivid accent: primary buttons, glows, gradient stops' },
  { name: '--color-accent-text', value: '#9db8ff', why: 'AA-safe accent for text and icons on dark surfaces' },
  { name: '--color-warm', value: '#f2a65a', why: 'the warm metallic accent: highlights, warm gradient stop, small details' },
  { name: '--color-on-accent', value: '#05070a', why: 'text and icons on top of solid accent fills' },
  // Hairlines and glass.
  { name: '--color-line', value: 'rgba(154, 168, 196, 0.16)', why: 'hairline borders on solid surfaces' },
  { name: '--glass-bg', value: 'rgba(18, 23, 32, 0.55)', why: 'glass fill for nav and cards; pair with backdrop-filter blur' },
  { name: '--glass-line', value: 'rgba(255, 255, 255, 0.09)', why: 'glass border; upgrade to a gradient hairline on feature cards' },
  // Elevation.
  { name: '--shadow-1', value: '0 1px 2px rgba(0, 0, 0, 0.5)', why: 'resting elevation for chips and inputs' },
  { name: '--shadow-2', value: '0 12px 32px -12px rgba(0, 0, 0, 0.65)', why: 'card elevation' },
  { name: '--shadow-3', value: '0 24px 64px -16px rgba(0, 0, 0, 0.7)', why: 'floating elevation: nav, highlighted tier, CTAs on hover' },
  { name: '--glow-accent', value: '0 0 32px rgba(94, 140, 255, 0.28)', why: 'accent glow for primary CTAs and hover states' },
  // Radii.
  { name: '--radius-s', value: '8px', why: 'chips, inputs, small cards' },
  { name: '--radius-m', value: '14px', why: 'cards and buttons' },
  { name: '--radius-l', value: '22px', why: 'feature panels and the hero visual' },
  { name: '--radius-pill', value: '999px', why: 'eyebrows, pills, avatar rings' },
  // Spacing scale.
  { name: '--space-1', value: '0.25rem', why: 'hairline gaps' },
  { name: '--space-2', value: '0.5rem', why: 'tight inner gaps' },
  { name: '--space-3', value: '0.75rem', why: 'control padding' },
  { name: '--space-4', value: '1rem', why: 'default gap' },
  { name: '--space-5', value: '1.5rem', why: 'card padding' },
  { name: '--space-6', value: '2rem', why: 'cluster gaps' },
  { name: '--space-7', value: '3rem', why: 'section inner spacing' },
  { name: '--space-8', value: '4.5rem', why: 'section padding (mobile)' },
  { name: '--space-9', value: '7rem', why: 'section padding (desktop)' },
  // Fluid type.
  { name: '--font-display', value: '"Space Grotesk", "Inter", system-ui, sans-serif', why: 'display headings and stat numbers' },
  { name: '--font-body', value: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif', why: 'body and UI text' },
  { name: '--step--1', value: 'clamp(0.83rem, 0.79rem + 0.2vw, 0.94rem)', why: 'eyebrows, captions, fine print' },
  { name: '--step-0', value: 'clamp(1rem, 0.95rem + 0.25vw, 1.13rem)', why: 'body' },
  { name: '--step-1', value: 'clamp(1.2rem, 1.1rem + 0.5vw, 1.5rem)', why: 'large body, card titles' },
  { name: '--step-2', value: 'clamp(1.44rem, 1.25rem + 0.95vw, 2rem)', why: 'sub-headings' },
  { name: '--step-3', value: 'clamp(1.73rem, 1.4rem + 1.65vw, 2.75rem)', why: 'section headings' },
  { name: '--step-4', value: 'clamp(2.07rem, 1.55rem + 2.6vw, 3.75rem)', why: 'hero display headline' },
  // Layout.
  { name: '--container', value: '72rem', why: 'max content width' },
  { name: '--nav-height', value: '4.25rem', why: 'sticky nav height; anchor scroll-margin derives from it' },
  // Motion.
  { name: '--dur-fast', value: '160ms', why: 'micro-interactions: hovers, presses' },
  { name: '--dur-med', value: '340ms', why: 'reveals, menu transitions' },
  { name: '--dur-slow', value: '720ms', why: 'hero entrances, counters settle' },
  { name: '--ease-out', value: 'cubic-bezier(0.22, 1, 0.36, 1)', why: 'the house easing: fast attack, long soft settle' },
  // Focus.
  { name: '--ring', value: '0 0 0 2px var(--color-bg-0), 0 0 0 4px var(--color-accent)', why: ':focus-visible ring, visible on every surface' },
];

/**
 * The :root block the design role writes. Hand-kept for readability
 * (grouped, commented); the test suite enforces it stays in exact sync
 * with DESIGN_TOKENS.
 */
export const TOKEN_CSS = `:root {
  /* Surfaces: layered near-black with blue/steel tints, darkest at the page base */
  --color-bg-0: #05070a;
  --color-bg-1: #0a0d13;
  --color-bg-2: #10151d;
  --color-steel-1: #161d29;
  --color-steel-2: #1e2735;

  /* Text */
  --color-text-hi: #f4f7fb;
  --color-text: #c6cdd9;
  --color-muted: #8d96a8;

  /* Accents: one vivid cool, one warm metallic */
  --color-accent: #5e8cff;
  --color-accent-text: #9db8ff;
  --color-warm: #f2a65a;
  --color-on-accent: #05070a;

  /* Hairlines and glass */
  --color-line: rgba(154, 168, 196, 0.16);
  --glass-bg: rgba(18, 23, 32, 0.55);
  --glass-line: rgba(255, 255, 255, 0.09);

  /* Elevation */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.5);
  --shadow-2: 0 12px 32px -12px rgba(0, 0, 0, 0.65);
  --shadow-3: 0 24px 64px -16px rgba(0, 0, 0, 0.7);
  --glow-accent: 0 0 32px rgba(94, 140, 255, 0.28);

  /* Radii */
  --radius-s: 8px;
  --radius-m: 14px;
  --radius-l: 22px;
  --radius-pill: 999px;

  /* Spacing scale */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4.5rem;
  --space-9: 7rem;

  /* Fluid type (clamp steps, no breakpoint jumps) */
  --font-display: "Space Grotesk", "Inter", system-ui, sans-serif;
  --font-body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --step--1: clamp(0.83rem, 0.79rem + 0.2vw, 0.94rem);
  --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.13rem);
  --step-1: clamp(1.2rem, 1.1rem + 0.5vw, 1.5rem);
  --step-2: clamp(1.44rem, 1.25rem + 0.95vw, 2rem);
  --step-3: clamp(1.73rem, 1.4rem + 1.65vw, 2.75rem);
  --step-4: clamp(2.07rem, 1.55rem + 2.6vw, 3.75rem);

  /* Layout */
  --container: 72rem;
  --nav-height: 4.25rem;

  /* Motion */
  --dur-fast: 160ms;
  --dur-med: 340ms;
  --dur-slow: 720ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

  /* Focus */
  --ring: 0 0 0 2px var(--color-bg-0), 0 0 0 4px var(--color-accent);
}`;

export const MOTION_FEATURES: readonly MotionFeature[] = [
  {
    id: 'aurora-background',
    owner: 'css',
    summary:
      'a slow-drifting aurora layer behind the page: two or three large radial-gradient color fields (accent and warm, heavily blurred, fixed position) on a 30s+ transform keyframe; pure decoration, aria-hidden, pointer-events none',
  },
  {
    id: 'gradient-headline',
    owner: 'css',
    summary:
      'the hero headline carries an animated gradient via background-clip: text with a slow background-position keyframe; gradient stops come from the accent and warm tokens',
  },
  {
    id: 'card-hover-glow',
    owner: 'css',
    summary:
      'cards lift with translateY and reveal a gradient border-glow on hover and focus-within, transitioning transform, box-shadow and border over --dur-med',
  },
  {
    id: 'cursor-glow',
    owner: 'js',
    summary:
      'a radial glow that follows the pointer over the hero: pointermove writes CSS custom properties (--glow-x/--glow-y) throttled by requestAnimationFrame; disabled on touch and coarse-pointer devices',
  },
  {
    id: 'scroll-reveal',
    owner: 'js',
    summary:
      'sections and cards fade and slide in via IntersectionObserver with a per-item stagger delay; JS arms the hidden state (class or data attribute) so content is fully visible when JS never runs',
  },
  {
    id: 'stat-counters',
    owner: 'js',
    summary:
      'stat numbers count up from zero to their data-count target when the stats band enters the viewport, with easing, locale-aware grouping, and an exact final value',
  },
  {
    id: 'logo-marquee',
    owner: 'js',
    summary:
      'the logo strip scrolls infinitely by duplicating its track in JS and translating it in a loop; pauses on hover and focus-within; falls back to a static wrapping row when animation is off',
  },
  {
    id: 'mobile-nav',
    owner: 'js',
    summary:
      'under the mobile breakpoint a hamburger button toggles the nav menu with aria-expanded kept in sync, Escape closes it, and choosing a link closes it',
  },
  {
    id: 'faq-accordion',
    owner: 'js',
    summary:
      'FAQ entries are native details/summary (fully usable without JS); JS adds smooth height animation and one-open-at-a-time behavior as a pure enhancement',
  },
  {
    id: 'smooth-anchors',
    owner: 'js',
    summary:
      'in-page anchor links scroll smoothly (scroll-behavior: smooth under no-preference, plus a JS fallback) with scroll-margin-top offset for the sticky nav; every CTA resolves to a real section id',
  },
];

/** Comma-joined ids of the builder-owned motion features, for prompt text. */
export const JS_MOTION_FEATURE_IDS: string = MOTION_FEATURES.filter((f) => f.owner === 'js')
  .map((f) => f.id)
  .join(', ');

export const MOTION_SPEC: string = [
  'MOTION SYSTEM SPEC (animate transform and opacity only; everything below is disabled or instant under @media (prefers-reduced-motion: reduce); the page stays complete with JS disabled)',
  ...MOTION_FEATURES.map((f) => `- ${f.id} [${f.owner}]: ${f.summary}`),
].join('\n');

export const SECTION_BLUEPRINT: readonly BlueprintSection[] = [
  {
    id: 'nav',
    name: 'Sticky glass nav',
    spec: 'sticky top bar on a real glass surface (translucent fill, backdrop-filter blur, hairline bottom border): brand mark, section links, one compact CTA; collapses to a working hamburger on mobile',
  },
  {
    id: 'hero',
    name: 'Hero',
    spec: 'eyebrow pill, gradient display headline, one specific subhead, a primary + ghost CTA pair, and a hero visual (CSS/SVG product visual or a glow orb); the aurora and cursor glow live here',
  },
  {
    id: 'logos',
    name: 'Logo marquee',
    spec: 'trust strip of customer or partner wordmarks (styled text or inline SVG), scrolling infinitely with pause-on-hover; muted so it supports rather than shouts',
  },
  {
    id: 'features',
    name: 'Features grid',
    spec: 'six cards in a responsive grid; each card has an inline SVG icon, a concrete benefit headline, and one sentence of proof',
  },
  {
    id: 'stats',
    name: 'Stats band',
    spec: 'three or four metrics on a steel band, each an animated counter with a real unit and a short label',
  },
  {
    id: 'showcase',
    name: 'Showcase split',
    spec: 'alternating split section: copy on one side, a CSS/SVG visual on the other; the deep-dive moment of the page',
  },
  {
    id: 'testimonials',
    name: 'Testimonials',
    spec: 'one to three quotes with name, role and company; specific outcomes and numbers, never generic praise',
  },
  {
    id: 'pricing',
    name: 'Pricing',
    spec: 'three tiers with real prices and feature lists; the middle tier is visually highlighted as the recommended plan',
  },
  {
    id: 'faq',
    name: 'FAQ',
    spec: 'four to six questions as styled details/summary entries answering real objections',
  },
  {
    id: 'cta',
    name: 'CTA band',
    spec: 'closing conversion band: one strong line, one primary button, gradient and glow treatment',
  },
  {
    id: 'footer',
    name: 'Footer',
    spec: 'brand, link columns, legal line; a quiet steel surface with a hairline top border',
  },
];

export const BLUEPRINT_SPEC: string = [
  'SECTION BLUEPRINT (the landing page skeleton, in this order)',
  ...SECTION_BLUEPRINT.map((s) => `- #${s.id} ${s.name}: ${s.spec}`),
].join('\n');

export const ICON_RULES = `INLINE SVG ICON RULES
- Inline <svg> only: no icon fonts, no external icon files, no <img> icons, no emojis standing in as icons.
- stroke="currentColor", stroke-width="1.5", fill="none", round linecaps and linejoins; rendered 20-24px square with a matching viewBox.
- Decorative icons get aria-hidden="true"; a meaningful icon gets role="img" and an accessible name.`;

export const HARD_RULES = `HARD RULES (non-negotiable on every Foundry site)
- Dependency-free: no external scripts, frameworks, CSS libraries or icon sets. One Google Fonts stylesheet <link> (with its preconnect hints) is the only permitted external request; images only from URLs the brief supplies.
- No lorem ipsum, no placeholder text or images, no TODOs; every stat, price and quote must be specific to the brief.
- Mobile-first responsive; the nav collapses to a working hamburger that toggles the menu via JS.
- AA contrast on the dark palette: body text >= 4.5:1 and large/display text >= 3:1 against its actual surface; accent-colored text uses --color-accent-text, never raw --color-accent, on dark fills.
- Motion respects the user: every animation and transition is disabled or instant under prefers-reduced-motion: reduce, and the page is fully readable and navigable with JS disabled.
- Print-safe basics: an @media print block that lightens backgrounds, darkens text, hides decorative layers (aurora, glows, marquee) and reveals collapsed content.
- Every CTA, button and link does something real: in-page anchors resolve to existing section ids; no dead controls.
- Animate transform and opacity only (GPU-friendly); never layout properties like width, height, top or left.`;

const SECTION_ORDER = SECTION_BLUEPRINT.map((s) => s.id).join(', ');
const CSS_MOTION_FEATURE_IDS = MOTION_FEATURES.filter((f) => f.owner === 'css')
  .map((f) => f.id)
  .join(', ');

export const REVIEW_CHECKLIST = `RECIPE CHECKLIST (fail the build on any violation)
- Tokens: :root defines the full recipe token system (surfaces, text, accents, glass, elevation, radii, spacing, fluid type steps, motion durations, focus ring) and components consume tokens instead of ad-hoc values.
- Blueprint: every section present in order (${SECTION_ORDER}); nav is sticky glass; pricing has a visually highlighted middle tier; FAQ uses details/summary.
- Motion present and wired: ${JS_MOTION_FEATURE_IDS} actually run from app.js; ${CSS_MOTION_FEATURE_IDS} exist in CSS.
- Reduced motion: @media (prefers-reduced-motion: reduce) disables every animation and transition and reveals all content; JS gates motion work behind matchMedia; nothing stays hidden with animation off or JS disabled.
- Glass is real: nav and cards use translucent backgrounds with backdrop-filter blur and hairline (gradient) borders, not flat solid fills.
- Responsive: mobile-first with min-width breakpoints; the hamburger toggles the menu with aria-expanded in sync; no horizontal overflow at 360px.
- Contrast: body text >= 4.5:1 and large text >= 3:1 on their actual dark surfaces; accent text uses the AA-safe accent token.
- Copy: no lorem ipsum, no placeholders, no TODOs; stats, prices and testimonials are specific to the brief; every CTA, button and link resolves to a real target.
- Icons: inline SVG only, stroke 1.5, currentColor, 20-24px; no emojis as icons.
- Print: an @media print block produces a legible light page.`;

export const PREMIUM_DESIGN_RECIPE: string = [
  'FOUNDRY PREMIUM DESIGN RECIPE',
  'The single source of truth for every site Foundry ships: dark metallic surfaces, real glass, gradient accents, honest dependency-free motion. Everything below is implementable with plain html/css/js.',
  `TOKEN SYSTEM\n${TOKEN_CSS}`,
  MOTION_SPEC,
  BLUEPRINT_SPEC,
  ICON_RULES,
  HARD_RULES,
].join('\n\n');
