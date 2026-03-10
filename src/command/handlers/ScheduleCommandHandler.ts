// ScheduleCommandHandler - add a new agenda task via natural language
//
// Usage: /schedule <自然语言描述>
// Example: /schedule 每天下午四点回报当日天气
//
// Flow:
//   1. User provides natural language task description
//   2. LLM parses it into structured fields (name, trigger, cooldown, intent)
//   3. Validated trigger string is written to schedule.md via appendItem()
//   4. AgendaItem is created in DB and scheduled immediately

import { inject, injectable } from 'tsyringe';
import { z } from 'zod';
import type { AgendaService } from '@/agenda/AgendaService';
import type { ScheduleFileService } from '@/agenda/ScheduleFileService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { JSON_ONLY_STRATEGIES, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

// ─── LLM output schema ───────────────────────────────────────────────────────

const ScheduleParseSchema = z.object({
  /** Short human-readable task name (5-20 chars) */
  name: z.string().min(1).max(50),
  /**
   * Trigger string in schedule.md format:
   *   "cron 0 16 * * *"
   *   "once 2026-06-01T08:00:00"
   *   "onEvent group_member_join"
   */
  trigger: z.string().min(4),
  /**
   * Cooldown duration string (e.g. "23h", "30s", "5min") or omit for default.
   * For cron items a safe default is just under the cron period (e.g. "23h" for daily cron).
   */
  cooldown: z.string().optional(),
  /** Full intent description — what the bot should do when triggered */
  intent: z.string().min(1),
});

type ScheduleParsed = z.infer<typeof ScheduleParseSchema>;

// ─── Command handler ─────────────────────────────────────────────────────────

@Command({
  name: 'schedule',
  description: '用自然语言添加一个定时任务到日程',
  usage: '/schedule <任务描述>  例: /schedule 每天下午四点播报当日天气',
  permissions: ['admin', 'owner'],
  aliases: ['日程'],
})
@injectable()
export class ScheduleCommand implements CommandHandler {
  name = 'schedule';
  description = '用自然语言添加一个定时任务到日程';
  usage = '/schedule <任务描述>  例: /schedule 每天下午四点播报当日天气';

  constructor(
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.AGENDA_SERVICE) private agendaService: AgendaService,
    @inject(DITokens.SCHEDULE_FILE_SERVICE) private scheduleFileService: ScheduleFileService,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const input = args.join(' ').trim();
    if (!input) {
      return {
        success: false,
        error: '请描述要添加的任务，例如：/schedule 每天下午四点播报当日天气',
      };
    }

    const groupId = context.groupId?.toString();
    const userId = context.userId.toString();
    if (!groupId || !userId) {
      return {
        success: false,
        error: '无法获取群组ID或用户ID',
      };
    }

    // Parse natural language description with LLM
    let parsed: ScheduleParsed | null = null;
    try {
      parsed = await this.parseWithLLM(input, groupId);
    } catch (err) {
      logger.error('[ScheduleCommand] LLM parse failed:', err);
    }

    if (!parsed) {
      return {
        success: false,
        error: '无法解析任务描述，请尝试更清晰的表达。例：/schedule 每天早上8点发送早安问候',
      };
    }

    // Validate the trigger string using ScheduleFileService
    const trigger = this.scheduleFileService.parseTrigger(parsed.trigger, parsed.name);
    if (!trigger) {
      return {
        success: false,
        error: `无法解析触发方式："${parsed.trigger}"，请检查格式后重试。`,
      };
    }

    const cooldownMs = parsed.cooldown ? this.scheduleFileService.parseDuration(parsed.cooldown) : 60_000;

    try {
      const isOnce = trigger.triggerType === 'once';

      if (!isOnce) {
        // 1. Append to schedule.md (cron/onEvent only; once items are DB-only)
        await this.scheduleFileService.appendItem({
          name: parsed.name,
          triggerType: trigger.triggerType,
          cronExpr: trigger.cronExpr,
          triggerAt: trigger.triggerAt,
          eventType: trigger.eventType,
          groupId,
          cooldownMs,
          intent: parsed.intent,
        });
      }

      // 2. Create in DB and schedule immediately
      const item = await this.agendaService.createItem({
        name: parsed.name,
        triggerType: trigger.triggerType,
        cronExpr: trigger.cronExpr,
        triggerAt: trigger.triggerAt,
        eventType: trigger.eventType,
        groupId,
        userId,
        intent: parsed.intent,
        cooldownMs,
        maxSteps: 3,
        enabled: true,
        metadata: isOnce ? undefined : JSON.stringify({ source: 'file' }),
      });

      const mb = new MessageBuilder();
      mb.text(
        [
          `✅ 已添加日程任务「${item.name}」`,
          `触发: ${parsed.trigger}`,
          `意图: ${parsed.intent}`,
          parsed.cooldown ? `冷却: ${parsed.cooldown}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return { success: true, segments: mb.build() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ScheduleCommand] Failed to create agenda item:', err);
      return { success: false, error: `创建任务失败: ${msg}` };
    }
  }

  // ─── LLM Parsing ─────────────────────────────────────────────────────────────

  private async parseWithLLM(input: string, groupId: string): Promise<ScheduleParsed | null> {
    const today = new Date().toISOString();

    const prompt = this.promptManager.render('agenda.schedule_parse', {
      today,
      input,
      groupIdLine: `当前群ID: ${groupId}`,
    });

    const response = await this.llmService.generateLite(prompt, { maxTokens: 512, jsonMode: true }, 'deepseek');
    if (!response.text) return null;

    return parseLlmJson(response.text, ScheduleParseSchema, { strategies: JSON_ONLY_STRATEGIES });
  }
}
