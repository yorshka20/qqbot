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
//   - In-memory tone sync: updates PersonaService.setCurrentTone() on success.
//
// Fire-and-forget safety: runReflection() swallows all errors so callers on
// the reply path are never blocked.

import { z } from 'zod';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { FunctionCall } from '@/ai/types';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import { ToolExecutionContextBuilder } from '@/context/ToolExecutionContextBuilder';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { HookManager } from '@/hooks/HookManager';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { PersonaService } from '../PersonaService';
import type { EpigeneticsStore } from './epigenetics/EpigeneticsStore';
import type { ReflectionPatch } from './epigenetics/types';
import { renderReflectionPrompt } from './prompt';
import { TONE_VOCABULARY } from './tone/types';
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

function halveTraitDeltas(traitDeltas: ReflectionPatch['traitDeltas']): ReflectionPatch['traitDeltas'] {
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
    private readonly personaService: PersonaService,
    private readonly llmService: LLMService,
    private readonly promptManager: PromptManager,
    private readonly historyService: ConversationHistoryService,
    private readonly options: ReflectionEngineOptions,
    private readonly toolManager?: ToolManager,
    private readonly hookManager?: HookManager,
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
  enqueueEventReflection(userText: string, sessionCtx?: { groupId?: string | number }): void {
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
      const phenotype = this.personaService.getPhenotype();

      // 2. Get recent dialogue (up to 20 entries).
      const recentMessages = this.lastActiveGroupId
        ? await this.historyService.getRecentMessages(this.lastActiveGroupId, 20)
        : [];

      const recentDialogue =
        recentMessages.length > 0
          ? recentMessages.map((m) => `${m.isBotReply ? 'Bot' : `User<${m.userId}>`}: ${m.content}`).join('\n')
          : '（无近期对话记录）';

      // 3. Render prompt.
      const bibleObj = this.personaService.getCharacterBible();
      const characterBible =
        bibleObj.raw.length > 0 ? bibleObj.raw : '(no character bible configured for this persona)';

      const systemPrompt = renderReflectionPrompt(this.promptManager, {
        personaId,
        phenotypeJson: JSON.stringify(phenotype, null, 2),
        epigeneticsJson: epigenetics ? JSON.stringify(epigenetics, null, 2) : '（无记录）',
        recentDialogue,
        trigger,
        characterBible,
      });

      // 4. Choose execution path: agent loop (tool-equipped) or single call.
      const reflectionCfg = this.personaService.getConfig().reflection;
      const toolEquipped = reflectionCfg?.toolEquipped === true;
      const maxToolRounds = reflectionCfg?.maxToolRounds ?? 4;

      let output: ReflectionOutput | undefined;

      if (toolEquipped && maxToolRounds > 0 && this.toolManager && this.hookManager) {
        output = await this.runToolLoop(systemPrompt, maxToolRounds, personaId);
      }

      // If the tool loop didn't produce a valid output (or was not enabled), fall back to single call.
      if (!output) {
        output = await this.runSingleCall(systemPrompt);
      }

      if (!output) {
        // Both paths failed — reflection aborted (errors already logged inside each path).
        return;
      }

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

  /**
   * Run the single-call fallback path (current behavior).
   * Returns a validated ReflectionOutput or undefined on failure.
   */
  private async runSingleCall(systemPrompt: string): Promise<ReflectionOutput | undefined> {
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

    let parsed: unknown;
    try {
      parsed = extractJsonFromText(response.text);
    } catch (parseErr) {
      logger.warn('[ReflectionEngine] single-call: failed to extract JSON:', parseErr);
      return undefined;
    }

    const validation = ReflectionOutputSchema.safeParse(parsed);
    if (!validation.success) {
      logger.warn('[ReflectionEngine] single-call: schema validation failed:', validation.error.flatten());
      return undefined;
    }
    return validation.data;
  }

  /**
   * Run the tool-equipped agent loop.
   * Returns a validated ReflectionOutput or undefined when the loop ends without a valid final JSON.
   */
  private async runToolLoop(
    systemPrompt: string,
    maxToolRounds: number,
    personaId: string,
  ): Promise<ReflectionOutput | undefined> {
    // Both are guaranteed non-null by the call-site guard in runReflection().
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const toolManager = this.toolManager as ToolManager;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const hookManager = this.hookManager as HookManager;

    const reflectionTools = toolManager.getToolsByScope('reflection');
    if (reflectionTools.length === 0) {
      logger.debug('[ReflectionEngine] tool loop: no reflection-scope tools found, skipping');
      return undefined;
    }

    const toolDefinitions = toolManager.toToolDefinitions(reflectionTools);

    // Build a minimal HookContext for reflection-scope tool execution.
    const reflectionHookContext = HookContextBuilder.create()
      .withSyntheticMessage({ userId: 0, messageType: 'private', message: 'reflection-scope' })
      .withConversationContext({ userMessage: '', history: [], userId: 0, messageType: 'private', metadata: new Map() })
      .withSource('qq-private')
      .build();

    // Build ToolExecutionContext — no real message/group, just reflection metadata.
    const toolExecutionContext = ToolExecutionContextBuilder.create()
      .withUserId('reflection-system')
      .withMessageType('private')
      .withMetadata({ reflectionScope: true, personaId })
      .build();

    let toolCallsExecuted = 0;

    const toolExecutor = async (call: FunctionCall): Promise<unknown> => {
      toolCallsExecuted++;
      logger.debug(`[ReflectionEngine] tool loop: executing tool "${call.name}"`);

      const toolSpec = toolManager.getTool(call.name);
      if (!toolSpec) {
        return `Error: tool "${call.name}" not found in reflection scope`;
      }

      let parameters: Record<string, unknown>;
      try {
        parameters = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        parameters = {};
      }

      const toolCall = {
        type: call.name,
        parameters,
        executor: toolSpec.executor,
      };

      const result = await toolManager.execute(toolCall, toolExecutionContext, hookManager, reflectionHookContext);
      return result.success ? (result.data ?? result.reply) : `Error: ${result.error}`;
    };

    const response = await this.llmService.generateWithTools(
      [{ role: 'user', content: '请根据以上输入完成反思，使用工具收集更多上下文，然后输出符合格式要求的 JSON。' }],
      toolDefinitions,
      {
        systemPrompt,
        maxTokens: 1024,
        temperature: 0.3,
        maxToolRounds,
        toolExecutor,
      },
      this.pinnedProvider,
    );

    logger.debug(
      `[ReflectionEngine] tool loop finished | toolRoundsUsed=${maxToolRounds} toolCallsExecuted=${toolCallsExecuted} stopReason=${response.stopReason}`,
    );

    // Attempt to parse final assistant text as ReflectionOutput JSON.
    let parsed: unknown;
    try {
      parsed = extractJsonFromText(response.text);
    } catch {
      logger.warn('[ReflectionEngine] tool loop: final output is not valid JSON; falling back to single-call');
      return undefined;
    }

    const validation = ReflectionOutputSchema.safeParse(parsed);
    if (!validation.success) {
      logger.warn(
        '[ReflectionEngine] tool loop: final JSON failed schema validation; falling back to single-call:',
        validation.error.flatten(),
      );
      return undefined;
    }

    logger.debug('[ReflectionEngine] tool loop: final JSON valid ✓');
    return validation.data;
  }

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
        this.personaService.setCurrentTone(patch.currentTone);
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
          this.personaService.setCurrentTone(patch.currentTone);
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
      logger.warn(`[ReflectionEngine] patch rejected | persona=${personaId} reason=${result.rejectedReason}`);
    }
  }
}
