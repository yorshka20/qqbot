import { injectable } from 'tsyringe';
import type { AIManager } from '@/ai/AIManager';
import { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
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
    '把回复渲染成卡片图片发送。**任何**带可视化结构（列表、步骤、对比、问答、数据、知识点、引用、多段落讲解）的回复都应优先用它——卡片让信息一眼可读，远胜纯文本堆砌或一长串句子。调用此工具即完成发送，不要在后续 message 再输出内容。',
  whenToUse:
    '回复包含以下任一信号时调用：(a) 两条以上的列表/要点/步骤；(b) 概念解释、知识科普、教程；(c) 多维度对比；(d) 问答形式；(e) 引用 + 自己的话；(f) 任何"如果用纯文本，读者要费力扫描"的内容。不需要凑字数——3 条要点也值得卡片。**不**适合的只有：单句寒暄、口语化短回应、命令调用、一两句话能说完的简单事实。',
  examples: [
    '解释一个技术概念（含 2-3 段说明 + 关键点列表）→ paragraph + list',
    '对比两个方案 → comparison',
    '回答"怎么做" → steps',
    '科普一个梗/术语 → knowledge 或 qa',
  ],
  executor: 'send_card',
  parameters: {
    cards: {
      type: 'array',
      required: true,
      items: { type: 'object' },
      description:
        '卡片数据数组。每项为一个卡片对象（type=paragraph/list/comparison/highlight/qa/steps/knowledge/stats/quote/info/image 之一），字段定义参考系统已知的 CardData schema。',
    },
  },
})
@injectable()
export class CardFormatToolExecutor extends BaseToolExecutor {
  name = 'send_card';

  private _cardHelper: CardRenderingHelper | null = null;

  /**
   * Lazily resolve CardRenderingHelper from DI-registered dependencies.
   * CardRenderingHelper is not itself registered in the DI container — we build it
   * from its injectable dependencies on first use (getContainer() fallback per ticket).
   */
  private getCardHelper(): CardRenderingHelper {
    if (!this._cardHelper) {
      const container = getContainer();
      const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
      const hookManager = container.resolve<HookManager>(DITokens.HOOK_MANAGER);
      this._cardHelper = new CardRenderingHelper(new CardRenderingService(aiManager), hookManager);
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
