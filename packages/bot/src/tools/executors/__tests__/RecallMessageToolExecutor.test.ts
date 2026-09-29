import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type {
  ConversationHistoryService,
  ConversationMessageEntry,
} from '@/conversation/history/ConversationHistoryService';
import { HookMetadataMap } from '@/hooks/metadata';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { RECALL_LOOKBACK_MESSAGES, RecallMessageToolExecutor } from '../RecallMessageToolExecutor';

function entry(messageSeq: number, content: string, isBotReply: boolean, extra: Partial<ConversationMessageEntry> = {}) {
  return {
    messageId: `m${messageSeq}`,
    messageSeq,
    userId: isBotReply ? 10000009 : 10000001,
    content,
    isBotReply,
    createdAt: new Date(Date.UTC(2026, 8, 29, 10, messageSeq % 60)),
    ...extra,
  } satisfies ConversationMessageEntry;
}

function setup(history: ConversationMessageEntry[], recall: (seq: number) => Promise<void> = async () => {}) {
  const recalled: number[] = [];
  const lookups: Array<[string, string, number | undefined]> = [];
  const executor = new RecallMessageToolExecutor(
    {
      getRecentMessagesForSession: async (sessionId: string, sessionType: string, limit?: number) => {
        lookups.push([sessionId, sessionType, limit]);
        return history;
      },
    } as unknown as ConversationHistoryService,
    {
      recallFromContext: async (seq: number) => {
        await recall(seq);
        recalled.push(seq);
      },
    } as unknown as MessageAPI,
  );
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', 'group:20000001');
  metadata.set('sessionType', 'group');
  const context = {
    hookContext: {
      message: { protocol: 'milky', messageType: 'group', groupId: 20000001, userId: 10000001 },
      metadata,
    },
  } as unknown as ToolExecutionContext;
  const call = (content: string): ToolCall => ({
    type: 'recall_message',
    executor: 'recall_message',
    parameters: { content },
  });
  return { run: (content: string) => executor.execute(call(content), context), recalled, lookups };
}

describe('recall_message', () => {
  it("recalls the bot's own message the excerpt names, ignoring whitespace", async () => {
    const { run, recalled, lookups } = setup([
      entry(1, '明天\n大概率下雨', true),
      entry(2, '明天大概率下雨吗', false),
      entry(3, '收到', true),
    ]);

    const result = await run('明天大概率 下雨');

    expect(result.success).toBe(true);
    expect(recalled).toEqual([1]);
    expect(lookups).toEqual([['group:20000001', 'group', RECALL_LOOKBACK_MESSAGES]]);
  });

  it('lists recent messages instead of guessing when nothing matches', async () => {
    const { run, recalled } = setup([entry(1, '明天大概率下雨', true), entry(2, '收到', true)]);

    const result = await run('后天');

    expect(result.success).toBe(false);
    expect(result.reply).toContain('「明天大概率下雨」');
    expect(result.reply).toContain('「收到」');
    expect(recalled).toEqual([]);
  });

  it('asks for a longer excerpt when several messages match', async () => {
    const { run, recalled } = setup([entry(1, '稍等，我查一下', true), entry(2, '稍等，我再看看', true)]);

    const result = await run('稍等');

    expect(result.success).toBe(false);
    expect(result.reply).toContain('有 2 条');
    expect(recalled).toEqual([]);
  });

  it('skips messages already recalled or stored without a sequence number', async () => {
    const { run, recalled } = setup([
      entry(1, '稍等，我查一下', true, { recalled: true }),
      entry(2, '稍等，我查一下', true, { messageSeq: undefined }),
      entry(3, '稍等，我查一下', true),
    ]);

    const result = await run('稍等，我查一下');

    expect(result.success).toBe(true);
    expect(recalled).toEqual([3]);
  });

  it('reports the protocol refusal to the model', async () => {
    const { run } = setup([entry(1, '明天大概率下雨', true)], async () => {
      throw new Error('message too old to recall');
    });

    const result = await run('明天大概率下雨');

    expect(result.success).toBe(false);
    expect(result.reply).toContain('message too old to recall');
  });
});
