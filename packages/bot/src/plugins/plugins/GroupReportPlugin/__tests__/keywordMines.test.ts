import { describe, expect, it } from 'bun:test';
import type { AgendaService } from '@/agenda/AgendaService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun } from '@/fanout/core/types';
import { KeywordMinesTask, type MineCandidate, plantMines } from '../keywordMines';

function makeMessage(content: string, isBotReply = false): ConversationMessageEntry {
  return {
    messageId: `m-${content}`,
    userId: 20001,
    nickname: 'tester',
    content,
    isBotReply,
    createdAt: new Date('2026-08-27T10:00:00Z'),
    wasAtBot: false,
  };
}

function makeAgenda(): { agendaService: AgendaService; created: Array<{ keywords?: string[] }> } {
  const created: Array<{ keywords?: string[] }> = [];
  const agendaService = {
    createLlmItem: async (request: { keywords?: string[] }) => {
      created.push(request);
      return { ok: true as const, item: { id: `item-${created.length}` } };
    },
  } as unknown as AgendaService;
  return { agendaService, created };
}

async function plant(candidates: MineCandidate[], messages: ConversationMessageEntry[], count: number) {
  const { agendaService, created } = makeAgenda();
  const planted = await plantMines({ agendaService, groupId: '30001', userId: '20001', candidates, messages, count });
  return { planted, created };
}

describe('plantMines', () => {
  it('drops keywords nobody actually typed and falls through to the next candidate', async () => {
    const { planted, created } = await plant(
      [
        { keyword: '赤铜装备基建', prompt: '概括出来的词组，昨天没人这样打过' },
        { keyword: '赤铜', prompt: '昨天在吐槽赤铜难造' },
      ],
      [makeMessage('赤铜装备造起来好麻烦哦')],
      1,
    );

    expect(planted).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].keywords).toEqual(['赤铜']);
  });

  it('ignores keywords that only appear inside machine tokens, matching the trigger', async () => {
    const { planted, created } = await plant(
      [{ keyword: '动画表情', prompt: '只出现在图片占位符里' }],
      [makeMessage('[Image:[动画表情]]')],
      1,
    );

    expect(planted).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('never plants more than the requested count, and skips duplicates', async () => {
    const { planted, created } = await plant(
      [
        { keyword: '赤铜', prompt: 'a' },
        { keyword: '赤铜', prompt: 'b' },
        { keyword: '基建', prompt: 'c' },
        { keyword: '水管', prompt: 'd' },
      ],
      [makeMessage('赤铜'), makeMessage('基建劝退'), makeMessage('拉水管')],
      2,
    );

    expect(planted).toBe(2);
    expect(created.map((c) => c.keywords?.[0])).toEqual(['赤铜', '基建']);
  });

  it('does not mine bot replies', async () => {
    const { planted, created } = await plant([{ keyword: '赤铜', prompt: 'a' }], [makeMessage('赤铜的确难造', true)], 1);

    expect(planted).toBe(0);
    expect(created).toHaveLength(0);
  });
});

describe('KeywordMinesTask', () => {
  const RUN = {
    ctx: { groupId: '30001', userMessages: [makeMessage('赤铜装备造起来好麻烦哦')] },
    target: { chat: 'group', id: '30001', name: '测试群', protocol: 'milky' },
  } as unknown as FanoutRun<GroupDayContext>;

  function makeTask() {
    const { agendaService, created } = makeAgenda();
    const task = new KeywordMinesTask({
      promptManager: { render: () => 'rendered' } as unknown as PromptManager,
      agendaService,
      botSelfId: '10000009',
    });
    return { task, created };
  }

  it('plants from the candidates the model wrote after the shared prefix', async () => {
    const { task, created } = makeTask();
    const text = JSON.stringify({ mines: [{ keyword: '赤铜', prompt: '昨天在吐槽赤铜难造' }] });

    await task.handle({ text, toolCalls: [] }, RUN, { count: 3 });

    expect(created.map((c) => c.keywords?.[0])).toEqual(['赤铜']);
  });

  it('fails the task when the model gave no candidates', async () => {
    const { task } = makeTask();
    await expect(task.handle({ text: '没有想法', toolCalls: [] }, RUN, { count: 3 })).rejects.toThrow(/candidates/);
  });

  it('defaults to three mines and rejects a count that is not positive', () => {
    const { task } = makeTask();
    expect(task.parseParams(undefined)).toEqual({ count: 3 });
    expect(task.parseParams({ count: 5 })).toEqual({ count: 5 });
    expect(() => task.parseParams({ count: 0 })).toThrow();
  });
});
