import { EventEmitter } from 'node:events';
import { TRANSITION_ANIMATIONS } from './transition-animations';
import { type AvatarActivity, type AvatarActivityPatch, DEFAULT_ACTIVITY, type StateNodeOutput } from './types';

/**
 * Tracks the bot's current `AvatarActivity` ({ ambientGain, pose }) and emits
 * transition-animation nodes when `pose` changes. Continuous ambient motion
 * (breath, blink, gaze, idle-motion) is produced by the `AnimationLayer` stack
 * in the compiler — this tracker no longer schedules any micro-actions.
 *
 * The class retains its file name (`IdleStateMachine.ts`) and the exported
 * class is aliased as `IdleStateMachine` for the minimal-churn reason, but
 * conceptually it is now just an activity store with a changed-pose hook.
 *
 * Events:
 *   - `'pose-change'`: (from: AvatarPose, to: AvatarPose)
 */
export class ActivityTracker extends EventEmitter {
  private activity: AvatarActivity = { ...DEFAULT_ACTIVITY };

  get current(): AvatarActivity {
    return { ...this.activity };
  }

  /** Backwards-compatibility convenience for the old `.currentState` getter. */
  get currentPose(): AvatarActivity['pose'] {
    return this.activity.pose;
  }

  /**
   * Apply a partial update to the current activity. Returns the list of
   * transition animation nodes the compiler should enqueue for any `pose`
   * edge (empty when pose didn't change or the new pose has no payload).
   */
  update(patch: AvatarActivityPatch): StateNodeOutput[] {
    const prev = this.activity;
    const next: AvatarActivity = {
      ambientGain: patch.ambientGain ?? prev.ambientGain,
      pose: patch.pose ?? prev.pose,
    };
    this.activity = next;

    if (prev.pose !== next.pose) {
      this.emit('pose-change', prev.pose, next.pose);
    }

    if (prev.pose === next.pose) return [];
    const now = Date.now();
    return TRANSITION_ANIMATIONS[next.pose].map((n) => ({ ...n, timestamp: now }));
  }

  /** No-op — retained for backward compatibility with AvatarService's lifecycle. */
  start(): void {}

  /** No-op — retained for backward compatibility with AvatarService's lifecycle. */
  stop(): void {}
}

/** Back-compat alias — prefer `ActivityTracker` in new code. */
export { ActivityTracker as IdleStateMachine };
