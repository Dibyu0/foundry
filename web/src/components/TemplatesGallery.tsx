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

const INK = 'rgba(255, 255, 255, 0.26)';
const INK_SOFT = 'rgba(255, 255, 255, 0.13)';
const INK_FAINT = 'rgba(255, 255, 255, 0.08)';
const ACCENT = 'rgba(255, 122, 69, 0.85)';
const ACCENT_SOFT = 'rgba(255, 122, 69, 0.4)';

function RecipePreview({ id }: { id: RecipeId }) {
  switch (id) {
    case 'landing':
      return (
        <svg className="tpl-svg" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
          <rect x="8" y="7" width="20" height="3" rx="1.5" fill={INK} />
          <rect x="88" y="7" width="16" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="18" width="42" height="5" rx="2" fill={INK} />
          <rect x="8" y="26" width="30" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="33" width="18" height="6" rx="3" fill={ACCENT} />
          <rect x="64" y="14" width="40" height="30" rx="3" fill={INK_FAINT} />
          <rect x="8" y="52" width="28" height="12" rx="2" fill={INK_FAINT} />
          <rect x="42" y="52" width="28" height="12" rx="2" fill={INK_FAINT} />
          <rect x="76" y="52" width="28" height="12" rx="2" fill={INK_FAINT} />
        </svg>
      );
    case 'portfolio':
      return (
        <svg className="tpl-svg" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
          <rect x="8" y="7" width="36" height="5" rx="2" fill={INK} />
          <rect x="8" y="15" width="24" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="24" width="46" height="18" rx="2" fill={INK_SOFT} />
          <rect x="58" y="24" width="46" height="18" rx="2" fill={ACCENT_SOFT} />
          <rect x="8" y="46" width="46" height="18" rx="2" fill={INK_FAINT} />
          <rect x="58" y="46" width="46" height="18" rx="2" fill={INK_SOFT} />
        </svg>
      );
    case 'saas':
      return (
        <svg className="tpl-svg" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
          <rect x="8" y="10" width="38" height="5" rx="2" fill={INK} />
          <rect x="8" y="18" width="28" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="26" width="24" height="6" rx="3" fill={INK_SOFT} />
          <rect x="34" y="26" width="12" height="6" rx="3" fill={ACCENT} />
          <rect x="56" y="8" width="48" height="30" rx="3" fill={INK_FAINT} />
          <rect x="61" y="13" width="38" height="4" rx="2" fill={INK_SOFT} />
          <rect x="61" y="20" width="26" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="46" width="30" height="20" rx="2" fill={INK_FAINT} />
          <rect x="41" y="46" width="30" height="20" rx="2" fill={ACCENT_SOFT} />
          <rect x="74" y="46" width="30" height="20" rx="2" fill={INK_FAINT} />
        </svg>
      );
    case 'blog':
      return (
        <svg className="tpl-svg" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
          <rect x="8" y="7" width="20" height="3" rx="1.5" fill={INK} />
          <rect x="84" y="7" width="20" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="8" y="14" width="96" height="16" rx="2" fill={INK_FAINT} />
          <rect x="12" y="23" width="40" height="3" rx="1.5" fill={INK} />
          <rect x="8" y="36" width="14" height="10" rx="2" fill={INK_SOFT} />
          <rect x="26" y="37" width="60" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="26" y="42" width="44" height="2" rx="1" fill={INK_FAINT} />
          <rect x="8" y="52" width="14" height="10" rx="2" fill={INK_SOFT} />
          <rect x="26" y="53" width="56" height="3" rx="1.5" fill={INK_SOFT} />
          <rect x="26" y="58" width="40" height="2" rx="1" fill={INK_FAINT} />
        </svg>
      );
    case 'docs':
      return (
        <svg className="tpl-svg" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
          <rect x="8" y="8" width="24" height="56" rx="2" fill={INK_FAINT} />
          <rect x="12" y="14" width="16" height="2" rx="1" fill={INK} />
          <rect x="12" y="20" width="12" height="2" rx="1" fill={INK_SOFT} />
          <rect x="12" y="26" width="14" height="2" rx="1" fill={INK_SOFT} />
          <rect x="12" y="32" width="10" height="2" rx="1" fill={INK_SOFT} />
          <rect x="38" y="10" width="44" height="5" rx="2" fill={INK} />
          <rect x="38" y="20" width="66" height="2" rx="1" fill={INK_SOFT} />
          <rect x="38" y="25" width="58" height="2" rx="1" fill={INK_FAINT} />
          <rect x="38" y="33" width="66" height="14" rx="2" fill={INK_FAINT} />
          <rect x="42" y="37" width="24" height="2" rx="1" fill={ACCENT} />
          <rect x="42" y="41" width="34" height="2" rx="1" fill={INK_SOFT} />
          <rect x="38" y="52" width="62" height="2" rx="1" fill={INK_SOFT} />
          <rect x="38" y="57" width="48" height="2" rx="1" fill={INK_FAINT} />
        </svg>
      );
  }
}

interface TemplatesGalleryProps {
  disabled?: boolean;
  /** prefill the composer with the recipe's starting brief */
  onPick: (brief: string) => void;
}

export function TemplatesGallery({ disabled = false, onPick }: TemplatesGalleryProps) {
  return (
    <div className="tpl-strip">
      <span className="tpl-title">Start from a recipe</span>
      <ul className="tpl-list">
        {TEMPLATE_RECIPES.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="tpl-card"
              disabled={disabled}
              title={`${t.label}: ${t.tagline}`}
              onClick={() => onPick(t.brief)}
            >
              <RecipePreview id={t.id} />
              <span className="tpl-label">{t.label}</span>
              <span className="tpl-tagline">{t.tagline}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
