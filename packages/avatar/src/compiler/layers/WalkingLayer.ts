import { EventEmitter } from 'node:events';
import type { AvatarActivity } from '../../state/types';
import { BaseLayer } from './BaseLayer';

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

  /** Reset all state to initial values and reject any pending walk. */
  reset(): void {
    this.interruptPending();
    this.currentX = 0;
    this.currentZ = 0;
    this.currentFacing = 0;
    this.lastTickMs = null;
    this.lastOnWalkingEmitMs = null;
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

    return {
      'vrm.root.x': this.currentX,
      'vrm.root.z': this.currentZ,
      'vrm.root.rotY': target.facing,
    };
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
