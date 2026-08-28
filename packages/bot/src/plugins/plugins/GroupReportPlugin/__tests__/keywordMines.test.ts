import { describe, expect, it } from 'bun:test';
import type { AgendaService } from '@/agenda/AgendaService';
import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import { type PlantKeywordMinesParams, plantKeywordMines } from '../keywordMines';
import type { GroupReportData } from '../types';

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

const REPORT: GroupReportData = {
  groupName: '测试群',
  groupId: '30001',
  date: '2026-08-27',
  totalMessages: 3,
  activeMembers: 1,
  highlightTimeRange: '10:00-12:00',
  hourlyActivity: [],
  topics: [{ title: '基建吐槽', summary: '大家吐槽赤铜难造' }],
  memberHighlights: [],
  featuredMessages: [],
  totalSummary: '昨天在聊基建',
};

function buildParams(
  mines: Array<{ keyword: string; prompt: string }>,
  messages: ConversationMessageEntry[],
  count: number,
): { params: PlantKeywordMinesParams; created: Array<{ keywords?: string[] }> } {
  const created: Array<{ keywords?: string[] }> = [];
  const agendaService = {
    createLlmItem: async (request: { keywords?: string[] }) => {
      created.push(request);
      return { ok: true as const, item: { id: `item-${created.length}` } };
    },
  } as unknown as AgendaService;

  return {
    created,
    params: {
      agendaService,
      llmService: {
        generate: async () => ({ text: JSON.stringify({ mines }) }),
      } as unknown as PlantKeywordMinesParams['llmService'],
      promptManager: {
        render: () => 'rendered prompt',
      } as unknown as PlantKeywordMinesParams['promptManager'],
      groupId: '30001',
      userId: '20001',
      groupName: '测试群',
      date: '2026-08-27',
      report: REPORT,
      messages,
      count,
    },
  };
}

describe('plantKeywordMines', () => {
  it('drops keywords nobody actually typed and falls through to the next candidate', async () => {
    const { params, created } = buildParams(
      [
        { keyword: '赤铜装备基建', prompt: '概括出来的词组，昨天没人这样打过' },
        { keyword: '赤铜', prompt: '昨天在吐槽赤铜难造' },
      ],
      [makeMessage('赤铜装备造起来好麻烦哦')],
      1,
    );

    const planted = await plantKeywordMines(params);

    expect(planted).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].keywords).toEqual(['赤铜']);
  });

  it('ignores keywords that only appear inside machine tokens, matching the trigger', async () => {
    const { params, created } = buildParams(
      [{ keyword: '动画表情', prompt: '只出现在图片占位符里' }],
      [makeMessage('[Image:[动画表情]]')],
      1,
    );

    expect(await plantKeywordMines(params)).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('never plants more than the requested count, and skips duplicates', async () => {
    const { params, created } = buildParams(
      [
        { keyword: '赤铜', prompt: 'a' },
        { keyword: '赤铜', prompt: 'b' },
        { keyword: '基建', prompt: 'c' },
        { keyword: '水管', prompt: 'd' },
      ],
      [makeMessage('赤铜'), makeMessage('基建劝退'), makeMessage('拉水管')],
      2,
    );

    expect(await plantKeywordMines(params)).toBe(2);
    expect(created.map((c) => c.keywords?.[0])).toEqual(['赤铜', '基建']);
  });

  it('does not mine bot replies', async () => {
    const { params, created } = buildParams(
      [{ keyword: '赤铜', prompt: 'a' }],
      [makeMessage('赤铜的确难造', true)],
      1,
    );

    expect(await plantKeywordMines(params)).toBe(0);
    expect(created).toHaveLength(0);
  });
});
