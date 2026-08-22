import { injectable } from 'tsyringe';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

// The agentic loop's only other exit is "emit a response with no tool calls",
// i.e. speaking IS stopping. After send_card / send_message the model often has
// nothing left to say, but the API still demands a response — this tool gives
// that state an explicit, non-content exit so the model never has to emit
// throwaway text (or agonize over whether its text will be delivered).
@Tool({
  name: 'end_turn',
  description:
    '结束本次回复，不再发送任何内容。当你要说的内容已经全部发出（例如已用 send_card 发出卡片、或已用 send_message 说完），且没有需要补充的话时调用。调用后本次回复立即结束。注意：若你仍有内容想说，直接输出文本即可（输出的文本一定会被发送），不要调用本工具。',
  executor: 'end_turn',
  visibility: {
    reply: { sources: ['qq-private', 'qq-group', 'discord'] },
  },
  parameters: {},
  whenToUse:
    '仅当本次回复不需要再发送任何内容时调用（通常发生在 send_card 或 send_message 已把该说的都发出去之后）。它是"我说完了"的明确信号；与输出文本二选一——输出文本表示"这是我要发送的回复"，调用 end_turn 表示"没有更多要发送的了"。',
  examples: [
    'send_card 发出卡片后无需补充说明 → 调用 end_turn 结束',
    '已用 send_message 发完全部内容 → 调用 end_turn 结束',
  ],
})
@injectable()
export class EndTurnToolExecutor extends BaseToolExecutor {
  name = 'end_turn';

  execute(_call: ToolCall, _context: ToolExecutionContext): ToolResult {
    return {
      success: true,
      reply: '本次回复已结束。',
      endTurn: true,
    };
  }
}
