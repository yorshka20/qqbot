import { EventEmitter } from 'node:events';
import type { TunableParam } from '../../preview/types';
import type { AvatarActivity } from '../../state/types';
import { sampleClip } from '../clips/sampleClip';
import { applyEasing } from '../easing';
import type { EasingType } from '../types';
import { BaseLayer } from './BaseLayer';
import type { IdleClip } from './clips/types';

const WALKING_LAYER_EMPTY_CHANNELS: ReadonlySet<string> = new Set();

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
  /** Linear translation speed in metres per second.
   *
   *  Interpreted as the **average** speed across the entire motion — total duration of a
   *  motion equals `distanceM / speedMps`. Instantaneous speed varies along the easing
   *  curve (e.g. `easeInOutCubic` peaks at ~1.5× speedMps in the middle and goes to 0 at
   *  the boundaries). If you want a hard cap on peak speed, lower `speedMps`. */
  speedMps: number;
  /** Angular turning speed in radians per second. Same "average" interpretation as speedMps:
   *  total duration of a pure turn equals `|facingDelta| / angularSpeedRadPerSec`.
   *
   *  For combined walk+turn, total motion duration is `max(distTime, facingTime)` so
   *  translation and facing arrive simultaneously under the shared eased progress curve. */
  angularSpeedRadPerSec: number;
  /** Distance in metres at which translation is considered arrived.
   *  Kept for backward compat / informational use (`onWalking.remainingM`); the eased motion
   *  snaps exactly to the target at progress=1 so this threshold is not load-bearing. */
  arrivalThresholdM: number;
  /** Angular tolerance in radians at which facing is considered arrived. See arrivalThresholdM. */
  arrivalThresholdRad: number;
  /** Minimum interval in ms between `walking` callback emissions. */
  onWalkingThrottleMs: number;
  /** Easing curve applied to the motion's progress. Both translation and facing share the
   *  same eased progress so a combined walk+turn feels coherent. `linear` recovers the old
   *  constant-speed (rectangular) profile — avoid in production: starts/stops are abrupt
   *  and visually stiff. Default `easeInOutCubic` is the standard S-curve (ease-in /
   *  sustain / ease-out) and provides natural wind-up + follow-through on every motion. */
  easing: EasingType;
}

export const DEFAULT_WALKING_CONFIG: WalkingLayerConfig = {
  speedMps: 1.0,
  angularSpeedRadPerSec: Math.PI, // 180°/s — half rotation per second
  arrivalThresholdM: 0.02,
  arrivalThresholdRad: 0.01, // ~0.57°
  onWalkingThrottleMs: 200,
  easing: 'easeInOutCubic',
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
  /** Pose at motion start — anchor for the eased progress interpolation. */
  startX: number;
  startZ: number;
  startFacing: number;
  /** Signed shortest arc from startFacing to target.facing. */
  facingDeltaRad: number;
  /** Total duration in seconds — `max(dist/speedMps, |facingDelta|/angularSpeedRadPerSec)`. */
  durationSec: number;
  /** Wall-clock seconds since motion start; monotonically increases per tick. */
  elapsedSec: number;
}

interface OrbitMotion extends BaseMotion {
  kind: 'orbit';
  center: { x: number; z: number };
  radius: number;
  /** Polar angle (rad) on the orbit circle at motion start. Measured by `atan2(dz, dx)`. */
  startAngle: number;
  /** Signed total radians to sweep (positive = CCW). Direction derived from sign. */
  totalSweepRad: number;
  /** Unsigned radians swept so far — derived from `|totalSweepRad| * easedProgress` each
   *  tick. Kept on the motion so `onWalking` progress events can report remaining arc. */
  sweptRad: number;
  keepFacingTangent: boolean;
  /** Used only when `!keepFacingTangent`: final facing to interp to across the sweep. */
  targetFacing?: number;
  /** Facing at motion start, for non-tangent interp. */
  startFacing: number;
  /** Total duration in seconds — `(|sweepRad| * radius) / speedMps`, plus a non-tangent
   *  facing term when `!keepFacingTangent`. */
  durationSec: number;
  elapsedSec: number;
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
  /** Per-direction walk-cycle clip table. When set, `walkTo`/`orbit` select
   *  the clip matching the motion's dominant local-frame component on every
   *  motion start. Translations without a matching clip are rejected so the
   *  avatar never slides with locked legs. Null = legacy single-clip mode
   *  driven by `setWalkCycleClip`. */
  private walkCycleByDirection: {
    forward?: IdleClip;
    backward?: IdleClip;
    left?: IdleClip;
    right?: IdleClip;
  } | null = null;
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
      easing: config.easing ?? DEFAULT_WALKING_CONFIG.easing,
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
      const startX = this.currentX;
      const startZ = this.currentZ;
      const startFacing = this.currentFacing;
      const dx = x - startX;
      const dz = z - startZ;
      const distM = Math.sqrt(dx * dx + dz * dz);
      const facingDelta = shortestArc(startFacing, targetFacing);
      const distSec = this.config.speedMps > 0 ? distM / this.config.speedMps : 0;
      const facingSec =
        this.config.angularSpeedRadPerSec > 0 ? Math.abs(facingDelta) / this.config.angularSpeedRadPerSec : 0;
      const durationSec = Math.max(distSec, facingSec);
      this.motion = {
        kind: 'linear',
        target: { x, z, facing: targetFacing },
        startX,
        startZ,
        startFacing,
        facingDeltaRad: facingDelta,
        durationSec,
        elapsedSec: 0,
        resolve,
        reject,
      };
      // Direction-bound walk-cycle clip selection. In legacy single-clip mode
      // (`walkCycleByDirection === null`) the existing `walkCycleClip` is
      // kept untouched. In directional mode, refuse to translate without a
      // matching clip — "legs don't move, body doesn't move".
      if (this.walkCycleByDirection) {
        const cycle = this.pickCycleClipForMotion(this.motion);
        if (distM >= 1e-3 && !cycle) {
          this.motion = null;
          reject(
            new WalkInterruptedError({
              x: startX,
              z: startZ,
              facing: startFacing,
            }),
          );
          return;
        }
        this.walkCycleClip = cycle;
        this.cycleElapsedMs = 0;
      }
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
      // Duration: time to traverse the arc at speedMps, plus a non-tangent facing term if
      // the facing must interpolate to an explicit target (shared eased progress → both
      // finish simultaneously).
      const arcLen = Math.abs(opts.sweepRad) * effectiveRadius;
      const arcSec = this.config.speedMps > 0 ? arcLen / this.config.speedMps : 0;
      let facingSec = 0;
      if (!keepFacingTangent && opts.targetFacing !== undefined && this.config.angularSpeedRadPerSec > 0) {
        facingSec = Math.abs(shortestArc(this.currentFacing, opts.targetFacing)) / this.config.angularSpeedRadPerSec;
      }
      const durationSec = Math.max(arcSec, facingSec);
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
        durationSec,
        elapsedSec: 0,
        resolve,
        reject,
      };
      // Orbit always uses the forward cycle clip (avatar continuously
      // re-faces the tangent, so motion is "forward in current facing").
      // Refuse the orbit if directional mode is on but forward is missing.
      if (this.walkCycleByDirection) {
        const cycle = this.pickCycleClipForMotion(this.motion);
        if (!cycle) {
          this.motion = null;
          reject(
            new WalkInterruptedError({
              x: this.currentX,
              z: this.currentZ,
              facing: this.currentFacing,
            }),
          );
          return;
        }
        this.walkCycleClip = cycle;
        this.cycleElapsedMs = 0;
      }
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
    this.walkCycleByDirection = null;
    this.walkCycleClip = clip;
    this.authoredSpeedMps = authoredSpeedMps;
    this.cycleElapsedMs = 0;
    this.cachedQuat = null;
  }

  /**
   * Bind walk-cycle clips to the four cardinal motion directions
   * (character-local frame). On every `walkTo` / `orbit`, the layer picks
   * the entry matching the dominant local component of the motion vector:
   *
   *   - forward (positive +Z local) → `forward`
   *   - backward → `backward`
   *   - right strafe (positive +X local) → `right`
   *   - left strafe → `left`
   *   - orbit (any sweep) → `forward` (avatar continuously turns to tangent
   *     so the cycle is always "moving forward in current facing")
   *   - pure turn (no translation) → no cycle clip
   *
   * Random-angle walks must `turn` first then translate along a cardinal
   * direction; an omnidirectional clip is unnecessary. Diagonal motions
   * pick the dominant axis (forward + slight strafe → forward clip).
   *
   * If a translation is requested and the matching directional entry is
   * absent, the motion is rejected — "legs don't move, body doesn't move".
   */
  setWalkCycleClipsByDirection(
    map: { forward?: IdleClip; backward?: IdleClip; left?: IdleClip; right?: IdleClip },
    authoredSpeedMps = 1.0,
  ): void {
    this.walkCycleByDirection = { ...map };
    this.walkCycleClip = null;
    this.authoredSpeedMps = authoredSpeedMps;
    this.cycleElapsedMs = 0;
    this.cachedQuat = null;
  }

  /**
   * Pick the walk-cycle clip matching `motion`'s dominant local-frame
   * direction. Returns null when no directional table is configured (caller
   * falls back to legacy single-clip mode), when no matching entry exists
   * for the motion's direction, or when motion is a pure rotation with no
   * translation.
   */
  private pickCycleClipForMotion(motion: Motion): IdleClip | null {
    if (!this.walkCycleByDirection) return this.walkCycleClip;
    if (motion.kind === 'orbit') return this.walkCycleByDirection.forward ?? null;
    const dx = motion.target.x - motion.startX;
    const dz = motion.target.z - motion.startZ;
    const distM = Math.sqrt(dx * dx + dz * dz);
    if (distM < 1e-3) return null; // pure turn — no walk cycle needed
    // Transform world Δ into character-local frame at motion start. Forward
    // axis = (sin(facing), cos(facing)); Right axis = (cos(facing), -sin(facing)).
    const sinF = Math.sin(motion.startFacing);
    const cosF = Math.cos(motion.startFacing);
    const localFwd = dx * sinF + dz * cosF;
    const localRight = dx * cosF - dz * sinF;
    if (Math.abs(localFwd) >= Math.abs(localRight)) {
      return localFwd >= 0
        ? (this.walkCycleByDirection.forward ?? null)
        : (this.walkCycleByDirection.backward ?? null);
    }
    return localRight >= 0
      ? (this.walkCycleByDirection.right ?? null)
      : (this.walkCycleByDirection.left ?? null);
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

  /**
   * Channels currently owned by this layer — read by the occupancy arbiter.
   * When a motion is pending the layer drives root translation
   * (`vrm.root.x/z/rotY`) and, if a walk-cycle clip is configured, the bone
   * tracks of that clip (legs / spine / hips). When no motion is active the
   * layer emits nothing and returns empty.
   */
  getActiveChannels(): ReadonlySet<string> {
    if (!this.motion) return WALKING_LAYER_EMPTY_CHANNELS;
    const set = new Set<string>(['vrm.root.x', 'vrm.root.z', 'vrm.root.rotY']);
    if (this.walkCycleClip) {
      for (const t of this.walkCycleClip.tracks) set.add(t.channel);
    }
    return set;
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

  /**
   * Advance a linear motion by one tick.
   *
   * Model: progress-based with shared eased curve across translation + facing.
   *   rawProgress  = elapsedSec / durationSec       (clamped to [0, 1])
   *   easedP       = applyEasing(rawProgress, cfg.easing)
   *   currentX     = startX + (targetX - startX) * easedP
   *   currentZ     = startZ + (targetZ - startZ) * easedP
   *   currentFacing = normalize(startFacing + facingDelta * easedP)
   *
   * With `easeInOutCubic` the instantaneous speed ramps from 0 → peak (~1.5× speedMps) →
   * 0 across the motion, producing natural wind-up / follow-through. `linearStepM` is
   * returned as the actual Euclidean distance moved this tick so downstream walk-cycle
   * rate scaling stays accurate under the varying instantaneous speed.
   */
  private advanceLinear(motion: LinearMotion, dtSec: number): { done: boolean; linearStepM: number } {
    motion.elapsedSec += dtSec;
    const rawProgress = motion.durationSec > 0 ? Math.min(1, motion.elapsedSec / motion.durationSec) : 1;
    const easedProgress = applyEasing(rawProgress, this.config.easing);

    const prevX = this.currentX;
    const prevZ = this.currentZ;

    this.currentX = motion.startX + (motion.target.x - motion.startX) * easedProgress;
    this.currentZ = motion.startZ + (motion.target.z - motion.startZ) * easedProgress;
    this.currentFacing = normalizeAngle(motion.startFacing + motion.facingDeltaRad * easedProgress);

    const linearStepM = Math.sqrt((this.currentX - prevX) ** 2 + (this.currentZ - prevZ) ** 2);
    return { done: rawProgress >= 1, linearStepM };
  }

  /**
   * Advance an orbit motion by one tick.
   *
   * Same progress model as linear motion: `sweptRad = |totalSweepRad| * easedProgress`,
   * position derived from polar angle around the centre, facing follows tangent (or
   * interpolates to targetFacing via the shared eased progress for non-tangent orbits).
   * `linearStepM` is Euclidean, so it captures the actual arc-chord moved this tick
   * including the non-linear speed profile at the boundaries.
   */
  private advanceOrbit(motion: OrbitMotion, dtSec: number): { done: boolean; linearStepM: number } {
    motion.elapsedSec += dtSec;
    const rawProgress = motion.durationSec > 0 ? Math.min(1, motion.elapsedSec / motion.durationSec) : 1;
    const easedProgress = applyEasing(rawProgress, this.config.easing);

    motion.sweptRad = Math.abs(motion.totalSweepRad) * easedProgress;
    const direction = Math.sign(motion.totalSweepRad) || 1;
    const currentAngle = motion.startAngle + direction * motion.sweptRad;

    const prevX = this.currentX;
    const prevZ = this.currentZ;

    this.currentX = motion.center.x + motion.radius * Math.cos(currentAngle);
    this.currentZ = motion.center.z + motion.radius * Math.sin(currentAngle);

    if (motion.keepFacingTangent) {
      this.currentFacing = this.tangentFacingAt(currentAngle, direction);
    } else if (motion.targetFacing !== undefined) {
      const totalDelta = shortestArc(motion.startFacing, motion.targetFacing);
      this.currentFacing = normalizeAngle(motion.startFacing + totalDelta * easedProgress);
    }
    // else: facing held at motion.startFacing (no-op, current already matches)

    const linearStepM = Math.sqrt((this.currentX - prevX) ** 2 + (this.currentZ - prevZ) ** 2);
    return { done: rawProgress >= 1, linearStepM };
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
