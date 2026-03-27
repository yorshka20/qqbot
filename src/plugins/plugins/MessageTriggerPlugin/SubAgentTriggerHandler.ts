// SubAgentTriggerHandler - keyword match → spawn subagent → deliver result to group

import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { SendMessageResult } from '@/api/types';
import type { ConversationConfigService } from '@/conversation/ConversationConfigService';
import type { NormalizedMessageEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { hasSkipCardMarker, stripSkipCardMarker } from '@/utils/contentMarkers';
import { logger } from '@/utils/logger';
import type { SubAgentTriggerRule } from './types';

/**
 * Template key prefixes for subagent presets:
 *   subagent.{presetKey}.keywords  → prompts/subagent/{presetKey}/keywords.txt
 *   subagent.{presetKey}.task      → prompts/subagent/{presetKey}/task.txt
 */

/**
 * Handles the full lifecycle of a keyword-triggered background subagent:
 *   1. Keyword matching via prompts/subagent/{presetKey}/keywords.txt
 *   2. Per-rule per-group cooldown enforcement
 *   3. Keyword match independent of normal reply pipeline
 *   4. Notification message sent to target group before spawning
 *   5. Cancellation tracking: reaction on the notification → cancel before result delivery
 *   6. Task construction from prompts/subagent/{presetKey}/task.txt (renders {{message}})
 *   7. Fire-and-forget spawn via AIService.runSubAgent()
 *   8. Push result text back to the target group via MessageAPI
 *
 * The handler is intentionally side-effect-only — it never influences
 * the normal reply pipeline (postProcessOnly / replyTriggerType).
 */
export class SubAgentTriggerHandler {
  /**
   * Cooldown tracking: `${ruleIndex}:${groupId}` → last trigger timestamp (ms).
   * Reset on process restart, which is acceptable — cooldowns are advisory.
   */
  private readonly cooldowns = new Map<string, number>();

  /**
   * Keyword cache: presetKey → lowercase keyword list.
   * Populated lazily on first access; avoids repeated template lookups per message.
   */
  private readonly keywordCache = new Map<string, string[]>();

  /**
   * Pending subagent tracking: notification messageSeq (or messageId) → cancel function.
   * Used to cancel an in-flight subagent when a user reacts to its notification message.
   * Entries are cleaned up on completion or cancellation.
   */
  private readonly pendingAgents = new Map<number, () => void>();

  constructor(
    private readonly rules: SubAgentTriggerRule[],
    private readonly promptManager: PromptManager,
    private readonly aiService: AIService,
    private readonly messageAPI: MessageAPI,
    private readonly conversationConfigService: ConversationConfigService,
    /** Protocol name used when sending the result message proactively. */
    private readonly protocol: string,
    /** Bot's own QQ user id; required for forward message (Milky). 0 = not configured. */
    private readonly botSelfId: number,
  ) {}

  /**
   * Check all rules against the incoming message.
   * For each matching (and not-cooled-down) rule, spawn a subagent in the background.
   *
   * Mutual exclusion: proactive trigger words and subagent keywords are mutually exclusive
   * per message per group. When the normal reply pipeline will fire (proactive trigger matched),
   * same-group subagent rules are skipped — proactive takes priority.
   * Cross-group rules always fire regardless of proactiveTrigger.
   *
   * This means:
   *   - Only proactive trigger matches  → proactive reply fires, subagent skipped
   *   - Only subagent keyword matches   → subagent fires, no proactive reply
   *   - Both match                      → proactive wins, subagent skipped
   *
   * @param event - The incoming message event.
   * @param proactiveTrigger - Whether the normal reply pipeline will fire for this message
   *   (i.e. @bot, wake word, providerName, or reaction matched).
   * @returns The number of subagents spawned.
   */
  handleMessage(event: NormalizedMessageEvent, proactiveTrigger: boolean): number {
    const lowerText = event.message.toLowerCase();
    const groupId = event.groupId?.toString() ?? '';
    let spawned = 0;

    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (!groupId) continue; // subagent results must go somewhere

      // Cross-group rules always fire; same-group rules are skipped when proactive trigger fires.
      const isCrossGroup = rule.targetGroupId !== undefined && rule.targetGroupId !== groupId;
      if (proactiveTrigger && !isCrossGroup) {
        logger.debug(
          `[SubAgentTriggerHandler] Rule ${i} (${rule.presetKey}) skipped — proactive trigger fired in group ${groupId}`,
        );
        continue;
      }

      if (!this.matchesKeyword(rule.presetKey, lowerText)) continue;
      if (this.isOnCooldown(i, groupId, rule.cooldownMs ?? 60_000)) {
        logger.debug(
          `[SubAgentTriggerHandler] Rule ${i} (${rule.presetKey}) on cooldown for group ${groupId}, skipping`,
        );
        continue;
      }

      this.markCooldown(i, groupId);
      this.spawnInBackground(i, rule, event, groupId);
      spawned++;
    }

    return spawned;
  }

  /**
   * Cancel the in-flight subagent associated with the given notification message sequence.
   * Called when a user reacts to the notification message with the configured cancel reaction.
   *
   * @returns true if a pending subagent was found and cancelled; false otherwise.
   */
  handleCancelReaction(messageSeq: number): boolean {
    const cancelFn = this.pendingAgents.get(messageSeq);
    if (!cancelFn) return false;
    cancelFn();
    this.pendingAgents.delete(messageSeq);
    logger.info(`[SubAgentTriggerHandler] Subagent cancelled via reaction (notificationSeq=${messageSeq})`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Template loading
  // ---------------------------------------------------------------------------

  /**
   * Parse a template content string into a list of lowercase keywords.
   * Blank lines and lines starting with # are ignored (same format as preference trigger templates).
   */
  private parseKeywords(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  /**
   * Load and cache keywords for a presetKey from its keywords.txt template.
   * Returns an empty array if the template is not found (logged as warning once).
   */
  private getKeywords(presetKey: string): string[] {
    const cached = this.keywordCache.get(presetKey);
    if (cached !== undefined) return cached;

    const templateName = `subagent.${presetKey}.keywords`;
    const tpl = this.promptManager.getTemplate(templateName);
    if (!tpl) {
      logger.warn(
        `[SubAgentTriggerHandler] keywords template not found: ${templateName} ` +
          `(expected: prompts/subagent/${presetKey}/keywords.txt)`,
      );
      this.keywordCache.set(presetKey, []);
      return [];
    }

    const keywords = this.parseKeywords(tpl.content);
    this.keywordCache.set(presetKey, keywords);
    logger.debug(`[SubAgentTriggerHandler] Loaded ${keywords.length} keywords for preset "${presetKey}"`);
    return keywords;
  }

  /**
   * Render the task.txt template for a presetKey with the triggering message substituted.
   * Falls back to a generic description if the template is not found.
   */
  private renderTaskDescription(presetKey: string, message: string): string {
    const templateName = `subagent.${presetKey}.task`;
    const tpl = this.promptManager.getTemplate(templateName);
    if (!tpl) {
      logger.warn(
        `[SubAgentTriggerHandler] task template not found: ${templateName} ` +
          `(expected: prompts/subagent/${presetKey}/task.txt) — using generic fallback`,
      );
      return `Process the following message and provide a helpful response: ${message}`;
    }

    // PromptManager.render() uses {{variable}} syntax
    return this.promptManager.render(templateName, { message });
  }

  // ---------------------------------------------------------------------------
  // Matching & cooldown
  // ---------------------------------------------------------------------------

  private matchesKeyword(presetKey: string, lowerText: string): boolean {
    return this.getKeywords(presetKey).some((kw) => lowerText.includes(kw));
  }

  private isOnCooldown(ruleIndex: number, groupId: string, cooldownMs: number): boolean {
    const key = `${ruleIndex}:${groupId}`;
    const last = this.cooldowns.get(key);
    return last !== undefined && Date.now() - last < cooldownMs;
  }

  private markCooldown(ruleIndex: number, groupId: string): void {
    this.cooldowns.set(`${ruleIndex}:${groupId}`, Date.now());
  }

  // ---------------------------------------------------------------------------
  // SubAgent spawn
  // ---------------------------------------------------------------------------

  /**
   * Build a synthetic NormalizedMessageEvent for proactive sends to a group.
   * Mimics the pattern used in ProactiveConversationService.
   */
  private buildSyntheticContext(groupId: number | string): NormalizedMessageEvent {
    return {
      id: '',
      type: 'message',
      timestamp: Date.now(),
      protocol: this.protocol as NormalizedMessageEvent['protocol'],
      userId: 0,
      groupId,
      messageType: 'group',
      message: '',
      segments: [],
    };
  }

  /**
   * Send a "task starting" notification to the target group.
   * Returns the send result so callers can extract messageSeq for cancellation tracking.
   */
  private async sendNotification(
    groupId: number | string,
    displayName: string,
    syntheticContext: NormalizedMessageEvent,
  ): Promise<SendMessageResult | null> {
    try {
      const segments = new MessageBuilder().text(`⏳ 正在后台执行「${displayName}」任务，请稍候...`).build();
      const result = await this.messageAPI.sendFromContext(segments, syntheticContext, 15_000);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`[SubAgentTriggerHandler] Failed to send notification to group ${groupId}:`, error);
      return null;
    }
  }

  /**
   * Launch the full subagent lifecycle in the background (fire-and-forget):
   *   1. Send notification → capture messageSeq for cancellation tracking
   *   2. Run subagent
   *   3. If not cancelled, deliver result to target group
   */
  private spawnInBackground(
    ruleIndex: number,
    rule: SubAgentTriggerRule,
    event: NormalizedMessageEvent,
    groupId: string,
  ): void {
    const preset = getRolePreset(rule.presetKey);
    const targetGroupId = rule.targetGroupId ?? groupId;
    const targetGroupIdNum = Number(targetGroupId);

    const description = this.renderTaskDescription(rule.presetKey, event.message);

    const taskInput = {
      triggeringMessage: event.message,
      groupId,
      userId: event.userId.toString(),
      timestamp: new Date(event.timestamp).toISOString(),
    };

    const allowedTools =
      rule.allowedTools && rule.allowedTools.length > 0 ? rule.allowedTools : preset.defaultAllowedTools;

    const configOverrides = {
      ...preset.configOverrides,
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
    };

    const parentContext = {
      userId: event.userId,
      groupId: event.groupId,
      messageType: 'group' as const,
      protocol: event.protocol,
    };

    logger.info(
      `[SubAgentTriggerHandler] Spawning "${rule.presetKey}" subagent for rule ${ruleIndex} | group=${groupId} → target=${targetGroupId}`,
    );

    void (async () => {
      const syntheticContext = this.buildSyntheticContext(targetGroupIdNum);

      // Step 1: send notification and register cancellation handle
      const notifyResult = await this.sendNotification(targetGroupIdNum, preset.displayName, syntheticContext);
      const trackingKey = notifyResult?.message_seq ?? notifyResult?.message_id;

      const cancelled = { value: false };
      if (trackingKey != null) {
        this.pendingAgents.set(trackingKey, () => {
          cancelled.value = true;
        });
      }

      try {
        // Step 2: run subagent
        const result = await this.aiService.runSubAgent(
          preset.type,
          { description, input: taskInput, parentContext },
          configOverrides,
        );

        // Step 3: deliver result (skip if cancelled via reaction)
        if (cancelled.value) {
          logger.info(
            `[SubAgentTriggerHandler] Rule ${ruleIndex} ("${rule.presetKey}") result discarded — cancelled by user`,
          );
          return;
        }

        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        if (!resultText.trim()) {
          logger.warn(`[SubAgentTriggerHandler] Rule ${ruleIndex} ("${rule.presetKey}") returned empty result`);
          return;
        }

        await this.sendResult(targetGroupIdNum, resultText, syntheticContext);
      } catch (err) {
        if (!cancelled.value) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error(
            `[SubAgentTriggerHandler] Rule ${ruleIndex} ("${rule.presetKey}") failed | group=${groupId}:`,
            error,
          );
        }
      } finally {
        if (trackingKey != null) {
          this.pendingAgents.delete(trackingKey);
        }
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Result delivery
  // ---------------------------------------------------------------------------

  /**
   * Deliver the subagent result to the target group.
   *
   * Decision order:
   *   1. Card rendering — if result is long enough and provider supports it, convert to card image.
   *   2. Forward vs direct:
   *      - Card image segments: always sent directly (images in forward messages are unreliable).
   *      - Plain text: use forward (合并转发) when group has useForwardMsg enabled and protocol is Milky.
   *        This prevents long bot outputs from flooding the chat.
   */
  private async sendResult(
    groupId: number | string,
    resultText: string,
    syntheticContext: NormalizedMessageEvent,
  ): Promise<void> {
    const groupIdStr = groupId.toString();

    try {
      const skipCard = hasSkipCardMarker(resultText);
      const cleanText = skipCard ? stripSkipCardMarker(resultText) : resultText;

      const cardResult = skipCard ? null : await this.aiService.processReplyMaybeCard(cleanText, groupIdStr);
      const isCard = cardResult !== null;
      const segments = cardResult ? cardResult.segments : new MessageBuilder().text(cleanText).build();

      const useForward =
        !isCard &&
        !skipCard &&
        this.protocol === 'milky' &&
        this.botSelfId > 0 &&
        (await this.conversationConfigService.getUseForwardMsg(groupIdStr, 'group'));

      if (useForward) {
        await this.messageAPI.sendForwardFromContext([{ segments, senderName: 'Bot' }], syntheticContext, 15_000, {
          botUserId: this.botSelfId,
        });
        logger.info(`[SubAgentTriggerHandler] Result delivered to group ${groupId} (forward)`);
      } else {
        await this.messageAPI.sendFromContext(segments, syntheticContext, 15_000);
        logger.info(`[SubAgentTriggerHandler] Result delivered to group ${groupId} (${isCard ? 'card' : 'text'})`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[SubAgentTriggerHandler] Failed to deliver result to group ${groupId}:`, error);
    }
  }
}
