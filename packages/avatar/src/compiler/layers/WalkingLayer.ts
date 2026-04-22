import { EventEmitter } from 'node:events';
import type { TunableParam } from '../../preview/types';
import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import { BaseLayer } from './BaseLayer';
import type { IdleClip } from './clips/types';

/**
 * Error thrown when a pending motion is interrupted by a new motion or by stop().
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
  /** Target pose for linear motion. For orbit motion, a synthesised target (end of sweep). */
  target: { x: number; z: number; facing: number };
  /** Remaining linear distance to the target pose (metres). */
  remainingM: number;
}

export interface WalkPosition {
  x: number;
  z: number;
  facing: number;
}

export interface WalkingLayerConfig {
  /** Linear translation speed in metres per second. */
  speedMps: number;
  /** Angular turning speed in radians per second. Applies to facing interpolation in linear
   *  motions and to target-facing interp in orbit motions when tangent-facing is disabled. */
  angularSpeedRadPerSec: number;
  /** Distance in metres at which translation is considered arrived. */
  arrivalThresholdM: number;
  /** Angular tolerance in radians at which facing is considered arrived. */
  arrivalThresholdRad: number;
  /** Minimum interval in ms between `walking` callback emissions. */
  onWalkingThrottleMs: number;
}

export const DEFAULT_WALKING_CONFIG: WalkingLayerConfig = {
  speedMps: 1.0,
  angularSpeedRadPerSec: Math.PI, // 180°/s — half rotation per second
  arrivalThresholdM: 0.02,
  arrivalThresholdRad: 0.01, // ~0.57°
  onWalkingThrottleMs: 200,
};

export interface OrbitOptions {
  /** Signed radians to sweep. Positive = CCW (from above, math convention). */
  sweepRad: number;
  /** Orbit radius in metres. Defaults to 1.5m if not specified. */
  radius?: number;
  /** Explicit orbit centre in world metres. Omit to derive from the character's current pose
   *  (see `deriveOrbitCenter` — places center to the character's left by `radius`). */
  center?: { x: number; z: number };
  /** When true (default), facing auto-aligns with the tangent along the arc so the character
   *  looks where they're going. When false, facing interpolates to `targetFacing` (or stays
   *  unchanged if targetFacing is absent) at the layer's angular speed. */
  keepFacingTangent?: boolean;
  /** Optional final facing when `keepFacingTangent` is false. If absent, facing is preserved. */
  targetFacing?: number;
}

interface BaseMotion {
  resolve: () => void;
  reject: (err: WalkInterruptedError) => void;
}

interface LinearMotion extends BaseMotion {
  kind: 'linear';
  target: { x: number; z: number; facing: number };
}

interface OrbitMotion extends BaseMotion {
  kind: 'orbit';
  center: { x: number; z: number };
  radius: number;
  /** Polar angle (rad) on the orbit circle at motion start. Measured by `atan2(dz, dx)`. */
  startAngle: number;
  /** Signed total radians to sweep (positive = CCW). Direction derived from sign. */
  totalSweepRad: number;
  /** Unsigned radians swept so far. Motion done when `sweptRad >= |totalSweepRad|`. */
  sweptRad: number;
  keepFacingTangent: boolean;
  /** Used only when `!keepFacingTangent`: final facing to interp to across the sweep. */
  targetFacing?: number;
  /** Facing at motion start, for non-tangent interp. */
  startFacing: number;
}

type Motion = LinearMotion | OrbitMotion;

/**
 * Stateful layer that owns `vrm.root.x / vrm.root.z / vrm.root.rotY` whenever a motion is
 * pending. Supports two motion kinds:
 *
 * 1. **Linear** — walk from current pose to a target `(x, z, facing)`. Translation and
 *    rotation interpolate simultaneously at their own speed limits; the motion is done when
 *    BOTH converge (within threshold). This means "walk while turning" is first-class:
 *    a single `walkTo(x, z, face)` with a facing different from current yields a path that
 *    ends at `(x, z)` AND rotates toward `face` across the duration.
 *
 * 2. **Orbit** — arc around a centre point. Avatar position is parameterised on the orbit
 *    angle; character speed along the arc equals `config.speedMps` (i.e. angular velocity
 *    = `speedMps / radius`). Facing auto-aligns with the tangent direction when
 *    `keepFacingTangent` is true (default).
 *
 * Design motivation: centralise the "trajectory generator" in the bot. The wire protocol
 * still sends absolute `vrm.root.*` every frame; the renderer is unchanged. Game-style
 * locomotion (walk + turn simultaneously, curves, orbits) lives entirely here — LLM and HUD
 * both express intent ("walk forward 2m", "orbit 360°") without touching coordinates.
 *
 * Public API:
 *   - `walkForward(m)` / `strafe(m)` / `turn(rad)` / `orbit(opts)` — semantic primitives
 *   - `walkTo(x, z, face?)` — low-level absolute-target walk (used internally and for LLM)
 *   - `stop()` — interrupt the pending motion
 *   - `getPosition()` — snapshot of current pose (authoritative bot-side state)
 *
 * Facing convention: radians, Three.js Y rotation (positive = CW from above, which matches
 * "turn right" from the character's own POV). `forward_world = (sin f, cos f)`.
 */
export class WalkingLayer extends BaseLayer {
  readonly id = 'walking';
  // WalkingLayer drives VRM root motion; not applicable to cubism.
  readonly modelSupport = ['vrm'] as const;
  // Root positions and walk-cycle bone Euler values are absolute-pose scalars — they must
  // not be multiplied by ambientGain/weight (would teleport the avatar toward origin while
  // speaking), nor go through spring-damper (would lag behind actual walk speed).
  // LayerManager routes the scalar output into LayerFrame.scalarBypass, and the compiler
  // marks those channels for bypass.
  readonly scalarIsAbsolute = true;

  private readonly config: WalkingLayerConfig;

  /** Per-tick frame cache. `sample()` advances state once per tick and caches the quat
   *  contribution; `sampleQuat()` reads the cache. Prevents double-advance when LayerManager
   *  calls both in the same tick. */
  private cachedQuat: {
    nowMs: number;
    quat: Record<string, { x: number; y: number; z: number; w: number }>;
  } | null = null;

  /** Current position in scene space (metres). */
  private currentX = 0;
  private currentZ = 0;
  /** Current facing in radians (Three.js Y rotation). */
  private currentFacing = 0;

  private motion: Motion | null = null;
  private lastTickMs: number | null = null;
  /** Last `nowMs` at which the `walking` callback was emitted. */
  private lastOnWalkingEmitMs: number | null = null;

  /** Walk-cycle clip to sample while a motion is active, or null for slide-only motion. */
  private walkCycleClip: IdleClip | null = null;
  /** Elapsed playback time (ms) within the current walk-cycle clip. */
  private cycleElapsedMs = 0;
  /** Authored walking speed (m/s) for the injected clip; used to scale playback rate. */
  private authoredSpeedMps = 1.0;

  private readonly emitter = new EventEmitter();

  constructor(config: Partial<WalkingLayerConfig> = {}) {
    super();
    // Per-field merge with nullish coalescing: `{ ...DEFAULT, ...config }` would let an
    // explicit `undefined` in `config` clobber a defined default (e.g. destructured optional
    // user config). `undefined * dtSec` is NaN and propagates into vrm.root.* emissions,
    // which serialise as JSON null and leave the avatar visibly stuck.
    this.config = {
      speedMps: config.speedMps ?? DEFAULT_WALKING_CONFIG.speedMps,
      angularSpeedRadPerSec: config.angularSpeedRadPerSec ?? DEFAULT_WALKING_CONFIG.angularSpeedRadPerSec,
      arrivalThresholdM: config.arrivalThresholdM ?? DEFAULT_WALKING_CONFIG.arrivalThresholdM,
      arrivalThresholdRad: config.arrivalThresholdRad ?? DEFAULT_WALKING_CONFIG.arrivalThresholdRad,
      onWalkingThrottleMs: config.onWalkingThrottleMs ?? DEFAULT_WALKING_CONFIG.onWalkingThrottleMs,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Public API — low level
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Walk to absolute scene coordinates `(x, z)` with an optional target facing (radians).
   * Translation and rotation interpolate in parallel; the promise resolves when both reach
   * their respective thresholds. Any pending motion is interrupted (prior promise rejects
   * with WalkInterruptedError).
   */
  walkTo(x: number, z: number, face?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.interruptMotion();
      const targetFacing = face ?? this.currentFacing;
      this.motion = {
        kind: 'linear',
        target: { x, z, facing: targetFacing },
        resolve,
        reject,
      };
      this.onMotionStart({ x, z, facing: targetFacing });
    });
  }

  /** Interrupt the current pending motion without starting a new one. */
  stop(): void {
    this.interruptMotion();
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Public API — semantic primitives
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Walk `meters` along the character's current facing. Positive = forward, negative = back.
   * Facing is preserved throughout. Equivalent to `walkTo(current + forward * meters)`.
   */
  walkForward(meters: number): Promise<void> {
    const fx = Math.sin(this.currentFacing);
    const fz = Math.cos(this.currentFacing);
    return this.walkTo(this.currentX + fx * meters, this.currentZ + fz * meters);
  }

  /**
   * Strafe `meters` perpendicular to facing. Positive = character's right, negative = left.
   * Facing is preserved. The character's right/left is always resolved from their own frame,
   * so "left" stays consistent regardless of how the camera or viewer is positioned.
   */
  strafe(meters: number): Promise<void> {
    const rx = Math.cos(this.currentFacing);
    const rz = -Math.sin(this.currentFacing);
    return this.walkTo(this.currentX + rx * meters, this.currentZ + rz * meters);
  }

  /**
   * Turn in place by `radians`. Convention matches Three.js Y rotation: positive = CW from
   * above = character's own right. Use `-rad` for left turns. Translation is held (the
   * target x/z equal current), and facing interpolates at `angularSpeedRadPerSec`.
   */
  turn(radians: number): Promise<void> {
    return this.walkTo(this.currentX, this.currentZ, this.currentFacing + radians);
  }

  /**
   * Orbit around a centre point by `sweepRad` radians. Default centre is `radius` metres to
   * the character's left. Character speed along the arc equals `config.speedMps`. Facing
   * auto-aligns with the tangent direction when `keepFacingTangent` is true.
   */
  orbit(opts: OrbitOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.interruptMotion();
      const radius = opts.radius ?? 1.5;
      const center = opts.center ?? this.deriveOrbitCenter(radius);
      // The character might not be exactly `radius` from the derived centre (numerical
      // rounding or explicit center). Use the actual current radius so the initial frame
      // doesn't teleport. If current distance is ~0, fall back to `radius` (character is on
      // top of centre — pick an arbitrary direction).
      const dx = this.currentX - center.x;
      const dz = this.currentZ - center.z;
      const actualRadius = Math.sqrt(dx * dx + dz * dz);
      const effectiveRadius = actualRadius > 1e-3 ? actualRadius : radius;
      const startAngle = actualRadius > 1e-3 ? Math.atan2(dz, dx) : 0;
      const keepFacingTangent = opts.keepFacingTangent ?? true;
      this.motion = {
        kind: 'orbit',
        center: { x: center.x, z: center.z },
        radius: effectiveRadius,
        startAngle,
        totalSweepRad: opts.sweepRad,
        sweptRad: 0,
        keepFacingTangent,
        targetFacing: opts.targetFacing,
        startFacing: this.currentFacing,
        resolve,
        reject,
      };
      // startWalk event carries a synthesised "target" at the end of the sweep for debug.
      const endAngle = startAngle + opts.sweepRad;
      const endX = center.x + effectiveRadius * Math.cos(endAngle);
      const endZ = center.z + effectiveRadius * Math.sin(endAngle);
      const endFacing = keepFacingTangent
        ? this.tangentFacingAt(endAngle, Math.sign(opts.sweepRad) || 1)
        : (opts.targetFacing ?? this.currentFacing);
      this.onMotionStart({ x: endX, z: endZ, facing: endFacing });
    });
  }

  /** Return the current position snapshot — bot-side authoritative state. */
  getPosition(): WalkPosition {
    return { x: this.currentX, z: this.currentZ, facing: this.currentFacing };
  }

  /** Register a callback fired once when a motion begins. */
  onStartWalk(fn: (target: { x: number; z: number; facing: number }) => void): void {
    this.emitter.on('startWalk', fn);
  }

  /** Register a callback fired every tick while a motion is active (throttled). */
  onWalking(fn: (progress: WalkProgress) => void): void {
    this.emitter.on('walking', fn);
  }

  /** Register a callback fired exactly once on arrival. */
  onArrive(fn: (pos: WalkPosition) => void): void {
    this.emitter.on('arrive', fn);
  }

  /**
   * Inject a walk-cycle clip to additively drive bone channels while a motion is active.
   * Playback rate scales with actual linear speed (clamped [0.2, 2.0]). Pass null to revert
   * to slide-only. Only linear-speed motions drive the clip timeline; pure rotation (zero
   * displacement) holds the clip at rate 0.
   */
  setWalkCycleClip(clip: IdleClip | null, authoredSpeedMps = 1.0): void {
    this.walkCycleClip = clip;
    this.authoredSpeedMps = authoredSpeedMps;
    this.cycleElapsedMs = 0;
    this.cachedQuat = null;
  }

  reset(): void {
    this.interruptMotion();
    this.currentX = 0;
    this.currentZ = 0;
    this.currentFacing = 0;
    this.lastTickMs = null;
    this.lastOnWalkingEmitMs = null;
    this.cycleElapsedMs = 0;
    this.cachedQuat = null;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Layer hook — frame sample
  // ──────────────────────────────────────────────────────────────────────────────

  sample(nowMs: number, _activity: AvatarActivity, _activeChannels?: ReadonlySet<string>): Record<string, number> {
    void _activity;
    void _activeChannels;

    if (!this.motion) {
      this.lastTickMs = nowMs;
      this.cachedQuat = { nowMs, quat: {} };
      return {};
    }

    const dtMs = this.lastTickMs === null ? 16.67 : Math.min(Math.max(nowMs - this.lastTickMs, 0), 100);
    this.lastTickMs = nowMs;
    const dtSec = dtMs / 1000;

    const motion = this.motion;
    const advance = motion.kind === 'linear' ? this.advanceLinear(motion, dtSec) : this.advanceOrbit(motion, dtSec);

    // Emit throttled progress event while the motion is still active.
    if (!advance.done) {
      this.emitProgressEvent(nowMs, motion);
    }

    const out: Record<string, number> = {
      'vrm.root.x': this.currentX,
      'vrm.root.z': this.currentZ,
      'vrm.root.rotY': this.currentFacing,
    };

    // Walk-cycle clip contribution: scalar bone Euler channels merge into `out` (absolute
    // scalar bypass path); quat bones are cached for sampleQuat(). Clip advances based on
    // actual linear step this tick, so pure turn / orbit (at speedMps) all drive legs.
    const cycleQuat: Record<string, { x: number; y: number; z: number; w: number }> = {};
    if (this.walkCycleClip !== null) {
      const actualStepMps = dtSec > 0 ? advance.linearStepM / dtSec : 0;
      const safeAuthoredSpeed = this.authoredSpeedMps > 0 ? this.authoredSpeedMps : 1.0;
      const rateFactor = Math.max(0.2, Math.min(2.0, actualStepMps / safeAuthoredSpeed));
      this.cycleElapsedMs += dtMs * rateFactor;
      const clipDurationMs = this.walkCycleClip.duration * 1000;
      if (clipDurationMs > 0) this.cycleElapsedMs = this.cycleElapsedMs % clipDurationMs;
      const frame = sampleClip(this.walkCycleClip, this.cycleElapsedMs / 1000);
      for (const [ch, val] of Object.entries(frame.scalar)) {
        if (ch.startsWith('vrm.root.') || ch === 'vrm.root') continue;
        out[ch] = val;
      }
      for (const [ch, q] of Object.entries(frame.quat)) {
        if (ch.startsWith('vrm.root.') || ch === 'vrm.root') continue;
        cycleQuat[ch] = q;
      }
    }
    this.cachedQuat = { nowMs, quat: cycleQuat };

    // Resolve and clear motion after the frame is built so sampleQuat() sees consistent
    // state. The resolve callback fires before the next tick's WS broadcast.
    if (advance.done) {
      this.motion = null;
      this.lastOnWalkingEmitMs = null;
      motion.resolve();
      this.emitter.emit('arrive', this.getPosition());
    }

    return out;
  }

  sampleQuat(
    nowMs: number,
    _activity: AvatarActivity,
    _activeChannels?: ReadonlySet<string>,
  ): Record<string, { x: number; y: number; z: number; w: number }> {
    void _activity;
    void _activeChannels;
    if (!this.cachedQuat || this.cachedQuat.nowMs !== nowMs) return {};
    return this.cachedQuat.quat;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Tunables
  // ──────────────────────────────────────────────────────────────────────────────

  getTunableParams(): TunableParam[] {
    return [
      {
        id: 'speedMps',
        label: 'Walk Speed (m/s)',
        min: 0.1,
        max: 5.0,
        step: 0.05,
        value: this.config.speedMps,
        default: DEFAULT_WALKING_CONFIG.speedMps,
      },
      {
        id: 'angularSpeedDegPerSec',
        label: 'Turn Speed (°/s)',
        min: 15,
        max: 720,
        step: 5,
        value: (this.config.angularSpeedRadPerSec * 180) / Math.PI,
        default: (DEFAULT_WALKING_CONFIG.angularSpeedRadPerSec * 180) / Math.PI,
      },
      {
        id: 'arrivalThresholdM',
        label: 'Arrival Threshold (m)',
        min: 0.005,
        max: 0.2,
        step: 0.005,
        value: this.config.arrivalThresholdM,
        default: DEFAULT_WALKING_CONFIG.arrivalThresholdM,
      },
    ];
  }

  setTunableParam(paramId: string, value: number): void {
    switch (paramId) {
      case 'speedMps':
        // Clamp away from zero so a misfired slider can't stall the walker.
        this.config.speedMps = Math.max(0.01, value);
        break;
      case 'angularSpeedDegPerSec':
        this.config.angularSpeedRadPerSec = Math.max(0.01, (value * Math.PI) / 180);
        break;
      case 'arrivalThresholdM':
        this.config.arrivalThresholdM = Math.max(0.001, value);
        break;
      // Unknown paramIds silently dropped per TunableParam contract.
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Motion advancement
  // ──────────────────────────────────────────────────────────────────────────────

  /** Advance a linear motion by one tick. Returns whether the motion is done and how far
   *  the character translated this tick (used for walk-cycle rate scaling). */
  private advanceLinear(motion: LinearMotion, dtSec: number): { done: boolean; linearStepM: number } {
    const target = motion.target;
    const dx = target.x - this.currentX;
    const dz = target.z - this.currentZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    let linearStepM = 0;
    if (dist > this.config.arrivalThresholdM) {
      const step = Math.min(this.config.speedMps * dtSec, dist);
      const nx = dx / dist;
      const nz = dz / dist;
      this.currentX += nx * step;
      this.currentZ += nz * step;
      linearStepM = step;
    } else {
      this.currentX = target.x;
      this.currentZ = target.z;
    }

    const facingDelta = shortestArc(this.currentFacing, target.facing);
    if (Math.abs(facingDelta) > this.config.arrivalThresholdRad) {
      const maxStep = this.config.angularSpeedRadPerSec * dtSec;
      const step = Math.sign(facingDelta) * Math.min(maxStep, Math.abs(facingDelta));
      this.currentFacing = normalizeAngle(this.currentFacing + step);
    } else {
      this.currentFacing = target.facing;
    }

    const xzDone = Math.abs(target.x - this.currentX) < 1e-9 && Math.abs(target.z - this.currentZ) < 1e-9;
    const facingDone = Math.abs(shortestArc(this.currentFacing, target.facing)) <= this.config.arrivalThresholdRad;
    return { done: xzDone && facingDone, linearStepM };
  }

  /** Advance an orbit motion by one tick. Parameterised on polar angle around `center`. */
  private advanceOrbit(motion: OrbitMotion, dtSec: number): { done: boolean; linearStepM: number } {
    // Angular speed so that character's linear speed along the arc equals `speedMps`.
    const orbitAngularSpeed = this.config.speedMps / Math.max(1e-3, motion.radius);
    const remaining = Math.abs(motion.totalSweepRad) - motion.sweptRad;
    const step = Math.min(orbitAngularSpeed * dtSec, Math.max(0, remaining));
    motion.sweptRad += step;

    const direction = Math.sign(motion.totalSweepRad) || 1;
    const currentAngle = motion.startAngle + direction * motion.sweptRad;
    this.currentX = motion.center.x + motion.radius * Math.cos(currentAngle);
    this.currentZ = motion.center.z + motion.radius * Math.sin(currentAngle);

    const linearStepM = step * motion.radius;

    if (motion.keepFacingTangent) {
      this.currentFacing = this.tangentFacingAt(currentAngle, direction);
    } else if (motion.targetFacing !== undefined) {
      // Interpolate facing linearly across the sweep so it lands on targetFacing at arrival.
      const progress = Math.min(1, motion.sweptRad / Math.max(1e-9, Math.abs(motion.totalSweepRad)));
      const totalDelta = shortestArc(motion.startFacing, motion.targetFacing);
      this.currentFacing = normalizeAngle(motion.startFacing + totalDelta * progress);
    }
    // else: facing held at motion.startFacing (no-op, current already matches)

    return { done: motion.sweptRad >= Math.abs(motion.totalSweepRad) - 1e-9, linearStepM };
  }

  /**
   * Derive orbit centre from current pose: `radius` metres to the character's left. Chosen
   * so that CCW orbit sweeps arc to the character's left (matching positive `sweepRad`).
   * LLM can override by passing an explicit `center`.
   */
  private deriveOrbitCenter(radius: number): { x: number; z: number } {
    const leftX = -Math.cos(this.currentFacing);
    const leftZ = Math.sin(this.currentFacing);
    return { x: this.currentX + leftX * radius, z: this.currentZ + leftZ * radius };
  }

  /** Facing angle whose forward vector equals the tangent at polar angle `θ` around the orbit.
   *  CCW tangent = `(-sinθ, cosθ)`; CW tangent = `(sinθ, -cosθ)`. Converted to the layer's
   *  facing convention via `atan2(forward.x, forward.z)`. */
  private tangentFacingAt(angle: number, direction: number): number {
    const tx = -direction * Math.sin(angle);
    const tz = direction * Math.cos(angle);
    return Math.atan2(tx, tz);
  }

  private onMotionStart(target: { x: number; z: number; facing: number }): void {
    this.lastTickMs = null;
    this.lastOnWalkingEmitMs = null;
    this.cycleElapsedMs = 0;
    this.emitter.emit('startWalk', target);
  }

  private emitProgressEvent(nowMs: number, motion: Motion): void {
    if (this.lastOnWalkingEmitMs !== null && nowMs - this.lastOnWalkingEmitMs < this.config.onWalkingThrottleMs) {
      return;
    }
    this.lastOnWalkingEmitMs = nowMs;
    let target: { x: number; z: number; facing: number };
    let remainingM: number;
    if (motion.kind === 'linear') {
      target = motion.target;
      remainingM = Math.sqrt((motion.target.x - this.currentX) ** 2 + (motion.target.z - this.currentZ) ** 2);
    } else {
      const endAngle = motion.startAngle + motion.totalSweepRad;
      target = {
        x: motion.center.x + motion.radius * Math.cos(endAngle),
        z: motion.center.z + motion.radius * Math.sin(endAngle),
        facing: motion.keepFacingTangent
          ? this.tangentFacingAt(endAngle, Math.sign(motion.totalSweepRad) || 1)
          : (motion.targetFacing ?? motion.startFacing),
      };
      const remainingSweep = Math.abs(motion.totalSweepRad) - motion.sweptRad;
      remainingM = Math.max(0, remainingSweep) * motion.radius;
    }
    this.emitter.emit('walking', {
      currentPos: { x: this.currentX, z: this.currentZ },
      currentFacing: this.currentFacing,
      target,
      remainingM,
    } satisfies WalkProgress);
  }

  private interruptMotion(): void {
    if (!this.motion) return;
    const err = new WalkInterruptedError(this.getPosition());
    this.motion.reject(err);
    this.motion = null;
    this.lastOnWalkingEmitMs = null;
  }
}

/** Return the shortest signed arc from `from` to `to`, in `[-π, π]`. */
function shortestArc(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Normalise an angle to `[-π, π]`. */
function normalizeAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
