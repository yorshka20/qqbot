import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { LLMService } from '@/ai/services/LLMService';
import type { FunctionCall, ToolUseGenerateOptions, ToolUseGenerateResponse } from '@/ai/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationConfigService } from '@/conversation/ConversationConfigService';
import { ConversationMessageSender } from '@/conversation/ConversationMessageSender';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { HookManager } from '@/hooks/HookManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { END_TURN_TOOL_NAME } from '@/tools/executors/EndTurnToolExecutor';
import type { ToolManager } from '@/tools/ToolManager';
import { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { GenerationStage } from '../GenerationStage';

interface Round {
  text: string;
  calls: FunctionCall[];
}

/** Runs the stage against an LLM loop that reports `rounds` as tool rounds, then returns `final`. */
async function runStage(rounds: Round[], final: ToolUseGenerateResponse) {
  const sent: MessageSegment[][] = [];
  const history: string[] = [];
  const llmService = {
    generateWithTools: async (_messages: unknown, _tools: unknown, options: ToolUseGenerateOptions) => {
      for (const round of rounds) {
        await options.onToolRoundText?.(round.text, round.calls);
      }
      return final;
    },
  } as unknown as LLMService;
  const sender = new ConversationMessageSender(
    {
      sendFromContext: async (segments: MessageSegment[]) => {
        sent.push(segments);
        return { message_seq: 7 };
      },
    } as unknown as MessageAPI,
    {
      appendBotMessageToSession: async (_session: unknown, content: string) => {
        history.push(content);
      },
    } as unknown as ConversationHistoryService,
  );
  const stage = new GenerationStage(
    llmService,
    {} as ToolManager,
    {} as HookManager,
    {} as MessageAPI,
    {} as ConversationConfigService,
    sender,
  );

  const hookContext = {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: 0,
      protocol: 'milky',
      messageType: 'group',
      userId: 10000001,
      groupId: 10000002,
      message: '',
      segments: [],
    },
    metadata: new HookMetadataMap(),
  } as unknown as HookContext;
  const ctx = new ReplyPipelineContext(hookContext, new Map());
  ctx.genOptions = { temperature: 0.7, sessionId: 'group:10000002', reasoningEffort: 'medium', maxToolRounds: 15 };

  await stage.execute(ctx);
  return { sent, history, ctx };
}

const research: FunctionCall = { name: 'research', arguments: '{}' };
const endTurn: FunctionCall = { name: END_TURN_TOOL_NAME, arguments: '{}' };

describe('GenerationStage tool-round text', () => {
  it('sends the text written alongside a tool call and records it in history', async () => {
    const { sent, history, ctx } = await runStage([{ text: '稍等，我查一下[表情:笑哭]', calls: [research] }], {
      text: '查到了',
      stopReason: 'end_turn',
    });

    expect(sent).toEqual([[{ type: 'text', data: { text: '稍等，我查一下' } }, { type: 'face', data: { id: '182' } }]]);
    expect(history).toEqual(['稍等，我查一下[表情:笑哭]']);
    expect(ctx.responseText).toBe('查到了');
  });

  it('leaves the text of a round that calls end_turn to the final reply', async () => {
    const { sent, ctx } = await runStage([{ text: '顺一句：别当定论', calls: [endTurn] }], {
      text: '顺一句：别当定论',
      stopReason: 'end_turn_tool',
    });

    expect(sent).toEqual([]);
    expect(ctx.responseText).toBe('顺一句：别当定论');
    expect(ctx.endTurnRequested).toBe(true);
  });

  it('strips leaked tool-call markup before sending', async () => {
    const { sent } = await runStage(
      [{ text: '稍等<tool_call>{"name":"research"}</tool_call>', calls: [research] }],
      { text: '好了', stopReason: 'end_turn' },
    );

    expect(sent).toEqual([[{ type: 'text', data: { text: '稍等' } }]]);
  });
});
