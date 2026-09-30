import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { ConversationMessageSender } from '@/conversation/ConversationMessageSender';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import { HookMetadataMap } from '@/hooks/metadata';
import type { MessageSegment } from '@/message/types';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { SKIP_CARD_MARKER, SKIP_FORWARD_MARKER } from '@/utils/contentMarkers';
import { SendMessageToolExecutor } from '../SendMessageToolExecutor';

function setup() {
  const sent: MessageSegment[][] = [];
  const history: string[] = [];
  const executor = new SendMessageToolExecutor(
    { getAgendaLlmLimits: () => ({ maxSendsPerRun: 3 }) } as Config,
    new ConversationMessageSender(
      {
        sendFromContext: async (segments: MessageSegment[]) => {
          sent.push(segments);
          return { message_seq: 42 };
        },
      } as unknown as MessageAPI,
      {
        appendBotMessageToSession: async (_session: unknown, content: string) => {
          history.push(content);
        },
      } as unknown as ConversationHistoryService,
    ),
  );
  const metadata = new HookMetadataMap();
  const context = {
    hookContext: {
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
      metadata,
    },
  } as unknown as ToolExecutionContext;
  const call = (content: string): ToolCall => ({
    type: 'send_message',
    executor: 'send_message',
    parameters: { content },
  });
  return { executor, context, call, sent, history, metadata };
}

describe('send_message QQ faces', () => {
  it('sends face segments and persists the same message in canonical text form', async () => {
    const { executor, context, call, sent, history, metadata } = setup();

    const result = await executor.execute(call('确实[表情:笑哭]'), context);

    expect(result.success).toBe(true);
    expect(sent).toEqual([[{ type: 'text', data: { text: '确实' } }, { type: 'face', data: { id: '182' } }]]);
    expect(history).toEqual(['确实[表情:笑哭]']);
    expect(metadata.get('sendMessageCount')).toBe(1);
  });

  it('accepts a fullwidth colon and persists the canonical marker', async () => {
    const { executor, context, call, sent, history } = setup();

    const result = await executor.execute(call('确实[表情：笑哭]'), context);

    expect(result.success).toBe(true);
    expect(sent).toEqual([[{ type: 'text', data: { text: '确实' } }, { type: 'face', data: { id: '182' } }]]);
    expect(history).toEqual(['确实[表情:笑哭]']);
  });

  it('drops unknown markers from delivery and history', async () => {
    const { executor, context, call, sent, history } = setup();

    const result = await executor.execute(call('好耶[表情:开心到起飞]'), context);

    expect(result.success).toBe(true);
    expect(sent).toEqual([[{ type: 'text', data: { text: '好耶' } }]]);
    expect(history).toEqual(['好耶']);
  });

  it('drops delivery markers from delivery and history', async () => {
    const { executor, context, call, sent, history } = setup();

    const result = await executor.execute(call(`稍等 ${SKIP_CARD_MARKER}${SKIP_FORWARD_MARKER}`), context);

    expect(result.success).toBe(true);
    expect(sent).toEqual([[{ type: 'text', data: { text: '稍等' } }]]);
    expect(history).toEqual(['稍等']);
  });

  it('does not send a message reduced to an unknown marker', async () => {
    const { executor, context, call, sent, history, metadata } = setup();

    const result = await executor.execute(call('[表情:开心到起飞]'), context);

    expect(result.success).toBe(false);
    expect(sent).toEqual([]);
    expect(history).toEqual([]);
    expect(metadata.get('sendMessageCount')).toBeUndefined();
  });
});
