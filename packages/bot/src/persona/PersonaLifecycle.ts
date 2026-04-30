/**
 * Mind subsystem lifecycle — single entry point for bot bootstrap.
 *
 * Encapsulates all the per-service plumbing that was previously spread
 * across `bootstrap.ts`:
 *   - wiring modulation provider into avatar
 *   - wiring mind-state source into avatar (HUD broadcast)
 *   - wiring avatar pose back into mind (fatigue accrual)
 *   - starting the phenotype tick loop
 *   - building the wander executor adapter
 *   - starting the wander scheduler
 *
 * Bootstrap calls `startPersonaSubsystem(...)` once; all of the above is
 * hidden inside. Adding new mind↔avatar wires (Phase 3+) amends this
 * function, not bootstrap.
 */

import type { AvatarService } from '@qqbot/avatar';
import { logger } from '@/utils/logger';
import { AutonomousTriggerScheduler } from '@/integrations/avatar/services/AutonomousTriggerScheduler';
import type { PersonaModulationAdapter } from '@/integrations/avatar/services/PersonaModulationAdapter';
import type { PersonaService } from './PersonaService';
import { derivePersonaPostureBias } from './ode';
import type { ReflectionEngine } from './reflection/ReflectionEngine';
import type { WanderExecutor } from '@/integrations/avatar/services/wander/types';
import { WanderScheduler } from '@/integrations/avatar/services/wander/WanderScheduler';

/** Interval at which phenotype → PersonaPostureBias push fires. */
const POSTURE_PUSH_MS = 1000;

export interface PersonaLifecycleHandles {
  /** Null when wander is disabled by config or no avatar is available. */
  wanderScheduler: WanderScheduler | null;
  /** Null when no avatar is available; otherwise the interval handle for
   *  the posture-bias push loop. */
  postureTimer: ReturnType<typeof setInterval> | null;
  /** Null when no avatar / autonomous trigger disabled. */
  autonomousTriggerScheduler: AutonomousTriggerScheduler | null;
  /**
   * The reflection engine instance, when provided by the caller.
   * Constructed and started by PersonaCompletionHookPlugin.onInit() (after DI services
   * including EpigeneticsStore are available). Null when mind is disabled or
   * the engine was not passed to startPersonaSubsystem().
   */
  reflectionEngine: ReflectionEngine | null;
}

/**
 * Attach mind ↔ avatar and start the mind tick loop + wander scheduler.
 *
 * Behaviour:
 *  - `personaService.isEnabled() === false` → returns immediately, no-op
 *  - `avatarService == null` → mind still starts (fatigue will stay at
 *    zero since pose provider is unset), but no avatar wiring and no
 *    wander scheduler
 *  - otherwise wires everything and returns handles for the caller to
 *    optionally stop later
 */
export function startPersonaSubsystem(
  personaService: PersonaService,
  modulationProvider: PersonaModulationAdapter,
  avatarService: AvatarService | null,
  reflectionEngine?: ReflectionEngine | null,
): PersonaLifecycleHandles {
  if (!personaService.isEnabled()) {
    logger.info('[Mind] Disabled by config — skipped wiring');
    return { wanderScheduler: null, postureTimer: null, autonomousTriggerScheduler: null, reflectionEngine: null };
  }

  if (avatarService) {
    attachAvatar(personaService, modulationProvider, avatarService);
  }

  personaService.start();
  const cfg = personaService.getConfig();
  logger.info(
    `[Mind] Started | linkedToAvatar=${!!avatarService} persona=${cfg.personaId} tickMs=${cfg.tickMs} wander=${cfg.wander.enabled}`,
  );

  let wanderScheduler: WanderScheduler | null = null;
  if (avatarService && cfg.wander.enabled) {
    wanderScheduler = new WanderScheduler(cfg.wander, buildWanderExecutor(avatarService));
    wanderScheduler.start();
  }

  let postureTimer: ReturnType<typeof setInterval> | null = null;
  if (avatarService) {
    postureTimer = startPostureDriver(personaService, avatarService);
  }

  let autonomousTriggerScheduler: AutonomousTriggerScheduler | null = null;
  if (avatarService && cfg.autonomousTrigger.enabled) {
    autonomousTriggerScheduler = new AutonomousTriggerScheduler(cfg.autonomousTrigger, {
      mind: personaService,
      avatar: avatarService,
    });
    autonomousTriggerScheduler.start();
  }

  return { wanderScheduler, postureTimer, autonomousTriggerScheduler, reflectionEngine: reflectionEngine ?? null };
}

/** Avatar ↔ mind wiring. Extracted so the mind→wander block below stays readable. */
function attachAvatar(mind: PersonaService, modulationProvider: PersonaModulationAdapter, avatar: AvatarService): void {
  avatar.setMindModulationProvider(modulationProvider);
  avatar.setMindStateSource(() => mind.getSnapshot());
  mind.setPoseProvider(() => {
    const activity = avatar.getCurrentActivity();
    return { isActive: !!activity && activity.pose !== 'neutral' };
  });
}

/**
 * Periodic phenotype → PersonaPostureBias push loop.
 *
 * Runs at `POSTURE_PUSH_MS` interval (default 1 Hz — same cadence as the
 * phenotype tick, so the bias trails fatigue changes smoothly). The
 * first push happens synchronously so posture is visible even before
 * the first tick fires.
 *
 * Phase 1 derivation is hardcoded (see `derivePersonaPostureBias`): the
 * avatar has a subtle baseline forward-lean + moderate eye-contact even
 * at fatigue=0, and fatigue amplifies / suppresses them. Tuning moves
 * into config once we have a Core DNA persona loader.
 */
function startPostureDriver(mind: PersonaService, avatar: AvatarService): ReturnType<typeof setInterval> {
  const push = (): void => {
    const phenotype = mind.getPhenotype();
    const cdna = mind.getCorePersona();
    avatar.setPersonaPostureBias(derivePersonaPostureBias(phenotype, cdna.modulation.spatial));
    const ambient = cdna.modulation.ambient;
    const gain = ambient.gainScale * (1 - ambient.fatigueDrop * Math.max(0, Math.min(1, phenotype.fatigue)));
    avatar.setAmbientGainSource('mind', Math.max(0, gain));
  };
  push();
  return setInterval(push, POSTURE_PUSH_MS);
}

/**
 * Adapter from AvatarService's public API to the narrow interface
 * `WanderScheduler` consumes. Kept here (not on AvatarService) so the
 * avatar package stays unaware of mind internals.
 */
function buildWanderExecutor(avatar: AvatarService): WanderExecutor {
  return {
    getCurrentPose: () => avatar.getCurrentActivity()?.pose ?? 'neutral',
    isAvatarActive: () => avatar.isActive(),
    hasConsumer: () => avatar.hasConsumer(),
    checkAvailable: (f) => avatar.checkAvailable(f),
    walkForward: (m) => avatar.walkForward(m),
    strafe: (m) => avatar.strafe(m),
    turn: (r) => avatar.turn(r),
    setGazeTarget: (t) => avatar.setGazeTarget(t),
    setHeadLook: (t) => avatar.setHeadLook(t),
    playIdleClip: (name) => avatar.enqueueAutonomous(name, 1.0),
  };
}
