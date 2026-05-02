import { inject, injectable } from 'tsyringe';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { DITokens } from '@/core/DITokens';
import { getCardDeckNoteForPrompt, getCardTypeSpecForPrompt } from '@/services/card/cardPromptSpec';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'format_as_card',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  description:
    '调用此工具表示你接下来的回复将以 card JSON 数组格式输出（首字符必须是 `[`，末字符必须是 `]`，不得包含任何纯文本前后缀、说明文字或代码块标记）。仅当回复同时满足以下两个条件时调用：(1) 正文预计超过 150 字，(2) 包含结构化内容（列表、步骤、对比、数据统计、多维度展示）。如果回复能用纯文本一句话或几句话表达，不要调用此工具——日常闲聊、简单问答、翻译、改写、不足 150 字的结论一律走纯文本。',
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
