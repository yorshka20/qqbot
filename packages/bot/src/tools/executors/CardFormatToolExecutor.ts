import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { DITokens } from '@/core/DITokens';
import { getCardDeckNoteForPrompt, getCardTypeSpecForPrompt } from '@/services/card/cardPromptSpec';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'format_as_card',
  visibility: ['reply'],
  description:
    '获取卡片排版模板。仅当回复正文预计超过 150 字且包含结构化内容（列表、对比、步骤、数据等），或内容明显需要分层展示时调用。调用后以卡片 JSON 数组格式输出最终回复。日常闲聊、简单问答、不足 150 字的回复不得调用。',
  executor: 'format_as_card',
  parameters: {},
})
@injectable()
export class CardFormatToolExecutor extends BaseToolExecutor {
  name = 'format_as_card';

  constructor(@inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager) {
    super();
  }

  execute(_task: ToolCall, context: ToolExecutionContext): ToolResult {
    context.hookContext?.metadata.set('usedCardFormat', true);

    const result = this.promptManager.render('llm.card_format_tool_result', {
      cardTypeSpec: getCardTypeSpecForPrompt(),
      cardDeckNote: getCardDeckNoteForPrompt(),
    });

    return this.success(result);
  }
}
