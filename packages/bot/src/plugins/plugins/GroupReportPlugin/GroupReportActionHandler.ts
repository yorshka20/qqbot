// GroupReportActionHandler - the scheduled entry point for the group daily report,
// dispatched by agenda items with `执行: action group_report`.
//
// The plugin registers it in onEnable and drops it in onDisable, so the agenda framework
// holds no reference to a disabled plugin. The handler supplies the schedule-side context
// (which group, which identity) to runGroupReport. Keyword mines stay on that report.
// The comic is a second subagent: same system prompt and the same chat-log prefix,
// with the drawing task appended after the log.

import type { ActionHandler, ActionHandlerContext } from '@/agenda/ActionHandlerRegistry';
import type { AgendaService } from '@/agenda/AgendaService';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { drawReportComic } from './drawReportComic';
import { plantKeywordMines } from './keywordMines';
import { resolveReportProvider, runGroupReport } from './runReport';

/** Keyword mines planted after the report when `actionParams` says nothing else */
const DEFAULT_KEYWORD_MINES = 3;

/** `actionParams` accepted by this handler */
interface HandlerParams {
  /** How many keyword mines to plant from the finished report; 0 disables */
  keywordMines?: number;
  /** Image preset ids for the comic. Omit or leave empty to skip the comic. */
  comicPresets?: unknown;
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
      const { report, userMessages, date, promptPrefix } = await runGroupReport({
        groupId,
        groupName,
        userId,
        protocol: ctx.protocol,
      });

      const params = this.parseParams(ctx.item.actionParams);
      const mineCount = params.keywordMines ?? DEFAULT_KEYWORD_MINES;
      const container = getContainer();
      const providerName = resolveReportProvider();

      if (mineCount > 0 && report) {
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
          providerName,
        }).catch((err) => {
          logger.error('[GroupReportActionHandler] Keyword mine planting failed:', err);
        });
      }

      const comicPresets = readComicPresets(params.comicPresets);
      if (comicPresets.length > 0 && promptPrefix) {
        const caption = await drawReportComic({
          aiService: container.resolve<AIService>(DITokens.AI_SERVICE),
          promptManager: container.resolve<PromptManager>(DITokens.PROMPT_MANAGER),
          groupId,
          userId,
          protocol: ctx.protocol,
          promptPrefix,
          presetIds: comicPresets,
          providerName,
        }).catch((err) => {
          logger.error('[GroupReportActionHandler] Report comic failed:', err);
          return '';
        });
        // The image was sent by generate_image. This line is the agent's caption.
        if (caption) {
          return caption;
        }
      }
      // Return void — render_group_report already sent the report image to the group
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

function readComicPresets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}
