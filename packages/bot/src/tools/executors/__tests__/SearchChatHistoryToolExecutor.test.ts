// A nickname is what the model actually has — a leaderboard screenshot, an @ in
// someone else's message — while a QQ number usually is not. While the sender filter
// lived in a separate tool that took only a QQ number, the model fell back to a
// keyword search on the name, which matches message *bodies*: it returned everyone
// talking *about* that person, plus substring noise (a two-letter nickname hitting
// any word containing it), and read as a real answer.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { SearchChatHistoryToolExecutor } from '../SearchChatHistoryToolExecutor';

const groupContext: ToolExecutionContext = { userId: 1, groupId: 100000001, messageType: 'group' };
const privateContext: ToolExecutionContext = { userId: 10000002, messageType: 'private' };

function call(parameters: Record<string, unknown>): ToolCall {
  return { type: 'search_chat_history', executor: 'search_chat_history', parameters };
}

type Candidate = { userId: string; displayName: string; messageCount: number };
type Query = { sessionId: string; sessionType: string; keywords?: string[]; userId?: string | number };

/** Records the query the tool built, so filter composition is observable. */
function executorWith(candidates: Candidate[]): {
  executor: SearchChatHistoryToolExecutor;
  queries: Query[];
} {
  const queries: Query[] = [];
  const history = {
    findUserIdsByDisplayName: async () => candidates,
    searchMessages: async (sessionId: string, sessionType: string, filter: Record<string, unknown>) => {
      queries.push({ sessionId, sessionType, ...filter } as Query);
      return [
        {
          messageId: 'm1',
          userId: 10000001,
          nickname: candidates[0]?.displayName,
          content: '说过的话',
          isBotReply: false,
          createdAt: new Date('2026-08-29T03:00:00Z'),
          wasAtBot: false,
        },
      ];
    },
  } as unknown as ConversationHistoryService;
  return { executor: new SearchChatHistoryToolExecutor(history), queries };
}

describe('search_chat_history filters', () => {
  it('searches by keyword alone', async () => {
    const { executor, queries } = executorWith([]);

    const result = await executor.execute(call({ keyword: '项目进度' }), groupContext);

    expect(queries[0].keywords).toEqual(['项目进度']);
    expect(queries[0].userId).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('resolves a nickname into the sender filter', async () => {
    const { executor, queries } = executorWith([
      { userId: '10000001', displayName: '测试用户甲', messageCount: 42 },
    ]);

    await executor.execute(call({ nickname: '测试用户甲' }), groupContext);

    expect(queries[0].userId).toBe('10000001');
    expect(queries[0].keywords).toBeUndefined();
  });

  it('combines sender and keyword — the query the split tools could not express', async () => {
    const { executor, queries } = executorWith([]);

    await executor.execute(call({ userId: '10000001', keyword: '显卡' }), groupContext);

    expect(queries[0].userId).toBe('10000001');
    expect(queries[0].keywords).toEqual(['显卡']);
  });

  it('prefers an explicit QQ id over a nickname given alongside it', async () => {
    const { executor, queries } = executorWith([{ userId: '999', displayName: '别人', messageCount: 1 }]);

    await executor.execute(call({ userId: '10000001', nickname: '别人' }), groupContext);

    expect(queries[0].userId).toBe('10000001');
  });

  it('asks which one rather than guessing when a nickname matches several people', async () => {
    const { executor, queries } = executorWith([
      { userId: '111', displayName: 'RPG', messageCount: 90 },
      { userId: '222', displayName: 'RPG老哥', messageCount: 3 },
    ]);

    const result = await executor.execute(call({ nickname: 'RPG' }), groupContext);

    expect(queries).toEqual([]);
    expect(result.reply).toContain('111');
    expect(result.reply).toContain('222');
  });

  it('says the name is unknown instead of returning someone else', async () => {
    const { executor, queries } = executorWith([]);

    const result = await executor.execute(call({ nickname: '查无此人' }), groupContext);

    expect(queries).toEqual([]);
    expect(result.data?.messageCount).toBe(0);
  });

  it('rejects a call with no filter at all', async () => {
    const { executor } = executorWith([]);

    const result = await executor.execute(call({ timeRange: '-3d' }), groupContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('keyword, userId or nickname');
  });

  it('reads the user session in a 1:1 chat instead of failing for want of a group', async () => {
    const { executor, queries } = executorWith([]);

    const result = await executor.execute(call({ keyword: '显卡' }), privateContext);

    expect(result.success).toBe(true);
    expect(queries[0].sessionId).toBe('user:10000002');
    expect(queries[0].sessionType).toBe('user');
  });
});
