// ReflectionEngine — System 2 LLM reflection loop for the Mind subsystem.
//
// Responsibilities:
//   - Periodic timer: every 5 min (configurable), check for recent activity
//     and fire a 'time'-triggered reflection.
//   - Event trigger: keyword detection in completed user messages fires an
//     immediate 'event'-triggered reflection (fire-and-forget, off the reply path).
//   - LLM call: pinned to 'gemini' (configurable) via LLMService.generateFixed().
//   - Schema validation: strict Zod schema on LLM JSON output.
//   - Write path: EpigeneticsStore.applyReflectionPatch(), single retry with
//     halved traitDeltas on trait_bound_exceeded, audit trail on final reject.
//   - In-memory tone sync: updates MindService.setCurrentTone() on success.
//
// Fire-and-forget safety: runReflection() swallows all errors so callers on
// the reply path are never blocked.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { logger } from '@/utils/logger';
import { z } from 'zod';
import type { EpigeneticsStore } from '../epigenetics/EpigeneticsStore';
import type { ReflectionPatch } from '../epigenetics/types';
import type { MindService } from '../MindService';
import { TONE_VOCABULARY } from '../tone/types';
import { renderReflectionPrompt } from './prompt';
import type { ReflectionEngineOptions, ReflectionTrigger } from './types';

// ── Strong-signal keyword tables ────────────────────────────────────────────

const POSITIVE_SIGNALS: string[] = ['谢谢', '感谢', '喜欢', '好喜欢', '太棒了', '真棒', '好厉害', '厉害'];
const NEGATIVE_SIGNALS: string[] = ['抬杠', '无聊', '烦死了', '讨厌', '好烦', '没意思', '好无聊'];
const FESTIVE_SIGNALS: string[] = ['生日快乐', '节日快乐', '新年快乐', '圣诞快乐', '周年快乐'];

const ALL_SIGNALS = [...POSITIVE_SIGNALS, ...NEGATIVE_SIGNALS, ...FESTIVE_SIGNALS];

function hasStrongSignal(text: string): boolean {
  return ALL_SIGNALS.some((kw) => text.includes(kw));
}

// ── Zod schema ───────────────────────────────────────────────────────────────

const ToneEnum = z.enum(TONE_VOCABULARY);

const TraitDeltasSchema = z
  .object({
    extraversion: z.number().min(-0.05).max(0.05).optional(),
    neuroticism: z.number().min(-0.05).max(0.05).optional(),
    openness: z.number().min(-0.05).max(0.05).optional(),
    agreeableness: z.number().min(-0.05).max(0.05).optional(),
    conscientiousness: z.number().min(-0.05).max(0.05).optional(),
  })
  .optional();

const ReflectionOutputSchema = z.object({
  insightMd: z.string().min(1),
  patch: z.object({
    topicMasteryDelta: z.record(z.number().min(-0.1).max(0.1)).optional(),
    behavioralBiasesDelta: z.record(z.number().min(-0.1).max(0.1)).optional(),
    learnedPreferencesAdd: z.record(z.unknown()).optional(),
    forbiddenWordsAdd: z.array(z.string()).optional(),
    forbiddenTopicsAdd: z.array(z.string()).optional(),
    traitDeltas: TraitDeltasSchema,
    currentTone: ToneEnum,
  }),
});

type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;

// ── JSON extraction ──────────────────────────────────────────────────────────

function extractJsonFromText(text: string): unknown {
  // Try ```json ... ``` code fence first
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // Try raw JSON
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  throw new Error('No JSON found in LLM response');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function halveTraitDeltas(
  traitDeltas: ReflectionPatch['traitDeltas'],
): ReflectionPatch['traitDeltas'] {
  if (!traitDeltas) return undefined;
  const result: ReflectionPatch['traitDeltas'] = {};
  for (const [k, v] of Object.entries(traitDeltas)) {
    if (typeof v === 'number') {
      (result as Record<string, number>)[k] = v / 2;
    }
  }
  return result;
}

function buildReflectionPatch(output: ReflectionOutput): ReflectionPatch {
  return {
    topicMasteryDelta: output.patch.topicMasteryDelta,
    behavioralBiasesDelta: output.patch.behavioralBiasesDelta,
    learnedPreferencesAdd: output.patch.learnedPreferencesAdd,
    forbiddenWordsAdd: output.patch.forbiddenWordsAdd,
    forbiddenTopicsAdd: output.patch.forbiddenTopicsAdd,
    traitDeltas: output.patch.traitDeltas,
    currentTone: output.patch.currentTone,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class ReflectionEngine {
  private readonly timerIntervalMs: number;
  private readonly activityWindowMs: number;
  private readonly activityMinMessages: number;
  private readonly cooldownMs: number;
  private readonly pinnedProvider: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReflectionAt = 0;
  private eventCooldownUntil = 0;

  /** Sliding window of message timestamps for activity gating. */
  private recentMessageTimestamps: number[] = [];

  /** Last known active group ID, updated from event triggers. */
  private lastActiveGroupId: string | number | undefined;

  constructor(
    private readonly store: EpigeneticsStore,
    private readonly mindService: MindService,
    private readonly llmService: LLMService,
    private readonly promptManager: PromptManager,
    private readonly historyService: ConversationHistoryService,
    private readonly options: ReflectionEngineOptions,
  ) {
    this.timerIntervalMs = options.timerIntervalMs ?? 5 * 60_000;
    this.activityWindowMs = options.activityWindowMs ?? 5 * 60_000;
    this.activityMinMessages = options.activityMinMessages ?? 3;
    this.cooldownMs = options.cooldownMs ?? this.timerIntervalMs;
    this.pinnedProvider = options.pinnedProvider ?? 'gemini';
  }

  /** Start the periodic reflection timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.timerTick();
    }, this.timerIntervalMs);
    logger.info(
      `[ReflectionEngine] Started | persona=${this.options.personaId} intervalMs=${this.timerIntervalMs} provider=${this.pinnedProvider}`,
    );
  }

  /** Stop the timer. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[ReflectionEngine] Stopped');
    }
  }

  /**
   * Record a completed message for activity gating and optionally enqueue an
   * event-triggered reflection when strong-signal keywords are detected.
   *
   * Fire-and-forget: never throws, never awaits LLM work on the caller's path.
   */
  enqueueEventReflection(
    userText: string,
    sessionCtx?: { groupId?: string | number },
  ): void {
    const now = Date.now();

    // Track activity for timer gating.
    this.recentMessageTimestamps.push(now);
    if (sessionCtx?.groupId !== undefined) {
      this.lastActiveGroupId = sessionCtx.groupId;
    }

    // Event-trigger only on strong signals + respect cooldown.
    if (!hasStrongSignal(userText)) return;
    if (now < this.eventCooldownUntil) {
      logger.debug('[ReflectionEngine] event reflection skipped: cooldown active');
      return;
    }
    if (now - this.lastReflectionAt < this.cooldownMs) {
      logger.debug('[ReflectionEngine] event reflection skipped: global cooldown active');
      return;
    }

    this.eventCooldownUntil = now + this.cooldownMs;
    logger.debug(`[ReflectionEngine] strong signal detected — enqueuing event reflection`);

    void this.runReflection({ trigger: 'event' }).catch((err: unknown) => {
      logger.warn('[ReflectionEngine] event reflection error (swallowed):', err);
    });
  }

  /**
   * Run a full reflection cycle.
   * Public so it can be called manually (e.g. from a shell command for dev/testing).
   * Never throws — all errors are caught and logged.
   */
  async runReflection(opts: { trigger: ReflectionTrigger }): Promise<void> {
    const { trigger } = opts;
    const { personaId } = this.options;
    const startedAt = Date.now();

    logger.info(`[ReflectionEngine] runReflection start | trigger=${trigger} persona=${personaId}`);

    try {
      // 1. Load epigenetics + current phenotype snapshot.
      const epigenetics = await this.store.getEpigenetics(personaId);
      const phenotype = this.mindService.getPhenotype();

      // 2. Get recent dialogue (up to 20 entries).
      const recentMessages = this.lastActiveGroupId
        ? await this.historyService.getRecentMessages(this.lastActiveGroupId, 20)
        : [];

      const recentDialogue =
        recentMessages.length > 0
          ? recentMessages
              .map((m) => `${m.isBotReply ? 'Bot' : `User<${m.userId}>`}: ${m.content}`)
              .join('\n')
          : '（无近期对话记录）';

      // 3. Render prompt.
      const systemPrompt = renderReflectionPrompt(this.promptManager, {
        personaId,
        phenotypeJson: JSON.stringify(phenotype, null, 2),
        epigeneticsJson: epigenetics ? JSON.stringify(epigenetics, null, 2) : '（无记录）',
        recentDialogue,
        trigger,
      });

      // 4. Call LLM — pinned provider, no fallback, JSON mode.
      const response = await this.llmService.generateFixed(this.pinnedProvider, '', {
        systemPrompt,
        maxTokens: 1024,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: '请根据以上输入完成反思，输出符合格式要求的 JSON。',
          },
        ],
      });

      // 5. Parse + validate.
      let parsed: unknown;
      try {
        parsed = extractJsonFromText(response.text);
      } catch (parseErr) {
        logger.warn('[ReflectionEngine] failed to extract JSON from LLM response:', parseErr);
        return;
      }

      const validation = ReflectionOutputSchema.safeParse(parsed);
      if (!validation.success) {
        logger.warn('[ReflectionEngine] schema validation failed:', validation.error.flatten());
        return;
      }

      const output = validation.data;
      const patch = buildReflectionPatch(output);

      // 6. Write path: apply patch, retry once on trait_bound_exceeded.
      await this.applyWithRetry(personaId, patch, output.insightMd, trigger);

      const elapsedMs = Date.now() - startedAt;
      logger.info(
        `[ReflectionEngine] runReflection complete | trigger=${trigger} persona=${personaId} elapsedMs=${elapsedMs}`,
      );
    } catch (err) {
      logger.warn(`[ReflectionEngine] runReflection failed (trigger=${trigger}):`, err);
    } finally {
      this.lastReflectionAt = Date.now();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async timerTick(): Promise<void> {
    const now = Date.now();

    // Cooldown guard.
    if (now - this.lastReflectionAt < this.cooldownMs) return;

    // Activity gate: prune old timestamps then count.
    if (!this.hasRecentActivity(now)) {
      logger.debug('[ReflectionEngine] timer tick: no recent activity, skipping');
      return;
    }

    await this.runReflection({ trigger: 'time' }).catch((err: unknown) => {
      logger.warn('[ReflectionEngine] timer reflection error (swallowed):', err);
    });
  }

  private hasRecentActivity(now: number): boolean {
    const cutoff = now - this.activityWindowMs;
    const recent = this.recentMessageTimestamps.filter((t) => t >= cutoff);
    // Prune in place.
    this.recentMessageTimestamps = recent;
    return recent.length >= this.activityMinMessages;
  }

  /**
   * Apply patch to DB. On trait_bound_exceeded, retry once with halved deltas.
   * On final rejection, write an audit row.
   */
  private async applyWithRetry(
    personaId: string,
    patch: ReflectionPatch,
    insightMd: string,
    trigger: ReflectionTrigger,
  ): Promise<void> {
    const result = await this.store.applyReflectionPatch(personaId, patch, { trigger, insightMd });

    if (result.accepted) {
      // Sync in-memory tone.
      if (patch.currentTone !== undefined) {
        this.mindService.setCurrentTone(patch.currentTone);
      }
      logger.info(
        `[ReflectionEngine] patch applied | persona=${personaId} reflectionId=${result.reflectionId} tone=${patch.currentTone}`,
      );
      return;
    }

    if (result.rejectedReason?.startsWith('trait_bound_exceeded:')) {
      // Single retry with halved trait deltas.
      const halvedPatch: ReflectionPatch = {
        ...patch,
        traitDeltas: halveTraitDeltas(patch.traitDeltas),
      };
      const retryResult = await this.store.applyReflectionPatch(personaId, halvedPatch, { trigger, insightMd });

      if (retryResult.accepted) {
        if (patch.currentTone !== undefined) {
          this.mindService.setCurrentTone(patch.currentTone);
        }
        logger.info(
          `[ReflectionEngine] patch applied (retry with halved traits) | persona=${personaId} reflectionId=${retryResult.reflectionId}`,
        );
        return;
      }

      // Both attempts rejected — write audit trail.
      const auditReason = `rejected after retry: ${retryResult.rejectedReason ?? 'unknown'}`;
      await this.store.writeRejectionAudit(personaId, patch, auditReason);
      logger.warn(
        `[ReflectionEngine] patch rejected after retry | persona=${personaId} reason=${retryResult.rejectedReason}`,
      );
    } else {
      // Other rejection — write audit trail.
      const auditReason = `rejected: ${result.rejectedReason ?? 'unknown'}`;
      await this.store.writeRejectionAudit(personaId, patch, auditReason);
      logger.warn(
        `[ReflectionEngine] patch rejected | persona=${personaId} reason=${result.rejectedReason}`,
      );
    }
  }
}
