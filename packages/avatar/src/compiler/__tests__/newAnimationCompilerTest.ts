import { AnimationCompiler, type AnimationCompilerOptions } from '../AnimationCompiler';
import type { RestPose } from '../restPose';
import type { CompilerConfig } from '../types';

/**
 * Production `AnimationCompiler` registers the continuous layer stack by default.
 * Most compiler unit tests need an **empty** layer list (only ad-hoc test layers);
 * this factory is equivalent to `new AnimationCompiler(..., { registerContinuousStack: false })`.
 *
 * Pass `restPose` to inject a synthetic rest pose for hermetic tests instead of
 * loading from `packages/avatar/assets/vrm-rest-pose.json`.
 */
export function newAnimationCompilerTest(
  config: Partial<CompilerConfig> = {},
  actionMapPath?: string,
  options: Omit<AnimationCompilerOptions, 'registerContinuousStack'> = {},
): AnimationCompiler {
  return new AnimationCompiler(config, actionMapPath, { registerContinuousStack: false, ...options });
}

export type { RestPose };
