import type { SVGProps } from 'react';

/**
 * Foundry shared stroke-icon set.
 *
 * One registry entry per icon (`ICON_PATHS`): an array of path-data strings
 * on a 24x24 grid, stroke 1.5, round caps/joins, `currentColor` -- icons
 * inherit the surrounding text color and stay crisp at 16px and 20px.
 *
 * Usage:
 *   import { Icon } from './icons';
 *   <Icon name="send" />
 *   <Icon name="desktop" size={20} />
 *
 *   // or the named wrappers (same props minus `name`):
 *   import { SendIcon, FileCodeIcon } from './icons';
 *   <SendIcon size={20} className="composer-send-icon" />
 *
 * Accessibility:
 * - Icons are decorative by default (`aria-hidden`) -- label the parent
 *   button/link instead (`aria-label="Send"`).
 * - Pass `title` only when the icon stands alone as meaningful content;
 *   it then renders `role="img"` with an SVG `<title>`.
 *
 * Motion:
 * - `name="spinner"` renders a static arc. Rotate it from CSS
 *   (`.icon-spinner { animation: icon-spin 0.8s linear infinite }`) and
 *   gate that animation behind `prefers-reduced-motion: no-preference`.
 */

export type IconName =
  | 'home'
  | 'send'
  | 'wand'
  | 'at'
  | 'mic'
  | 'queue'
  | 'pause'
  | 'play'
  | 'stop'
  | 'check'
  | 'spinner'
  | 'error'
  | 'warn'
  | 'info'
  | 'file-code'
  | 'file-css'
  | 'file-html'
  | 'file-js'
  | 'file-md'
  | 'folder'
  | 'search'
  | 'close'
  | 'download'
  | 'external'
  | 'refresh'
  | 'mobile'
  | 'tablet'
  | 'desktop'
  | 'console'
  | 'code'
  | 'eye'
  | 'history'
  | 'plus'
  | 'trash'
  | 'lock'
  | 'copy';

/**
 * Path data per icon (24x24 grid). Everything is a path -- circles and
 * rects are expressed as arc paths -- so the data can be reused outside
 * React (sprite sheets, favicons, email HTML).
 */
export const ICON_PATHS: Record<IconName, readonly string[]> = {
  home: [
    'M3.8 10.4 12 3.6l8.2 6.8',
    'M5.6 9v10.4c0 .6.4 1 1 1h10.8c.6 0 1-.4 1-1V9',
    'M9.8 20.4V15c0-.3.2-.5.5-.5h3.4c.3 0 .5.2.5.5v5.4',
  ],
  send: ['M20.6 3.4 10.5 13.5', 'M20.6 3.4 14 20.6l-3.5-7.1-7.1-3.5L20.6 3.4Z'],
  wand: [
    'M4.6 19.4 14.8 9.2',
    'M17.9 2.9l.7 1.85 1.85.7-1.85.7-.7 1.85-.7-1.85-1.85-.7 1.85-.7.7-1.85Z',
    'M11.5 4.2l.4 1.05 1.05.4-1.05.4-.4 1.05-.4-1.05-1.05-.4 1.05-.4.4-1.05Z',
  ],
  at: [
    'M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z',
    'M15.3 8.7v4.3a2.7 2.7 0 0 0 5.4 0v-1a8.3 8.3 0 1 0-3.3 6.6',
  ],
  mic: [
    'M12 3.4a2.6 2.6 0 0 0-2.6 2.6v5a2.6 2.6 0 0 0 5.2 0V6a2.6 2.6 0 0 0-2.6-2.6Z',
    'M6.4 11a5.6 5.6 0 0 0 11.2 0',
    'M12 16.6v2.9',
    'M9 19.5h6',
  ],
  queue: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h10'],
  pause: ['M9.3 5.5v13', 'M14.7 5.5v13'],
  play: [
    'M8.2 5.4v13.2c0 .62.68.99 1.2.66l10.3-6.6a.78.78 0 0 0 0-1.32L9.4 4.74c-.52-.33-1.2.04-1.2.66Z',
  ],
  stop: ['M8.3 6.3h7.4a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H8.3a2 2 0 0 1-2-2V8.3a2 2 0 0 1 2-2Z'],
  check: ['M4.6 12.7l4.8 4.8L19.4 6.4'],
  spinner: ['M12 3.6a8.4 8.4 0 1 1-8.15 6.34'],
  error: [
    'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Z',
    'M9.1 9.1l5.8 5.8',
    'M14.9 9.1l-5.8 5.8',
  ],
  warn: [
    'M10.6 4.8 3.4 17.3a1.6 1.6 0 0 0 1.4 2.4h14.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.8a1.6 1.6 0 0 0-2.8 0Z',
    'M12 9.6v4.2',
    'M12 16.9h.01',
  ],
  info: [
    'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Z',
    'M12 8h.01',
    'M12 11.2v5',
  ],
  'file-code': [
    'M13.2 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.3l-5.3-4.8Z',
    'M13.2 3.5v4.8h5.3',
    'M10.4 12.9c-.9 0-1.2.4-1.2 1.1v.8c0 .5-.3.8-.7.9.4.1.7.4.7.9v.8c0 .7.3 1.1 1.2 1.1',
    'M13.6 12.9c.9 0 1.2.4 1.2 1.1v.8c0 .5.3.8.7.9-.4.1-.7.4-.7.9v.8c0 .7-.3 1.1-1.2 1.1',
  ],
  'file-css': [
    'M13.2 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.3l-5.3-4.8Z',
    'M13.2 3.5v4.8h5.3',
    'M10.4 13.2l-.8 4.8',
    'M13.9 13.2l-.8 4.8',
    'M9.2 14.9h5.6',
    'M9 16.8h5.6',
  ],
  'file-html': [
    'M13.2 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.3l-5.3-4.8Z',
    'M13.2 3.5v4.8h5.3',
    'M10 13.2 8.2 15.3l1.8 2.1',
    'M14 13.2l1.8 2.1-1.8 2.1',
    'M12.8 12.8l-1.6 5',
  ],
  'file-js': [
    'M13.2 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.3l-5.3-4.8Z',
    'M13.2 3.5v4.8h5.3',
    'M12.7 12.6 10.2 15.6h1.9l-.6 2.9 2.6-3.2h-1.9l.5-2.7Z',
  ],
  'file-md': [
    'M13.2 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.3l-5.3-4.8Z',
    'M13.2 3.5v4.8h5.3',
    'M8.6 13.4h6.8',
    'M8.6 15.7h6.8',
    'M8.6 18h4.1',
  ],
  folder: [
    'M3.6 6.4c0-.9.7-1.6 1.6-1.6h3.9c.4 0 .8.2 1.1.5l1.8 2h6.4c.9 0 1.6.7 1.6 1.6v8.4c0 .9-.7 1.6-1.6 1.6H5.2c-.9 0-1.6-.7-1.6-1.6V6.4Z',
  ],
  search: ['M10.6 4.4a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4Z', 'M15.3 15.3 19.8 19.8'],
  close: ['M5.8 5.8l12.4 12.4', 'M18.2 5.8 5.8 18.2'],
  download: [
    'M12 3.6v10.2',
    'M7.4 9.9 12 14.5l4.6-4.6',
    'M4.4 16.8v1.6c0 1 .8 1.8 1.8 1.8h11.6c1 0 1.8-.8 1.8-1.8v-1.6',
  ],
  external: [
    'M18.6 13.2v5c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8V7.2c0-1 .8-1.8 1.8-1.8h5',
    'M19.6 4.4 11 13',
    'M13.6 4.4h6v6',
  ],
  refresh: [
    'M20.3 4.6v4.7h-4.7',
    'M3.7 19.4v-4.7h4.7',
    'M4.2 9.3a8.3 8.3 0 0 1 14.2-3.2l1.3 2.7',
    'M19.8 14.7a8.3 8.3 0 0 1-14.2 3.2l-1.3-2.7',
  ],
  mobile: [
    'M8 3.4h8c.9 0 1.6.7 1.6 1.6v14c0 .9-.7 1.6-1.6 1.6H8c-.9 0-1.6-.7-1.6-1.6V5c0-.9.7-1.6 1.6-1.6Z',
    'M10.8 17.6h2.4',
  ],
  tablet: [
    'M5.6 2.9h12.8c.9 0 1.6.7 1.6 1.6v15c0 .9-.7 1.6-1.6 1.6H5.6c-.9 0-1.6-.7-1.6-1.6v-15C4 3.6 4.7 2.9 5.6 2.9Z',
    'M10.9 17.9h2.2',
  ],
  desktop: [
    'M4.2 4.2h15.6c.9 0 1.6.7 1.6 1.6v8.8c0 .9-.7 1.6-1.6 1.6H4.2c-.9 0-1.6-.7-1.6-1.6V5.8c0-.9.7-1.6 1.6-1.6Z',
    'M12 16.2v3.4',
    'M8.8 19.6h6.4',
  ],
  console: [
    'M4.6 4.4h14.8c.9 0 1.6.7 1.6 1.6v12c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V6c0-.9.7-1.6 1.6-1.6Z',
    'M6.8 9.2 9.8 12.2l-3 3',
    'M13 15.2h4.2',
  ],
  code: ['M8.6 7.4 4 12l4.6 4.6', 'M15.4 7.4 20 12l-4.6 4.6'],
  eye: [
    'M2.9 12S6.3 5.7 12 5.7 21.1 12 21.1 12 17.7 18.3 12 18.3 2.9 12 2.9 12Z',
    'M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z',
  ],
  history: [
    'M4.1 4.4v4.3h4.3',
    'M4.7 9A8.1 8.1 0 1 1 3.9 12.3',
    'M12 7.6V12l3.1 2',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: [
    'M4.4 6.6h15.2',
    'M9 6.4V5.2c0-.7.5-1.2 1.2-1.2h3.6c.7 0 1.2.5 1.2 1.2v1.2',
    'M6.4 6.6l.8 12.1c.1 1 .9 1.7 1.9 1.7h5.8c1 0 1.8-.8 1.9-1.7l.8-12.1',
    'M10 10.4v6.2',
    'M14 10.4v6.2',
  ],
  lock: [
    'M6.4 10.2h11.2c.9 0 1.6.7 1.6 1.6v6.6c0 .9-.7 1.6-1.6 1.6H6.4c-.9 0-1.6-.7-1.6-1.6v-6.6c0-.9.7-1.6 1.6-1.6Z',
    'M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6',
    'M12 14.8h.01',
  ],
  copy: [
    'M11.2 9.4h7.4c1 0 1.8.8 1.8 1.8v7.4c0 1-.8 1.8-1.8 1.8h-7.4c-1 0-1.8-.8-1.8-1.8v-7.4c0-1 .8-1.8 1.8-1.8Z',
    'M8.6 14.6H5.4c-1 0-1.8-.8-1.8-1.8V5.4c0-1 .8-1.8 1.8-1.8h7.4c1 0 1.8.8 1.8 1.8v3.2',
  ],
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'strokeWidth'> {
  /** Which glyph to draw. */
  name: IconName;
  /** Render size in px (square). Default 16; 16 and 20 are the sweet spots. */
  size?: number;
  /** Stroke width in viewBox units. Default 1.5 (1.0px at size 16). */
  strokeWidth?: number;
  /** Accessible name. Omit for a decorative (aria-hidden) icon. */
  title?: string;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.5,
  title,
  className,
  ...rest
}: IconProps) {
  const titleId = `fd-icon-title-${name}-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon icon-${name} ${className}` : `icon icon-${name}`}
      focusable="false"
      {...(title ? { role: 'img', 'aria-labelledby': titleId } : { 'aria-hidden': true })}
      {...rest}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export type IconGlyphProps = Omit<IconProps, 'name'>;

function createIcon(name: IconName, displayName: string) {
  function Glyph(props: IconGlyphProps) {
    return <Icon name={name} {...props} />;
  }
  Glyph.displayName = displayName;
  return Glyph;
}

export const HomeIcon = createIcon('home', 'HomeIcon');
export const SendIcon = createIcon('send', 'SendIcon');
export const WandIcon = createIcon('wand', 'WandIcon');
export const AtIcon = createIcon('at', 'AtIcon');
export const MicIcon = createIcon('mic', 'MicIcon');
export const QueueIcon = createIcon('queue', 'QueueIcon');
export const PauseIcon = createIcon('pause', 'PauseIcon');
export const PlayIcon = createIcon('play', 'PlayIcon');
export const StopIcon = createIcon('stop', 'StopIcon');
export const CheckIcon = createIcon('check', 'CheckIcon');
export const SpinnerIcon = createIcon('spinner', 'SpinnerIcon');
export const ErrorIcon = createIcon('error', 'ErrorIcon');
export const WarnIcon = createIcon('warn', 'WarnIcon');
export const InfoIcon = createIcon('info', 'InfoIcon');
export const FileCodeIcon = createIcon('file-code', 'FileCodeIcon');
export const FileCssIcon = createIcon('file-css', 'FileCssIcon');
export const FileHtmlIcon = createIcon('file-html', 'FileHtmlIcon');
export const FileJsIcon = createIcon('file-js', 'FileJsIcon');
export const FileMdIcon = createIcon('file-md', 'FileMdIcon');
export const FolderIcon = createIcon('folder', 'FolderIcon');
export const SearchIcon = createIcon('search', 'SearchIcon');
export const CloseIcon = createIcon('close', 'CloseIcon');
export const DownloadIcon = createIcon('download', 'DownloadIcon');
export const ExternalIcon = createIcon('external', 'ExternalIcon');
export const RefreshIcon = createIcon('refresh', 'RefreshIcon');
export const MobileIcon = createIcon('mobile', 'MobileIcon');
export const TabletIcon = createIcon('tablet', 'TabletIcon');
export const DesktopIcon = createIcon('desktop', 'DesktopIcon');
export const ConsoleIcon = createIcon('console', 'ConsoleIcon');
export const CodeIcon = createIcon('code', 'CodeIcon');
export const EyeIcon = createIcon('eye', 'EyeIcon');
export const HistoryIcon = createIcon('history', 'HistoryIcon');
export const PlusIcon = createIcon('plus', 'PlusIcon');
export const TrashIcon = createIcon('trash', 'TrashIcon');
export const LockIcon = createIcon('lock', 'LockIcon');
export const CopyIcon = createIcon('copy', 'CopyIcon');
