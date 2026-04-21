import { EventEmitter } from 'node:events';
import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import { BaseLayer } from './BaseLayer';
import type { IdleClip } from './clips/types';

/**
 * Error thrown when a pending walk is interrupted by a new walk or by stop().
 */
export class WalkInterruptedError extends Error {
  readonly name = 'WalkInterruptedError';
  readonly finalPos: WalkPosition;

  constructor(finalPos: WalkPosition) {
    super('Walk interrupted');
    Object.setPrototypeOf(this, new.target.prototype);
    this.finalPos = finalPos;
  }
}

export interface WalkProgress {
  currentPos: { x: number; z: number };
  currentFacing: number;
  target: { x: number; z: number; facing: number };
  remainingM: number;
}

export interface WalkPosition {
  x: number;
  z: number;
  facing: number;
}

export interface WalkingLayerConfig {
  /** Movement speed in metres per second. */
  speedMps: number;
  /** Distance in metres at which arrival snaps and the walk resolves. */
  arrivalThresholdM: number;
  /** Minimum interval in ms between `walking` callback emissions. */
  onWalkingThrottleMs: number;
}

export const DEFAULT_WALKING_CONFIG: WalkingLayerConfig = {
  speedMps: 1.0,
  arrivalThresholdM: 0.02,
  onWalkingThrottleMs: 200,
};

interface PendingWalk {
  target: { x: number; z: number; facing: number };
  resolve: () => void;
  reject: (err: WalkInterruptedError) => void;
}

/**
 * Stateful layer that owns `vrm.root.x`, `vrm.root.z`, and `vrm.root.rotY`
 * while a walk is pending.
 *
 * Emits root channels every tick while moving, and `{}` when idle so the
 * renderer preserves the last pose. Uses snap-facing (not interpolated).
 *
 * NOTE: If vector-velocity / composite locomotion appears later, currentPos /
 * target could be refactored into reactive streams such as BehaviorSubject.
 * Do NOT import RxJS now.
 */
export class WalkingLayer extends BaseLayer {
  readonly id = 'walking';
  // WalkingLayer drives VRM root motion (vrm.* quat tracks); not applicable to cubism.
  readonly modelSupport = ['vrm'] as const;

  private readonly config: WalkingLayerConfig;

  /** Current position in scene space (metres). */
  private currentX = 0;
  private currentZ = 0;
  /** Current facing in radians (Y rotation). */
  private currentFacing = 0;

  private pending: PendingWalk | null = null;
  private lastTickMs: number | null = null;
  /** Last `nowMs` at which the `walking` callback was emitted. */
  private lastOnWalkingEmitMs: number | null = null;

  /** Walk-cycle clip to sample while walking, or null for slide-only motion. */
  private walkCycleClip: IdleClip | null = null;
  /** Elapsed playback time (ms) within the current walk-cycle clip. */
  private cycleElapsedMs = 0;
  /** Authored walking speed (m/s) for the injected clip; used to scale playback rate. */
  private authoredSpeedMps = 1.0;

  private readonly emitter = new EventEmitter();

  constructor(config: Partial<WalkingLayerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_WALKING_CONFIG, ...config };
  }

  /**
   * Begin moving to `(x, z)` with an optional target `facing` (radians).
   * Any previously pending walk is immediately interrupted.
   * Resolves when the avatar arrives within `arrivalThresholdM` of the target.
   */
  walkTo(x: number, z: number, face?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.interruptPending();

      const targetFacing = face ?? this.currentFacing;

      this.pending = {
        target: { x, z, facing: targetFacing },
        resolve,
        reject,
      };

      this.lastTickMs = null;
      this.lastOnWalkingEmitMs = null;
      // Reset clip timeline so each walk starts from the beginning of the cycle.
      this.cycleElapsedMs = 0;
      this.emitter.emit('startWalk', this.pending.target);
    });
  }

  /** Interrupt the current pending walk without starting a new one. */
  stop(): void {
    this.interruptPending();
  }

  /** Return the current position snapshot. */
  getPosition(): WalkPosition {
    return {
      x: this.currentX,
      z: this.currentZ,
      facing: this.currentFacing,
    };
  }

  /** Register a callback fired once when a walk begins. */
  onStartWalk(fn: (target: { x: number; z: number; facing: number }) => void): void {
    this.emitter.on('startWalk', fn);
  }

  /** Register a callback fired every tick while moving (throttled). */
  onWalking(fn: (progress: WalkProgress) => void): void {
    this.emitter.on('walking', fn);
  }

  /** Register a callback fired exactly once when arrival occurs. */
  onArrive(fn: (pos: WalkPosition) => void): void {
    this.emitter.on('arrive', fn);
  }

  /**
   * Inject a walk-cycle clip for additive bone animation while walking.
   * Pass null to revert to slide-only (root motion without bone cycles).
   * Resets the clip playback timeline when called.
   * @param clip - The IdleClip to sample, or null to disable.
   * @param authoredSpeedMps - The walking speed (m/s) the clip was authored for.
   *   Playback rate scales as (actualSpeed / authoredSpeed) clamped to [0.2, 2.0].
   */
  setWalkCycleClip(clip: IdleClip | null, authoredSpeedMps = 1.0): void {
    this.walkCycleClip = clip;
    this.authoredSpeedMps = authoredSpeedMps;
    this.cycleElapsedMs = 0;
  }

  /** Reset all state to initial values and reject any pending walk. */
  reset(): void {
    this.interruptPending();
    this.currentX = 0;
    this.currentZ = 0;
    this.currentFacing = 0;
    this.lastTickMs = null;
    this.lastOnWalkingEmitMs = null;
    this.cycleElapsedMs = 0;
  }

  /**
   * Drive root channels while a walk is pending.
   * Returns `{}` when idle so the renderer keeps the last pose.
   * Ignores `activeChannels` (MVP — no filtering).
   */
  sample(nowMs: number, _activity: AvatarActivity, _activeChannels?: ReadonlySet<string>): Record<string, number> {
    void _activity;
    void _activeChannels;

    if (!this.pending) {
      this.lastTickMs = nowMs;
      return {};
    }

    const dtMs = this.lastTickMs === null ? 16.67 : Math.min(Math.max(nowMs - this.lastTickMs, 0), 100);

    this.lastTickMs = nowMs;

    const pending = this.pending;
    const dtSec = dtMs / 1000;
    const { target } = pending;

    const dx = target.x - this.currentX;
    const dz = target.z - this.currentZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= this.config.arrivalThresholdM) {
      this.currentX = target.x;
      this.currentZ = target.z;
      this.currentFacing = target.facing;

      this.pending = null;
      this.lastOnWalkingEmitMs = null;

      pending.resolve();
      this.emitter.emit('arrive', this.getPosition());

      return {
        'vrm.root.x': target.x,
        'vrm.root.z': target.z,
        'vrm.root.rotY': target.facing,
      };
    }

    const step = Math.min(this.config.speedMps * dtSec, dist);
    const nx = dx / dist;
    const nz = dz / dist;

    this.currentX += nx * step;
    this.currentZ += nz * step;
    this.currentFacing = target.facing;

    const remainingM = Math.max(
      0,
      Math.sqrt(
        (target.x - this.currentX) * (target.x - this.currentX) +
          (target.z - this.currentZ) * (target.z - this.currentZ),
      ),
    );

    if (this.lastOnWalkingEmitMs === null || nowMs - this.lastOnWalkingEmitMs >= this.config.onWalkingThrottleMs) {
      this.lastOnWalkingEmitMs = nowMs;
      this.emitter.emit('walking', {
        currentPos: { x: this.currentX, z: this.currentZ },
        currentFacing: this.currentFacing,
        target: { ...target },
        remainingM,
      } satisfies WalkProgress);
    }

    const out: Record<string, number> = {
      'vrm.root.x': this.currentX,
      'vrm.root.z': this.currentZ,
      'vrm.root.rotY': target.facing,
    };

    // Walk-cycle clip contribution: additively mix bone channels while walking.
    if (this.walkCycleClip !== null) {
      // Compute actual speed this tick; fall back to configured speed when dtSec is zero.
      const actualStepMps = dtSec > 0 ? step / dtSec : this.config.speedMps;
      // Guard against zero/negative authoredSpeedMps to avoid NaN from division.
      const safeAuthoredSpeed = this.authoredSpeedMps > 0 ? this.authoredSpeedMps : 1.0;
      // Scale clip playback rate by actual-vs-authored speed, clamped to avoid
      // extremely slow or fast cycling (e.g. during start/stop ramps).
      const rateFactor = Math.max(0.2, Math.min(2.0, actualStepMps / safeAuthoredSpeed));
      this.cycleElapsedMs += dtMs * rateFactor;
      // Wrap elapsed time within clip duration to loop continuously.
      const clipDurationMs = this.walkCycleClip.duration * 1000;
      if (clipDurationMs > 0) {
        this.cycleElapsedMs = this.cycleElapsedMs % clipDurationMs;
      }
      const frame = sampleClip(this.walkCycleClip, this.cycleElapsedMs / 1000);
      // Additively merge scalar bone channels; defensively skip any root channels
      // the clip may contain (sampleClip already filters them, but guard here too).
      for (const [ch, val] of Object.entries(frame.scalar)) {
        if (ch.startsWith('vrm.root.') || ch === 'vrm.root') {
          continue;
        }
        out[ch] = (out[ch] ?? 0) + val;
      }
      // Flatten quaternion bone channels into qx/qy/qz/qw scalar output channels.
      // Use additive style for consistency with contribution semantics.
      for (const [ch, q] of Object.entries(frame.quat)) {
        if (ch.startsWith('vrm.root.') || ch === 'vrm.root') {
          continue;
        }
        out[`${ch}.qx`] = (out[`${ch}.qx`] ?? 0) + q.x;
        out[`${ch}.qy`] = (out[`${ch}.qy`] ?? 0) + q.y;
        out[`${ch}.qz`] = (out[`${ch}.qz`] ?? 0) + q.z;
        out[`${ch}.qw`] = (out[`${ch}.qw`] ?? 0) + q.w;
      }
    }

    return out;
  }

  private interruptPending(): void {
    if (!this.pending) {
      return;
    }

    const err = new WalkInterruptedError(this.getPosition());
    this.pending.reject(err);
    this.pending = null;
    this.lastOnWalkingEmitMs = null;
  }
}
