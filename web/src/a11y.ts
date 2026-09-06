import { useEffect, useRef, useState } from 'react';

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

const HORIZONTAL_KEYS = new Set(['ArrowLeft', 'ArrowRight']);
const VERTICAL_KEYS = new Set(['ArrowUp', 'ArrowDown']);

function handledKeys(orientation: RovingOrientation): Set<string> {
  if (orientation === 'horizontal') return HORIZONTAL_KEYS;
  if (orientation === 'vertical') return VERTICAL_KEYS;
  return new Set([...HORIZONTAL_KEYS, ...VERTICAL_KEYS]);
}

interface RovingItemProps<T extends HTMLElement> {
  ref: (el: T | null) => void;
  tabIndex: 0 | -1;
  onFocus: () => void;
}

interface RovingTabindex<T extends HTMLElement> {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  containerProps: { onKeyDown: (e: React.KeyboardEvent) => void };
  getItemProps: (index: number) => RovingItemProps<T>;
}

/**
 * Roving tabindex for composite widgets (menus, toolbars, file lists):
 * exactly one item is in the tab order, arrow keys move focus between items.
 * Attach containerProps to the wrapper and getItemProps(i) to each item.
 */
export function useRovingTabindex<T extends HTMLElement = HTMLElement>(
  itemCount: number,
  orientation: RovingOrientation = 'vertical',
  options?: { wrap?: boolean },
): RovingTabindex<T> {
  const wrap = options?.wrap ?? false;
  const [activeIndex, setActiveIndex] = useState(0);
  const itemsRef = useRef<(T | null)[]>([]);

  useEffect(() => {
    itemsRef.current.length = itemCount;
    setActiveIndex((i) => (itemCount === 0 ? 0 : Math.min(i, itemCount - 1)));
  }, [itemCount]);

  function move(delta: number) {
    if (itemCount === 0) return;
    let next = activeIndex + delta;
    if (wrap) {
      next = (next + itemCount) % itemCount;
    } else {
      next = Math.max(0, Math.min(itemCount - 1, next));
    }
    setActiveIndex(next);
    itemsRef.current[next]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const keys = handledKeys(orientation);
    if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
      itemsRef.current[0]?.focus();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      const last = itemCount - 1;
      setActiveIndex(last);
      itemsRef.current[last]?.focus();
      return;
    }
    if (!keys.has(e.key)) return;
    e.preventDefault();
    const backwards = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    move(backwards ? -1 : 1);
  }

  function getItemProps(index: number): RovingItemProps<T> {
    return {
      ref: (el) => {
        itemsRef.current[index] = el;
      },
      tabIndex: index === activeIndex ? 0 : -1,
      // keep the roving index in sync when focus arrives via mouse or tab
      onFocus: () => setActiveIndex(index),
    };
  }

  return { activeIndex, setActiveIndex, containerProps: { onKeyDown }, getItemProps };
}

const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), iframe, ' +
  '[tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[aria-hidden="true"]'),
  );
}

/**
 * While active, Tab / Shift+Tab cycle focus inside the container instead of
 * leaving it. On activation focus moves into the container if it was outside.
 * Pair with useFocusReturn so closing restores the trigger's focus.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    if (!container.contains(document.activeElement)) {
      const first = focusablesIn(container)[0];
      if (first) {
        first.focus();
      } else if (container.tabIndex >= 0) {
        container.focus();
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = focusablesIn(container!);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !container!.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !container!.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [ref, active]);
}

/**
 * Remembers the focused element when `active` turns true and restores focus
 * to it when it turns false (or on unmount while active). Use for dialogs,
 * popovers and drawers triggered from a button.
 */
export function useFocusReturn(active: boolean): void {
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreRef.current = document.activeElement;
    return () => {
      const el = restoreRef.current;
      restoreRef.current = null;
      // the trigger may have been removed while the overlay was open
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, [active]);
}

/**
 * Calls `handler` on Escape while `active`. The handler is held in a ref, so
 * passing an inline closure does not resubscribe the listener.
 */
export function useEscape(handler: (event: KeyboardEvent) => void, active: boolean = true): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handlerRef.current(e);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
