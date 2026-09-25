// The report card's numbers must come from the day's stats, never from the model: the
// model only supplies topics, comments and quotes. The comic must refuse to run without
// a preset it can actually draw with.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun } from '@/fanout/core/types';
import { getRepoRoot } from '@/utils/repoRoot';
import { ComicTask, resolveComicPresetIds } from '../comicTask';
import type { GroupReportRenderer } from '../GroupReportRenderer';
import { assembleReport, ReportTask } from '../reportTask';
import type { GroupReportData } from '../types';

const promptManager = new PromptManager(join(getRepoRoot(), 'prompts'));

const CTX: GroupDayContext = {
  groupId: '20000001',
  groupName: '测试群',
  date: '2026-09-24',
  userMessages: [],
  stats: {
    totalMessages: 12,
    activeMembers: 2,
    highlightTimeRange: '10:00-12:00',
    hourlyActivity: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 10 ? 12 : 0 })),
    userStats: [
      { userId: '10000001', nickname: '测试用户甲', messageCount: 8 },
      { userId: '10000002', nickname: '测试用户乙', messageCount: 4 },
    ],
  },
};

const RUN: FanoutRun<GroupDayContext> = {
  ctx: CTX,
  target: { chat: 'group', id: CTX.groupId, name: CTX.groupName, protocol: 'milky' },
};

describe('assembleReport', () => {
  it('takes every count from the stats and drops members who did not speak', () => {
    const report = assembleReport(
      {
        totalMessages: 999,
        topics: [{ title: '午饭', summary: '去哪吃' }, { summary: '没有标题' }],
        memberHighlights: [
          { userId: '10000002', nickname: '改过的名字', comment: '话不多但句句在点上', messageCount: 100 },
          { userId: '10000001', comment: '话痨担当' },
          { userId: '10000003', comment: '昨天根本没说话' },
          { userId: '10000001', comment: '重复' },
        ],
        featuredMessages: [{ userId: '10000001', nickname: '测试用户甲', content: '早上好', comment: '开场' }],
        totalSummary: '平静的一天',
      },
      CTX,
    );

    expect(report.totalMessages).toBe(12);
    expect(report.activeMembers).toBe(2);
    expect(report.hourlyActivity).toBe(CTX.stats.hourlyActivity);
    expect(report.topics).toEqual([{ title: '午饭', summary: '去哪吃' }]);
    expect(report.memberHighlights).toEqual([
      { userId: '10000001', nickname: '测试用户甲', messageCount: 8, comment: '话痨担当' },
      { userId: '10000002', nickname: '测试用户乙', messageCount: 4, comment: '话不多但句句在点上' },
    ]);
    expect(report.totalSummary).toBe('平静的一天');
  });
});

describe('ReportTask', () => {
  function makeTask(rendered: GroupReportData[]) {
    return new ReportTask({
      promptManager,
      renderer: {
        renderAndSend: async (data: GroupReportData) => {
          rendered.push(data);
        },
      } as unknown as GroupReportRenderer,
    });
  }

  it('renders the JSON the model wrote, fenced or not', async () => {
    const rendered: GroupReportData[] = [];
    const task = makeTask(rendered);

    await task.handle(
      { text: '```json\n{"topics":[{"title":"午饭","summary":"去哪吃"}],"totalSummary":"平静"}\n```', toolCalls: [] },
      RUN,
    );

    expect(rendered).toHaveLength(1);
    expect(rendered[0].topics[0].title).toBe('午饭');
    expect(rendered[0].totalMessages).toBe(12);
  });

  it('fails the task instead of posting an empty card when there is no JSON', async () => {
    const rendered: GroupReportData[] = [];
    await expect(makeTask(rendered).handle({ text: '抱歉', toolCalls: [] }, RUN)).rejects.toThrow(/no JSON/);
    expect(rendered).toHaveLength(0);
  });
});

describe('ComicTask', () => {
  const task = new ComicTask({
    promptManager,
    messageAPI: {} as never,
    historyService: {} as never,
    botSelfId: '10000009',
  });

  it('keeps known preset ids in order and drops the rest', () => {
    expect(resolveComicPresetIds(['deepseek-q', 'missing', ' deepseek-anime ', 'deepseek-q'])).toEqual([
      'deepseek-q',
      'deepseek-anime',
    ]);
  });

  it('rejects params with no usable preset, so the run skips the comic', () => {
    expect(() => task.parseParams({ presets: ['missing'] })).toThrow(/preset/);
    expect(task.parseParams({ presets: ['deepseek-q'] })).toEqual({ presets: ['deepseek-q'] });
  });

  it('posts no caption when no image was drawn', async () => {
    await task.handle({ text: '一句配文', toolCalls: [] }, RUN);
  });
});
