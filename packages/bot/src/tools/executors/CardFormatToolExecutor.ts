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
      description: `卡片数组。每项 = 一个 CardData 对象。**字段必须严格按下面 schema**，多余字段或类型不符会被拒绝。一次可塞多个卡片串成一组。

可用 type：
- paragraph: { type, content }                     — 一段自然文本（多段就用多个 paragraph）
- list:      { type, title, items: string[], emoji? } — 标题 + 列表项；items 必须是字符串数组，不要嵌套对象
- steps:     { type, title, steps: string[] }       — 有序步骤；同样字符串数组
- qa:        { type, question, answer }             — 一问一答
- knowledge: { type, term, definition, examples?: string[] } — 单个术语定义；多术语用多个 knowledge 卡
- comparison:{ type, title, leftHeader, rightHeader, items: [{label, left, right}] } — 双列对比表
- stats:     { type, title, data: [{label, value, highlight?: boolean}] } — 数据展示
- highlight: { type, title, summary, detail? }      — 单条结论 / 重点
- quote:     { type, text, source? }                — 引用
- info:      { type, title, content, level: 'info'|'warning'|'success'|'tip' } — 提示框
- markdown:  { type, content, title? }              — 直接写 GFM markdown（heading/list/table/code/quote 都支持），系统会原样渲染。**当结构复杂、上述 type 套不进去时用 markdown 兜底**

组合示例：
- 概念科普 → [knowledge] 或 [paragraph, list]
- 怎么做 → [steps] 或 [paragraph, steps]
- 多角度讲解 → [paragraph, list, highlight] 一组
- 临时拿不准 type → [markdown] 一卡解决`,
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
      // Stamp the card with whoever is actually generating this turn (set by
      // GenerationStage). Without this the card defaults to the global
      // default LLM provider — wrong footer when the active provider was
      // overridden (e.g. `claude:` prefix → anthropic).
      const activeProvider = context.hookContext?.metadata.get('activeProvider');
      const result = await cardHelper.renderParsedCards(validated, activeProvider);
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
