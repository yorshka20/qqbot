import { injectable } from 'tsyringe';
import type { AIManager } from '@/ai/AIManager';
import { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import { CardRenderingService } from '@/services/card';
import { parseCardDeck } from '@/services/card/cardTypes';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'send_card',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  description:
    '以卡片图片形式发送结构化回复。调用此工具即完成发送，不需要在后续 message 输出任何内容。仅当回复同时满足以下两个条件时调用：(1) 正文预计超过 150 字，(2) 包含结构化内容（列表、步骤、对比、数据统计、多维度展示）。如果回复能用纯文本一两句表达，不要调用此工具。',
  executor: 'send_card',
  parameters: {
    cards: {
      type: 'array',
      required: true,
      description:
        '卡片数据数组。每项为一个卡片对象（type=paragraph/list/comparison/highlight/qa/steps/knowledge/stats/quote/info/image 之一），字段定义参考系统已知的 CardData schema。',
    },
  },
})
@injectable()
export class CardFormatToolExecutor extends BaseToolExecutor {
  name = 'send_card';

  private _cardHelper: CardRenderingHelper | null = null;

  constructor() {
    super();
  }

  /**
   * Lazily resolve CardRenderingHelper from DI-registered dependencies.
   * CardRenderingHelper is not itself registered in the DI container — we build it
   * from its injectable dependencies on first use (getContainer() fallback per ticket).
   */
  private getCardHelper(): CardRenderingHelper {
    if (!this._cardHelper) {
      const container = getContainer();
      const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
      const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
      const hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
      this._cardHelper = new CardRenderingHelper(
        new CardRenderingService(aiManager),
        llmService,
        promptManager,
        hookManager,
      );
    }
    return this._cardHelper;
  }

  async execute(task: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const cards = task.parameters?.cards;
    if (!Array.isArray(cards) || cards.length === 0) {
      const msg = 'cards 参数必须是非空数组';
      return this.error(msg, msg);
    }

    let validated: ReturnType<typeof parseCardDeck>;
    try {
      validated = parseCardDeck(JSON.stringify(cards));
    } catch (e) {
      const msg = `卡片 schema 校验失败：${(e as Error).message}`;
      return this.error(msg, msg);
    }

    try {
      const cardHelper = this.getCardHelper();
      const result = await cardHelper.renderParsedCards(validated);
      if (context.hookContext) {
        cardHelper.setCardReplyOnContext(context.hookContext, result.segments, result.textForHistory);
        context.hookContext.metadata.set('cardSent', true);
      }
      return this.success('卡片已渲染并入列发送');
    } catch (e) {
      const msg = (e as Error).message;
      logger.error(`[CardFormatToolExecutor] 卡片渲染失败: ${msg}`);
      if (context.hookContext) {
        context.hookContext.metadata.set('cardSendFailedReason', msg);
      }
      return this.error(`卡片渲染失败：${msg}`, msg);
    }
  }
}
