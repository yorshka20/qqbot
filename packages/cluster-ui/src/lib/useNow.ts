import { useEffect, useState } from 'react';

const TICK_MS = 15_000;

/** Durations on screen are minute-grained, so a slow tick keeps them honest without re-rendering much. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
