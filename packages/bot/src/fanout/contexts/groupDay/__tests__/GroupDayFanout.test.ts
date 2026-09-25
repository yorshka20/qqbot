// The group_day prefix is shared by the report, the comic and memory extraction, and the
// provider cache compares it byte for byte. These tests render it through the real
// templates and pin its shape: the line format, the 200-character cut, no bot replies,
// and every task suffix appended after it rather than woven into it.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage } from '@/ai/types';
import type {
  ConversationHistoryService,
  ConversationMessageEntry,
} from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import type { HookManager } from '@/hooks/HookManager';
import { MemoryExtractService } from '@/memory/MemoryExtractService';
import type { MemoryService } from '@/memory/MemoryService';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { ComicTask } from '@/plugins/plugins/GroupReportPlugin/comicTask';
import { KeywordMinesTask } from '@/plugins/plugins/GroupReportPlugin/keywordMines';
import type { ToolManager } from '@/tools/ToolManager';
import { getRepoRoot } from '@/utils/repoRoot';
import type { FanoutTask } from '../../../core/types';
import { type GroupDayContext, GroupDayFanout, getYesterdayRange } from '../GroupDayFanout';

const promptManager = new PromptManager(join(getRepoRoot(), 'prompts'));

function entry(userId: number, nickname: string, content: string, minute: number, isBotReply = false) {
  const { start } = getYesterdayRange();
  return {
    messageId: `${userId}-${minute}`,
    userId,
    nickname,
    content,
    isBotReply,
    createdAt: new Date(start.getTime() + (9 * 60 + minute) * 60_000),
  } satisfies ConversationMessageEntry;
}

const MESSAGES: ConversationMessageEntry[] = [
  entry(10000001, '测试用户甲', '早上好', 0),
  entry(10000009, '机器人', '机器人的回复不进前缀', 1, true),
  entry(10000002, '测试用户乙', '长'.repeat(250), 2),
  entry(10000001, '测试用户甲', '晚点一起吃饭', 3),
];

function makeFanout(messages: ConversationMessageEntry[]) {
  const calls: ChatMessage[][] = [];
  const llmService = {
    generateWithTools: async (msgs: ChatMessage[]) => {
      calls.push(msgs);
      return { text: '' };
    },
  } as unknown as LLMService;
  const toolManager = {
    getTool: (name: string) => ({ name, description: name, executor: name }),
    toToolDefinitions: () => [],
  } as unknown as ToolManager;
  const history = { getMessagesInRange: async () => messages } as unknown as ConversationHistoryService;
  const config = {
    getAIConfig: () => ({ defaultProviders: { llm: 'deepseek' }, taskProviders: {} }),
  } as unknown as Config;
  const fanout = new GroupDayFanout(
    { llmService, toolManager, hookManager: {} as HookManager, promptManager, config, botSelfId: '10000009' },
    history,
  );
  return { fanout, calls };
}

function captureTask(name: string, suffix: string, seen: GroupDayContext[]): FanoutTask<GroupDayContext> {
  return {
    name,
    tools: [],
    limits: { maxTokens: 100, timeout: 1000, maxToolRounds: 1 },
    parseParams: () => null,
    suffix: () => suffix,
    handle: async (_output, run) => {
      seen.push(run.ctx);
    },
  };
}

const TARGET = { chat: 'group' as const, id: '20000001', name: '测试群', protocol: 'milky' as const };

describe('group_day prefix', () => {
  it('renders the day through context.txt with one line per user message', async () => {
    const { fanout, calls } = makeFanout(MESSAGES);
    const seen: GroupDayContext[] = [];
    fanout.registerTask(captureTask('probe', '## 任务', seen));

    await fanout.run(TARGET, { probe: {} });

    const user = String(calls[0][1].content);
    const prefix = user.slice(0, user.lastIndexOf('\n\n## 任务'));
    expect(prefix.startsWith('**当前群名称**: 测试群\n')).toBe(true);
    expect(prefix).toContain(`**日期**: ${getYesterdayRange().date}`);
    expect(prefix).toContain('- 总消息数: 3');
    expect(prefix).toContain('- 测试用户甲(10000001): 2条消息');
    expect(prefix).toMatch(/^\[\d{2}:\d{2}\] 测试用户甲\(10000001\): 早上好$/m);
    expect(prefix).toMatch(new RegExp(`^\\[\\d{2}:\\d{2}\\] 测试用户乙\\(10000002\\): ${'长'.repeat(200)}\\.\\.\\.$`, 'm'));
    expect(prefix).not.toContain('机器人的回复');
    expect(prefix.endsWith('晚点一起吃饭')).toBe(true);

    expect(seen[0].stats.totalMessages).toBe(3);
    expect(seen[0].userMessages).toHaveLength(3);
  });

  it('gives the report, comic, mines and memory tasks the same prefix and appends each task after it', async () => {
    const { fanout, calls } = makeFanout(MESSAGES);
    const memorySuffix = new MemoryExtractService(
      promptManager,
      {} as LLMService,
      {} as MemoryService,
      {} as DatabaseManager,
      {} as Config,
    ).renderPrefixedExtractTask();
    const comicSuffix = new ComicTask({
      promptManager,
      messageAPI: {} as never,
      historyService: {} as never,
      botSelfId: '10000009',
    }).suffix({} as never, { presets: ['preset-a'] });
    const minesSuffix = new KeywordMinesTask({
      promptManager,
      agendaService: {} as never,
      botSelfId: '10000009',
    }).suffix({} as never, { count: 3 });
    const seen: GroupDayContext[] = [];
    fanout.registerTask(captureTask('comic', comicSuffix, seen));
    fanout.registerTask(captureTask('memory', memorySuffix, seen));
    fanout.registerTask(captureTask('mines', minesSuffix, seen));
    fanout.registerTask(captureTask('report', promptManager.render('fanout.group_day.tasks.report'), seen));

    await fanout.run(TARGET, { comic: {}, memory: {}, mines: {}, report: {} });

    const users = calls.map((c) => String(c[1].content));
    const prefix = users[0].slice(0, users[0].indexOf('\n\n## 你的任务'));
    for (const user of users) {
      expect(user.startsWith(`${prefix}\n\n## 你的任务`)).toBe(true);
    }
    expect(new Set(calls.map((c) => c[0].content)).size).toBe(1);
    expect(prefix).not.toContain('generate_image');
    expect(users[0]).toContain('generate_image');
    expect(users[1]).toContain('group_facts');
    expect(users[1]).toContain('昵称(userId)');
    expect(users[1]).not.toContain('{{');
    expect(users[2]).toContain('"mines"');
    expect(users[2]).not.toContain('{{');
    expect(users[3]).toContain('"totalSummary"');
    expect(users[3]).not.toContain('render_group_report');
  });

  it('skips the run on a day with no user messages', async () => {
    const { fanout, calls } = makeFanout([entry(10000009, '机器人', '只有机器人说话', 0, true)]);
    fanout.registerTask(captureTask('probe', '## 任务', []));

    expect(await fanout.run(TARGET, { probe: {} })).toEqual({ status: 'no_context' });
    expect(calls).toHaveLength(0);
  });
});
