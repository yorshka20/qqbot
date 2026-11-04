import { useEffect, useRef, useState } from 'react';

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** A single-key shortcut, ignored while typing or with a modifier held. */
export function useKey(key: string, handler: (event: KeyboardEvent) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
        latest.current(event);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [key]);
}

/** `j` / `k` move a cursor down a list of links, `Enter` opens the row under it. */
export function useListCursor(hrefs: string[], open: (href: string) => void): { cursor: number | null } {
  const [cursor, setCursor] = useState<number | null>(null);
  const last = hrefs.length - 1;
  const clamped = cursor === null || last < 0 ? null : Math.min(cursor, last);

  const move = (delta: number) => {
    if (last < 0) {
      return;
    }
    const next = clamped === null ? 0 : Math.max(0, Math.min(last, clamped + delta));
    setCursor(next);
    document.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  useKey('j', () => move(1));
  useKey('k', () => move(-1));
  useKey('Enter', (event) => {
    if (
      clamped !== null &&
      !(event.target instanceof HTMLButtonElement) &&
      !(event.target instanceof HTMLAnchorElement)
    ) {
      open(hrefs[clamped]);
    }
  });

  return { cursor: clamped };
}

/** A dialog, popover, menu or select is open and owns Esc until it closes; a tooltip does not. */
export function overlayIsOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    ) !== null
  );
}
