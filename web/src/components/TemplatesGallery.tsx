import { useState, type CSSProperties } from 'react';
import { useRovingTabindex } from '../a11y';

export type RecipeId = 'landing' | 'portfolio' | 'saas' | 'blog' | 'docs';

export interface TemplateRecipe {
  id: RecipeId;
  label: string;
  tagline: string;
  brief: string;
}

export const TEMPLATE_RECIPES: readonly TemplateRecipe[] = [
  {
    id: 'landing',
    label: 'Landing',
    tagline: 'Hero, features, call to action',
    brief:
      'A landing page for a new product: bold hero with a headline, subline and one primary call to action, three feature sections with icons, a testimonial strip, a pricing teaser, and a footer with contact links. Dark premium look, smooth scroll-in animations, mobile-first.',
  },
  {
    id: 'portfolio',
    label: 'Portfolio',
    tagline: 'Project gallery and about',
    brief:
      'A portfolio site for a freelance designer: full-width hero with name and discipline, a project gallery with hover reveals and short case-study blurbs, an about section with a portrait placeholder, and a contact footer. Generous whitespace, elegant motion, strong typography.',
  },
  {
    id: 'saas',
    label: 'SaaS',
    tagline: 'Product page with pricing',
    brief:
      'A SaaS marketing site for a team productivity app: hero with a product screenshot mock and email signup, a logo cloud, a feature grid with icons, animated stat counters, a three-tier pricing table, an FAQ accordion, and a call-to-action footer. Crisp, modern, trustworthy.',
  },
  {
    id: 'blog',
    label: 'Blog',
    tagline: 'Reading-first layout',
    brief:
      'A personal blog: header with navigation, a featured-post hero, a card grid of recent posts with tags and dates, an about-the-author sidebar, a newsletter signup band, and a simple footer. Reading-first typography, subtle fade-ins, fast and accessible.',
  },
  {
    id: 'docs',
    label: 'Docs',
    tagline: 'Sidebar nav and code blocks',
    brief:
      'A documentation site for a CLI tool: fixed left sidebar with section navigation, a getting-started hero, content pages with code examples, callout boxes and copy buttons, plus a search box in the header. Clean, information-dense, dark theme.',
  },
];

const ICON_PROPS = {
  className: 'tpl-chip-icon',
  viewBox: '0 0 14 14',
  width: 13,
  height: 13,
  'aria-hidden': true,
  focusable: false,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Compact 14px stroke glyphs, one per recipe. */
function RecipeIcon({ id }: { id: RecipeId }) {
  switch (id) {
    case 'landing':
      return (
        <svg {...ICON_PROPS}>
          <path d="M4 12.5V2.5" />
          <path d="M4 3h6.2L8.4 5.5l1.8 2.5H4" />
        </svg>
      );
    case 'portfolio':
      return (
        <svg {...ICON_PROPS}>
          <rect x="2" y="2" width="4.2" height="4.2" rx="1" />
          <rect x="7.8" y="2" width="4.2" height="4.2" rx="1" />
          <rect x="2" y="7.8" width="4.2" height="4.2" rx="1" />
          <rect x="7.8" y="7.8" width="4.2" height="4.2" rx="1" />
        </svg>
      );
    case 'saas':
      return (
        <svg {...ICON_PROPS}>
          <path d="M2.5 12V8.5" />
          <path d="M7 12V6" />
          <path d="M11.5 12V2.5" />
        </svg>
      );
    case 'blog':
      return (
        <svg {...ICON_PROPS}>
          <path d="M2.5 3.5h9" />
          <path d="M2.5 7h9" />
          <path d="M2.5 10.5h5.5" />
        </svg>
      );
    case 'docs':
      return (
        <svg {...ICON_PROPS}>
          <rect x="2" y="2" width="10" height="10" rx="1.5" />
          <path d="M5.8 2v10" />
        </svg>
      );
  }
}

function DiceIcon() {
  return (
    <svg {...ICON_PROPS} className="tpl-chip-icon tpl-chip-icon--dice">
      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" />
      <circle cx="4.8" cy="4.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="9.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Screen-reader-only live region (no shared utility class exists yet). */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

interface TemplatesGalleryProps {
  disabled?: boolean;
  /** prefill the composer with the recipe's starting brief */
  onPick: (brief: string) => void;
}

/**
 * The hero's template chips row: one pill per recipe plus a 'surprise me'
 * dice chip that cycles recipe briefs into the composer. Composite widget:
 * one Tab stop, ArrowLeft/ArrowRight (+ Home/End) move between chips.
 */
export function TemplatesGallery({ disabled = false, onPick }: TemplatesGalleryProps) {
  const [cycle, setCycle] = useState(0);
  const [announce, setAnnounce] = useState('');
  const roving = useRovingTabindex<HTMLButtonElement>(TEMPLATE_RECIPES.length + 1, 'horizontal', {
    wrap: true,
  });

  function surprise() {
    const recipe = TEMPLATE_RECIPES[cycle % TEMPLATE_RECIPES.length];
    setCycle((c) => c + 1);
    setAnnounce(`Brief loaded: ${recipe.label}.`);
    onPick(recipe.brief);
  }

  return (
    <div className="tpl-chips" role="group" aria-label="Start from a template">
      <ul className="tpl-chips-list" {...roving.containerProps}>
        {TEMPLATE_RECIPES.map((t, i) => (
          <li key={t.id}>
            <button
              type="button"
              className="tpl-chip"
              disabled={disabled}
              title={`${t.label}: ${t.tagline}`}
              onClick={() => onPick(t.brief)}
              {...roving.getItemProps(i)}
            >
              <RecipeIcon id={t.id} />
              <span className="tpl-chip-label">{t.label}</span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="tpl-chip tpl-chip--dice"
            disabled={disabled}
            title="Surprise me: cycle template briefs into the composer"
            aria-label="Surprise me: fill the composer with the next template brief"
            onClick={surprise}
            {...roving.getItemProps(TEMPLATE_RECIPES.length)}
          >
            <DiceIcon />
            <span className="tpl-chip-label">Surprise me</span>
          </button>
        </li>
      </ul>
      <span style={SR_ONLY} role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
