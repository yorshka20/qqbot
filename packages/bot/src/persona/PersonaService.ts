/**
 * PersonaService — orchestrator for the mind subsystem.
 *
 * Phase 1 responsibilities:
 *   1. Own the Phenotype singleton (in-memory, per-process).
 *   2. Tick the ODE on a fixed timer, reading the avatar's pose to
 *      decide whether the bot is "active" (so fatigue accrues).
 *   3. Subscribe to `message_received` events on the InternalEventBus
 *      and translate them into attention-spike stimuli.
 *   4. Produce HUD snapshots on demand.
 *
 * The service does NOT import avatar internals — it holds a thin
 * `PoseProvider` callback set at wiring time. This keeps mind → avatar
 * a one-way soft dep (avatar also doesn't import mind).
 */

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { AgendaSystemEvent } from '@/agenda/types';
import { logger } from '@/utils/logger';
import { type CharacterBible, EMPTY_BIBLE } from './data/CharacterBibleLoader';
import { type CoreDNA, DEFAULT_CORE_DNA } from './data/CoreDNALoader';
import { applyStimulus, deriveModulation, freshPhenotype, tickPhenotype } from './ode';
import {
  buildPromptPatch,
  buildPromptPatchAsync,
  type PromptPatch,
  renderPromptPatchFragment,
  renderStablePromptPatchFragment,
  renderVolatilePromptPatchFragment,
} from './prompt/PromptPatchAssembler';
import type { EpigeneticsStore } from './reflection/epigenetics/EpigeneticsStore';
import type { Tone } from './reflection/tone/types';
import type { PersonaConfig, PersonaStateSnapshot, Phenotype, Stimulus } from './types';

/**
 * The event type `MessagePipeline` publishes after a successful
 * `lifecycle.execute`. Kept as a constant here so producer + subscriber
 * stay in lockstep without a cross-package import.
 */
export const PERSONA_EVENT_MESSAGE_RECEIVED = 'persona.message_received' as const;

/**
 * Minimal view onto the avatar: "is the bot doing something right now?"
 * Phase 1 only needs a boolean to gate fatigue accrual. A future
 * PoseProvider may expand to return richer activity (speaking vs
 * thinking) so we can differentiate accrual rates.
 */
export type PoseProvider = () => { isActive: boolean };

export class PersonaService {
  private phenotype: Phenotype = freshPhenotype();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = Date.now();
  private started = false;
  private poseProvider: PoseProvider | null = null;
  private epigeneticsStore: EpigeneticsStore | null = null;
  /** In-memory current tone — updated by ReflectionEngine (Task 2). Defaults to neutral. */
  private currentTone: Tone = 'neutral';
  /** Character bible loaded at startup. Defaults to EMPTY_BIBLE if no file found. */
  private bible: CharacterBible = EMPTY_BIBLE;
  /** Core DNA loaded at startup. Defaults to DEFAULT_CORE_DNA if no file found. */
  private corePersona: CoreDNA = DEFAULT_CORE_DNA;
  private readonly messageHandler = (event: AgendaSystemEvent): void => {
    this.handleMessageEvent(event);
  };

  constructor(
    private readonly config: PersonaConfig,
    private readonly eventBus: InternalEventBus,
  ) {}

  /**
   * Wire the pose provider. Called from bootstrap after both mind and
   * avatar are instantiated. Safe to call before or after `start()`.
   */
  setPoseProvider(provider: PoseProvider | null): void {
    this.poseProvider = provider;
  }

  /**
   * Wire the epigenetics store. Called during plugin init when SQLite is
   * available. Safe to call before or after `start()`.
   */
  setEpigeneticsStore(store: EpigeneticsStore | null): void {
    this.epigeneticsStore = store;
  }

  /** Read-only access to the epigenetics store (for relationship lookups). */
  getEpigeneticsStore(): EpigeneticsStore | null {
    return this.epigeneticsStore;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Return the current in-memory tone. Safe to call on the hot path — no I/O. */
  getCurrentTone(): Tone {
    return this.currentTone;
  }

  /**
   * Set the current tone. Called by ReflectionEngine (Task 2) after DB persistence.
   * Also callable from tests or manual override hooks.
   */
  setCurrentTone(tone: Tone): void {
    this.currentTone = tone;
  }

  setCharacterBible(bible: CharacterBible): void {
    this.bible = bible;
  }

  getCharacterBible(): CharacterBible {
    return this.bible;
  }

  setCorePersona(dna: CoreDNA): void {
    this.corePersona = dna;
  }

  getCorePersona(): CoreDNA {
    return this.corePersona;
  }

  getConfig(): PersonaConfig {
    return this.config;
  }

  /** Start tick loop + event subscription. Idempotent. */
  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.info('[PersonaService] Disabled by config — not starting tick loop');
      return;
    }
    this.lastTickAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
    this.eventBus.subscribe(PERSONA_EVENT_MESSAGE_RECEIVED, this.messageHandler);
    this.started = true;
    logger.info(
      `[PersonaService] Started | persona=${this.config.personaId} tickMs=${this.config.tickMs} fatigueAccrual=${this.config.ode.fatigueAccrualPerMs} tauAttention=${this.config.ode.tauAttentionMs}ms`,
    );
  }

  /** Stop tick loop + unsubscribe. Idempotent. */
  stop(): void {
    if (!this.started) return;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.eventBus.unsubscribe(PERSONA_EVENT_MESSAGE_RECEIVED, this.messageHandler);
    this.started = false;
    logger.info('[PersonaService] Stopped');
  }

  /**
   * Inject a stimulus directly. Used by the event handler and by tests
   * (so tests don't need to spin up the real event bus).
   */
  ingest(stimulus: Stimulus): void {
    if (!this.config.enabled) return;
    this.phenotype = applyStimulus(this.phenotype, stimulus, this.config);
  }

  /**
   * Master source-allow-list check used by every mind subsystem that
   * wants to gate behaviour by the originating MessageSource:
   *   - stimulus accrual (this service's own message handler)
   *   - onMessageComplete reflection / relationship update (PersonaCompletionHookPlugin)
   *   - prompt injection default (promptInjectionProducer)
   *
   * Synthetic sources (avatar-cmd / bilibili-danmaku / idle-trigger /
   * bootstrap) are excluded by callers' own logic — this list only
   * constrains which **real-IM** sources are eligible. Returns true when
   * the source is in `config.applicableSources` (default all real-IM).
   */
  isApplicableSource(source: import('../conversation/sources').MessageSource | undefined): boolean {
    if (!source) return false;
    const list = this.config.applicableSources ?? ['qq-private', 'qq-group', 'discord'];
    return list.includes(source);
  }

  /** Read-only phenotype. */
  getPhenotype(): Phenotype {
    return this.phenotype;
  }

  /**
   * Build a HUD-friendly snapshot. Includes the derived modulation so
   * the HUD can show both cause (fatigue) and effect (intensityScale)
   * in the same panel.
   */
  getSnapshot(): PersonaStateSnapshot {
    const modulation = deriveModulation(this.phenotype, this.config);
    return {
      enabled: this.config.enabled,
      personaId: this.config.personaId,
      phenotype: { ...this.phenotype },
      modulation,
      capturedAt: Date.now(),
    };
  }

  /**
   * Project the phenotype onto avatar modulation scalars. Stateless
   * read; safe to call from anywhere (including the modulation
   * provider's hot path on every `enqueueTagAnimation`).
   */
  deriveModulation(): ReturnType<typeof deriveModulation> {
    return deriveModulation(this.phenotype, this.config);
  }

  /**
   * Structured prompt patch derived from the current phenotype. Returns
   * an empty patch when the mind is disabled, `promptPatch.enabled=false`,
   * or phenotype is unremarkable (no notable fatigue). Callers that need
   * the ready-to-concatenate fragment string should use
   * `getPromptPatchFragment()` instead.
   */
  getPromptPatch(): PromptPatch {
    if (!this.config.enabled || !this.config.promptPatch.enabled) return {};
    return buildPromptPatch(this.getSnapshot(), {
      fatigueMildMin: this.config.promptPatch.fatigueMildMin,
      fatigueModerateMin: this.config.promptPatch.fatigueModerateMin,
      fatigueSevereMin: this.config.promptPatch.fatigueSevereMin,
    });
  }

  /**
   * Ready-to-inject string returned via PromptInjectionRegistry. Returns
   * `''` when the patch is empty — caller should check and skip the push
   * so the fragments list stays clean.
   */
  getPromptPatchFragment(): string {
    return renderPromptPatchFragment(this.getPromptPatch());
  }

  /**
   * Async variant of `getPromptPatch` that additionally populates
   * `relationshipSummary` from the EpigeneticsStore when a userId is
   * provided and the store is available.
   */
  async getPromptPatchAsync(opts?: { userId?: string }): Promise<PromptPatch> {
    if (!this.config.enabled || !this.config.promptPatch.enabled) return {};
    return buildPromptPatchAsync(this.getSnapshot(), {
      store: this.epigeneticsStore,
      userId: opts?.userId,
      thresholds: {
        fatigueMildMin: this.config.promptPatch.fatigueMildMin,
        fatigueModerateMin: this.config.promptPatch.fatigueModerateMin,
        fatigueSevereMin: this.config.promptPatch.fatigueSevereMin,
      },
      bible: this.bible,
      injectBible: this.config.promptPatch.injectBible,
      bibleMaxCharsPerSection: this.config.promptPatch.bibleMaxCharsPerSection,
    });
  }

  /**
   * Async variant of `getPromptPatchFragment`. Returns `''` when the patch
   * is empty. Use this in hooks where a userId is available (e.g. PREPROCESS)
   * so the relationship summary is included alongside the mood summary.
   *
   * **Note**: production reply pipeline now prefers the split variants
   * (`getStableFragmentAsync` / `getVolatileFragmentAsync`) so the stable
   * persona identity blocks can sit in the cache-friendly front of the
   * system prompt while volatile mind state stays at the back. This
   * combined method is kept for back-compat with tests / non-pipeline
   * callers.
   */
  async getPromptPatchFragmentAsync(opts?: { userId?: string }): Promise<string> {
    return renderPromptPatchFragment(await this.getPromptPatchAsync(opts));
  }

  /**
   * Stable persona identity fragment — `<persona_identity>` +
   * `<persona_boundaries>`. Doesn't change run-to-run for a given
   * persona + Bible. Place in the cache-friendly front of the system
   * prompt so upstream prompt caches keep hitting.
   */
  async getStableFragmentAsync(opts?: { userId?: string }): Promise<string> {
    return renderStablePromptPatchFragment(await this.getPromptPatchAsync(opts));
  }

  /**
   * Volatile persona state fragment — `<mind_state>` +
   * `<relationship_state>` + `<tone_state>`. Recomputed every message
   * (fatigue / per-user / System-2 reflection output). Place at the
   * back of the system prompt where churn doesn't break upstream cache.
   */
  async getVolatileFragmentAsync(opts?: { userId?: string }): Promise<string> {
    return renderVolatilePromptPatchFragment(await this.getPromptPatchAsync(opts));
  }

  private tick(): void {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    const isActive = this.poseProvider?.().isActive ?? false;
    this.phenotype = tickPhenotype(this.phenotype, dtMs, isActive, this.config);
  }

  private handleMessageEvent(event: AgendaSystemEvent): void {
    if (!this.config.enabled) return;
    // Source-aware gate: only real-IM sources in applicableSources drive
    // stimulus accrual. Synthetic events are already filtered upstream
    // (MessagePipeline.publishMindStimulus); this layer additionally
    // enforces the user-configured allow-list (e.g. "DM only").
    const source = (event.data?.source ?? undefined) as import('../conversation/sources').MessageSource | undefined;
    if (!this.isApplicableSource(source)) return;
    this.ingest({
      kind: 'message',
      ts: Date.now(),
      userId: event.userId || undefined,
      groupId: event.groupId || undefined,
    });
  }
}
