import { AnimationCompiler } from '../AnimationCompiler';
import type { CompilerConfig } from '../types';

/**
 * Production `AnimationCompiler` registers the continuous layer stack by default.
 * Most compiler unit tests need an **empty** layer list (only ad-hoc test layers);
 * this factory is equivalent to `new AnimationCompiler(..., { registerContinuousStack: false })`.
 */
export function newAnimationCompilerTest(
  config: Partial<CompilerConfig> = {},
  actionMapPath?: string,
): AnimationCompiler {
  return new AnimationCompiler(config, actionMapPath, { registerContinuousStack: false });
}
