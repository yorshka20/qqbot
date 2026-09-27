import { inject, injectable } from 'tsyringe';
import { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import { CARD_DECK_DESCRIPTION, CARD_ITEM_SCHEMA, parseCardDeck } from '@/services/card/cardTypes';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'send_card',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  description:
    '把回复渲染成卡片图片发送。**任何**带可视化结构（列表、步骤、对比、问答、数据、知识点、引用、多段落讲解）的回复都应优先用它——卡片让信息一眼可读，远胜纯文本堆砌或一长串句子。调用后卡片即进入发送队列；之后若无需补充，调用 end_turn 结束本次回复；若需要补充说明，直接输出文本（会作为卡片后的追加消息发送）。',
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
      // Full discriminated-union schema (one object shape per card type, each
      // with its own required fields). A partial schema that constrains only the
      // `type` discriminator makes content fields ungrammatical under constrained
      // decoding, so the model can only emit `{"type":...}` and every card fails
      // validation. See CARD_ITEM_SCHEMA.
      items: CARD_ITEM_SCHEMA,
      description: CARD_DECK_DESCRIPTION,
    },
  },
})
@injectable()
export class CardFormatToolExecutor extends BaseToolExecutor {
  name = 'send_card';

  constructor(@inject(CardRenderingHelper) private readonly cardHelper: CardRenderingHelper) {
    super();
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
      // Stamp the card with whoever is actually generating this turn (set by
      // GenerationStage). Without this the card defaults to the global
      // default LLM provider — wrong footer when the active provider was
      // overridden (e.g. `claude:` prefix → anthropic).
      const activeProvider = context.hookContext?.metadata.get('activeProvider');
      const activeModel = context.hookContext?.metadata.get('activeModel');
      const result = await this.cardHelper.renderParsedCards(validated, activeProvider, activeModel);
      if (context.hookContext) {
        this.cardHelper.setCardReplyOnContext(context.hookContext, result.segments, result.textForHistory);
        context.hookContext.metadata.set('cardSent', true);
      }
      return this.success(
        '卡片已渲染并进入发送队列。若无需补充内容，请调用 end_turn 结束本次回复；若还有要补充的话，直接输出文本即可（会作为卡片后的追加消息发送）。不要重复卡片里已有的内容。',
      );
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
