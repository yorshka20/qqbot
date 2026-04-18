import type { EasingType } from './types';

export const linear = (t: number): number => t;

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export const easeOutElastic = (t: number): number => {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

export const easeOutBounce = (t: number): number => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const t1 = t - 1.5 / d1;
    return n1 * t1 * t1 + 0.75;
  }
  if (t < 2.5 / d1) {
    const t2 = t - 2.25 / d1;
    return n1 * t2 * t2 + 0.9375;
  }
  const t3 = t - 2.625 / d1;
  return n1 * t3 * t3 + 0.984375;
};

export const EASING_FUNCTIONS: Record<EasingType, (t: number) => number> = {
  linear,
  easeInOutCubic,
  easeInOutQuad,
  easeOutElastic,
  easeOutBounce,
};

export function applyEasing(t: number, type: EasingType): number {
  const fn = EASING_FUNCTIONS[type] ?? linear;
  return fn(t);
}
