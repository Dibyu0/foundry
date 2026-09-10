import { useEffect, useState, type ReactNode } from 'react';
import { TemplatesGallery } from './TemplatesGallery';

/**
 * Reactive prefers-reduced-motion flag. Drives the SVG aurora mark's
 * gradient animation; the CSS-only aurora background layer is switched
 * off by the matching media query in styles.css (owned by DESIGN).
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

interface AuroraMarkProps {
  /** When false the gradient stays static (reduced motion). */
  animated: boolean;
}

/** Inline SVG aurora mark: a four-point sparkle with a slowly cycling gradient. */
function AuroraMark({ animated }: AuroraMarkProps) {
  return (
    <svg className="hero-mark" viewBox="0 0 48 48" width="36" height="36" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hero-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff7a45">
            {animated && (
              <animate
                attributeName="stop-color"
                values="#ff7a45;#b26bff;#4cc9f0;#ff7a45"
                dur="12s"
                repeatCount="indefinite"
              />
            )}
          </stop>
          <stop offset="0.55" stopColor="#b26bff">
            {animated && (
              <animate
                attributeName="stop-color"
                values="#b26bff;#4cc9f0;#ff7a45;#b26bff"
                dur="12s"
                repeatCount="indefinite"
              />
            )}
          </stop>
          <stop offset="1" stopColor="#4cc9f0">
            {animated && (
              <animate
                attributeName="stop-color"
                values="#4cc9f0;#ff7a45;#b26bff;#4cc9f0"
                dur="12s"
                repeatCount="indefinite"
              />
            )}
          </stop>
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="21" fill="url(#hero-mark-gradient)" opacity="0.16" />
      <path
        fill="url(#hero-mark-gradient)"
        d="M24 5c1.8 9.8 8.2 16.2 18 18-9.8 1.8-16.2 8.2-18 18-1.8-9.8-8.2-16.2-18-18 9.8-1.8 16.2-8.2 18-18z"
      />
    </svg>
  );
}

interface HeroProps {
  /**
   * The composer node, owned and fully wired by App. The hero only
   * positions it; it never touches draft state or send logic.
   */
  composer: ReactNode;
  /** Disables the template chips (e.g. while a build is starting). */
  disabled?: boolean;
  /** Fill the composer with a recipe's starting brief. */
  onPickTemplate: (brief: string) => void;
}

/**
 * The centered home-first landing composition: aurora backdrop, mark,
 * display headline, the composer slot, and the template chips row.
 */
export function Hero({ composer, disabled = false, onPickTemplate }: HeroProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-aurora" aria-hidden="true">
        <span className="hero-aurora-blob hero-aurora-blob--a" />
        <span className="hero-aurora-blob hero-aurora-blob--b" />
        <span className="hero-aurora-blob hero-aurora-blob--c" />
      </div>

      <div className="hero-inner">
        <div className="hero-brand">
          <AuroraMark animated={!reduced} />
          <span className="hero-eyebrow">Agentic website builder</span>
        </div>

        <h1 className="hero-title" id="hero-title">
          Describe the site. <span className="hero-title-grad">Watch it get built.</span>
        </h1>

        <p className="hero-sub">
          Foundry plans, codes, reviews and ships your website from a single brief. You steer with plain
          language.
        </p>

        <div className="hero-composer">{composer}</div>

        <TemplatesGallery disabled={disabled} onPick={onPickTemplate} />
      </div>
    </section>
  );
}
