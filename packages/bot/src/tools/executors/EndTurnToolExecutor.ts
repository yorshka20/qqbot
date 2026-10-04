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
// It belongs in the same round as the turn's last content: a round spent on end_turn
// alone re-sends the whole conversation for nothing.
@Tool({
  name: END_TURN_TOOL_NAME,
  description:
    '结束本次回复。本次回复只有调用它才会结束，并且总是和最后的内容放在同一轮：最终文本写完时在同一轮调用它（同一轮的文字作为最终回复发出）；最后一步是 send_card / speak / react 时，和它们在同一轮一起调用。只有还要等工具结果的那一轮不要调用它。调用后本次回复立即结束；同一轮有工具调用失败时它不会生效，你会看到失败结果再处理。',
  executor: 'end_turn',
  visibility: {
    reply: { sources: ['qq-private', 'qq-group', 'discord'] },
  },
  parameters: {},
  whenToUse:
    '每次回复都以它结束，它是"我说完了"的明确信号。不要为它单独花一轮。只写了文字却没调用它时，系统会追问你是否说完：说完就调用它，不要把写过的话再写一遍。',
  examples: [
    '写完最终回复 → 最终文本 + end_turn，同一轮',
    '发卡片、无需补充 → send_card + end_turn，同一轮',
    '发卡片、要补一句 → send_card + 补充文本 + end_turn，同一轮',
    '要查资料 → 这一轮只调 research；结果回来后写最终回复 + end_turn',
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
