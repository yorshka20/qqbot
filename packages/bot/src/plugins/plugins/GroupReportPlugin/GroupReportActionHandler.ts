// GroupReportActionHandler - the scheduled entry point for the group daily report,
// dispatched by agenda items with `执行: action group_report`.
//
// The plugin registers it in onEnable and drops it in onDisable, so the agenda framework
// holds no reference to a disabled plugin. The handler itself only supplies the schedule-side
// context (which group, which identity) to runGroupReport and then plants keyword mines from
// the finished analysis — reading the day once and deriving both is the whole point of
// running them together (see keywordMines.ts).

import type { ActionHandler, ActionHandlerContext } from '@/agenda/ActionHandlerRegistry';
import type { AgendaService } from '@/agenda/AgendaService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { plantKeywordMines } from './keywordMines';
import { resolveReportProvider, runGroupReport } from './runReport';

/** Keyword mines planted after the report when `actionParams` says nothing else */
const DEFAULT_KEYWORD_MINES = 5;

/** `actionParams` accepted by this handler (schedule.md: `- 参数: \`{"keywordMines":5}\``) */
interface HandlerParams {
  /** How many keyword mines to plant from the finished report; 0 disables */
  keywordMines?: number;
}

export class GroupReportActionHandler implements ActionHandler {
  readonly name = 'group_report';

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    const groupId = ctx.groupId;
    if (!groupId) {
      logger.error('[GroupReportActionHandler] No groupId in context');
      return;
    }

    const groupName = `群${groupId}`;
    // Schedule items may carry no user; the bot itself owns what it plants.
    const userId = ctx.userId ?? ctx.eventContext.botSelfId;

    try {
      const { report, userMessages, date } = await runGroupReport({
        groupId,
        groupName,
        userId,
        protocol: ctx.protocol,
      });

      const mineCount = this.parseParams(ctx.item.actionParams).keywordMines ?? DEFAULT_KEYWORD_MINES;
      if (mineCount > 0 && report) {
        const container = getContainer();
        // The report image is already in the group by now, so a failure here must not
        // report the whole run as failed — mines are a best-effort follow-up.
        await plantKeywordMines({
          agendaService: container.resolve<AgendaService>(DITokens.AGENDA_SERVICE),
          llmService: container.resolve<LLMService>(DITokens.LLM_SERVICE),
          promptManager: container.resolve<PromptManager>(DITokens.PROMPT_MANAGER),
          groupId,
          userId,
          groupName,
          date,
          report,
          messages: userMessages,
          count: mineCount,
          providerName: resolveReportProvider(),
        }).catch((err) => {
          logger.error('[GroupReportActionHandler] Keyword mine planting failed:', err);
        });
      }
      // Return void — render_group_report already sent the image to the group
    } catch (err) {
      logger.error('[GroupReportActionHandler] Report generation failed:', err);
      return '❌ 群日报生成失败';
    }
  }

  private parseParams(raw?: string): HandlerParams {
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as HandlerParams;
    } catch {
      logger.warn('[GroupReportActionHandler] Failed to parse actionParams JSON');
      return {};
    }
  }
}
