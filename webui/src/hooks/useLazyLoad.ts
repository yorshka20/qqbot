import { useEffect, useRef, useState } from 'react';

/**
 * Shared IntersectionObserver pool — one observer per unique (rootMargin, threshold) pair.
 * Instead of creating N observers for N cards, all cards share a single observer.
 */
const observerMap = new Map<string, IntersectionObserver>();
const callbackMap = new Map<Element, (isIntersecting: boolean) => void>();

function getSharedObserver(rootMargin: string, threshold: number): IntersectionObserver {
  const key = `${rootMargin}|${threshold}`;
  let observer = observerMap.get(key);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cb = callbackMap.get(entry.target);
          if (cb) cb(entry.isIntersecting);
        }
      },
      { rootMargin, threshold },
    );
    observerMap.set(key, observer);
  }
  return observer;
}

/**
 * Hook for lazy loading media elements using a shared IntersectionObserver.
 * Returns a ref to attach to the container and a boolean indicating if it's visible.
 *
 * @param rootMargin - Margin around the root viewport (default: '200px' to preload slightly before entering viewport)
 * @param threshold - Percentage of element visibility required to trigger (default: 0)
 */
export function useLazyLoad<T extends HTMLElement = HTMLDivElement>(
  rootMargin = '200px',
  threshold = 0,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || isVisible) return;

    const observer = getSharedObserver(rootMargin, threshold);

    callbackMap.set(element, (intersecting) => {
      if (intersecting) {
        setIsVisible(true);
        observer.unobserve(element);
        callbackMap.delete(element);
      }
    });

    observer.observe(element);

    return () => {
      observer.unobserve(element);
      callbackMap.delete(element);
    };
  }, [isVisible, rootMargin, threshold]);

  return [ref, isVisible];
}
