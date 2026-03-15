import { useEffect, useRef, useState } from 'react';

/**
 * Hook for lazy loading media elements using IntersectionObserver.
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
    if (!element) return;

    // If already visible, no need to observe
    if (isVisible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            // Once visible, stop observing
            observer.disconnect();
            break;
          }
        }
      },
      {
        rootMargin,
        threshold,
      },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [isVisible, rootMargin, threshold]);

  return [ref, isVisible];
}
