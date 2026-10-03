import { injectable } from 'tsyringe';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

export const END_TURN_TOOL_NAME = 'end_turn';

// A loop that offers this tool ends only through it (LLMService.generateWithTools).
// "Emit text and no tool call" cannot be the exit: a heads-up the model failed to
// follow with its tool call is indistinguishable from a final reply, so such a round
// is followed by a question instead. The tool is also a non-content exit: after
// send_card / send_message the model ends without emitting throwaway text.
@Tool({
  name: END_TURN_TOOL_NAME,
  description:
    '结束本次回复。本次回复只有调用它才会结束：最终文本写完时，在同一轮调用它（同一轮的文字作为最终回复发出）；已用 send_card / send_message 把该说的都发出去、没有要补充的话时，单独调用它。调用后本次回复立即结束。',
  executor: 'end_turn',
  visibility: {
    reply: { sources: ['qq-private', 'qq-group', 'discord'] },
  },
  parameters: {},
  whenToUse:
    '每次回复都以它结束，它是"我说完了"的明确信号。只写了文字却没调用它时，系统会追问你是否说完：说完就调用它，不要把写过的话再写一遍。',
  examples: [
    '写完最终回复 → 同一轮调用 end_turn',
    'send_card 发出卡片后无需补充说明 → 调用 end_turn 结束',
    '已用 send_message 发完全部内容 → 调用 end_turn 结束',
  ],
})
@injectable()
export class EndTurnToolExecutor extends BaseToolExecutor {
  name = END_TURN_TOOL_NAME;

  execute(_call: ToolCall, _context: ToolExecutionContext): ToolResult {
    return {
      success: true,
      reply: '本次回复已结束。',
      endTurn: true,
    };
  }
}
