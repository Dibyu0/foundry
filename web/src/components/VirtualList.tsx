import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  ForwardedRef,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefAttributes,
  UIEvent as ReactUIEvent,
} from 'react';

/** Visible row window [start, end) plus total scrollable height.
 *  Pure — candidate for web/src/lib/pure.ts (WEBTYPES) once unit tests land. */
export interface VirtualWindow {
  start: number;
  end: number;
  totalHeight: number;
}

export function computeWindow(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualWindow {
  const totalHeight = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0 || viewportHeight <= 0) return { start: 0, end: 0, totalHeight };
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const firstVisible = Math.floor(top / rowHeight);
  const lastVisible = Math.ceil((top + viewportHeight) / rowHeight);
  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(count, lastVisible + overscan),
    totalHeight,
  };
}

export interface VirtualListHandle {
  scrollToIndex: (index: number) => void;
  scrollToBottom: () => void;
  focus: () => void;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  overscan?: number;
  getKey?: (item: T, index: number) => string | number;
  /** Stay pinned to the bottom while the user is at the bottom and items append. */
  stickToBottom?: boolean;
  className?: string;
  style?: CSSProperties;
  role?: string;
  ariaLabel?: string;
  ariaActiveDescendant?: string;
  tabIndex?: number;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function VirtualListInner<T>(props: VirtualListProps<T>, ref: ForwardedRef<VirtualListHandle>) {
  const {
    items,
    rowHeight,
    render,
    overscan = 6,
    getKey,
    stickToBottom = false,
    className,
    style,
    role,
    ariaLabel,
    ariaActiveDescendant,
    tabIndex,
    onKeyDown,
  } = props;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const atBottomRef = useRef(stickToBottom);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el && stickToBottom && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, stickToBottom]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index) {
        const el = viewportRef.current;
        if (!el || index < 0 || index >= items.length) return;
        const top = index * rowHeight;
        const bottom = top + rowHeight;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      },
      scrollToBottom() {
        const el = viewportRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      },
      focus() {
        viewportRef.current?.focus();
      },
    }),
    [items.length, rowHeight],
  );

  function handleScroll(e: ReactUIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= Math.max(4, rowHeight / 2);
  }

  const win = computeWindow(items.length, rowHeight, scrollTop, viewportH, overscan);
  const rows: ReactNode[] = [];
  for (let i = win.start; i < win.end; i += 1) {
    const item = items[i];
    rows.push(
      <div
        key={getKey ? getKey(item, i) : i}
        role="presentation"
        style={{
          position: 'absolute',
          top: i * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
          // Row content must fit rowHeight; clip so an oversized row never overlaps the next.
          overflow: 'hidden',
        }}
      >
        {render(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      className={className}
      style={{ position: 'relative', overflowY: 'auto', ...style }}
      role={role}
      aria-label={ariaLabel}
      aria-activedescendant={ariaActiveDescendant}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onScroll={handleScroll}
    >
      <div style={{ height: win.totalHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & RefAttributes<VirtualListHandle>,
) => ReactElement;
