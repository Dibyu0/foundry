import { useId } from 'react';

/**
 * Foundry brand mark: an abstract flame over an anvil (beam, stem, base),
 * drawn on a 24x24 grid. Stays crisp from 16px to 48px.
 *
 * Two variants:
 * - `mono` (default): flat `currentColor`, inherits the surrounding text
 *   color. Use in the top bar and anywhere the mark sits on tinted chrome.
 * - `gradient`: aurora sweep (molten gold -> foundry ember -> aurora
 *   blue-violet) in one continuous userSpace gradient across the whole
 *   mark. Use on the hero and other large brand moments.
 *
 * The mark is decorative by default (`aria-hidden`). Pass `title` when it
 * stands alone as meaningful content (e.g. a logo link with no visible
 * label) and it renders `role="img"` with an SVG `<title>`.
 *
 * Usage:
 *   <Logo />                            top bar, 22px, currentColor
 *   <Logo size={40} variant="gradient" />  hero
 *   <Logo size={18} title="Foundry" />  standalone, accessible
 */

export type LogoVariant = 'mono' | 'gradient';

export interface LogoProps {
  /** Render size in px (square). Crisp between 16 and 48. Default 22. */
  size?: number;
  /** `mono` = currentColor (default, back-compatible); `gradient` = aurora brand fill. */
  variant?: LogoVariant;
  /** Accessible name. Omit for a decorative (aria-hidden) mark. */
  title?: string;
  className?: string;
}

/** Raw path data of the mark, exported for favicon/splash reuse. */
export const LOGO_PATHS = {
  flame:
    'M10.5 2.4c.85 1.8 2.9 3.05 2.9 5.25a2.9 2.9 0 1 1-5.8 0c0-1 .4-1.9 1.03-2.53.32.8.83 1.32 1.87 1.72-.01-1.48-.01-2.96 0-4.44Z',
  beam: 'M3.6 12.3H15c2.1 0 4 .7 5.4 1.8-1.9.9-3.9 1.4-6 1.4H3.6a.8.8 0 0 1-.8-.8v-1.6c0-.44.36-.8.8-.8Z',
  stem: 'M7.2 16.3h4.6l-.7 1.9H7.9l-.7-1.9Z',
  base: 'M5.2 19h8.6c.55 0 1 .45 1 1v.2c0 .55-.45 1-1 1H5.2c-.55 0-1-.45-1-1v-.2c0-.55.45-1 1-1Z',
} as const;

export function Logo({ size = 22, variant = 'mono', title, className }: LogoProps) {
  // useId keeps the gradient id unique when several Logos share the page.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `fd-logo-gradient-${uid}`;
  const titleId = `fd-logo-title-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className ? `logo-mark ${className}` : 'logo-mark'}
      focusable="false"
      {...(title ? { role: 'img', 'aria-labelledby': titleId } : { 'aria-hidden': true })}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {variant === 'gradient' ? (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="5"
            y1="2"
            x2="19"
            y2="22"
          >
            <stop offset="0" stopColor="#ffc46b" />
            <stop offset="0.45" stopColor="#ff7a45" />
            <stop offset="1" stopColor="#7b8cff" />
          </linearGradient>
        </defs>
      ) : null}
      {variant === 'gradient' ? (
        <g fill={`url(#${gradientId})`}>
          <path d={LOGO_PATHS.flame} />
          <path d={LOGO_PATHS.beam} />
          <path d={LOGO_PATHS.stem} />
          <path d={LOGO_PATHS.base} />
        </g>
      ) : (
        <g fill="currentColor">
          <path d={LOGO_PATHS.flame} />
          <g opacity="0.62">
            <path d={LOGO_PATHS.beam} />
            <path d={LOGO_PATHS.stem} />
            <path d={LOGO_PATHS.base} />
          </g>
        </g>
      )}
    </svg>
  );
}
