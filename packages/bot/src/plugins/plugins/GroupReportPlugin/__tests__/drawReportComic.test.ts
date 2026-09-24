import { describe, expect, it } from 'bun:test';
import { SubAgentType, type SubAgentConfig } from '@/agent/types';
import type { AIService } from '@/ai/AIService';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { drawReportComic, resolveComicPresetIds } from '../drawReportComic';
import { renderGroupChatPrefix, withTaskSuffix } from '../reportPrompt';

const PREFIX_VARS = {
  groupName: '测试群',
  date: '2026-08-27',
  totalMessages: '3',
  activeMembers: '1',
  highlightTimeRange: '10:00-12:00',
  hourlyActivityJson: '[]',
  memberStats: '- 甲(20001): 3条消息',
  chatHistory: '[10:00] 甲(20001): 赤铜又炸了',
};

describe('report and comic prompts', () => {
  it('share a prefix through the chat log and diverge at the task', () => {
    const promptManager = new PromptManager();
    const prefix = renderGroupChatPrefix(promptManager, PREFIX_VARS);
    const report = withTaskSuffix(
      prefix,
      promptManager.render('subagent.group_report.task', {
        ...PREFIX_VARS,
        message: '生成昨日群聊每日汇报',
      }),
    );
    const comic = withTaskSuffix(
      prefix,
      promptManager.render('subagent.group_report.comic', {
        presetIds: '["deepseek-q","deepseek-anime"]',
      }),
    );

    expect(report.startsWith(`${prefix}\n\n`)).toBe(true);
    expect(comic.startsWith(`${prefix}\n\n`)).toBe(true);
    expect(prefix).toContain('赤铜又炸了');
    expect(prefix).not.toContain('render_group_report');
    expect(prefix).not.toContain('generate_image');
    expect(report).toContain('render_group_report');
    expect(report).not.toContain('drawingHighlights');
    expect(comic).toContain('generate_image');
    expect(comic).toContain('每张图从中选一个');
    expect(comic.indexOf('赤铜又炸了')).toBeLessThan(comic.indexOf('generate_image'));
  });
});

describe('resolveComicPresetIds', () => {
  it('keeps known preset ids and drops the rest', () => {
    expect(resolveComicPresetIds(['deepseek-q', 'missing', ' deepseek-anime ', 'deepseek-q'])).toEqual([
      'deepseek-q',
      'deepseek-anime',
    ]);
  });
});

describe('drawReportComic', () => {
  it('appends the drawing task after the report prefix and calls generate_image itself', async () => {
    const promptManager = new PromptManager();
    const promptPrefix = renderGroupChatPrefix(promptManager, PREFIX_VARS);
    let seen:
      | {
          type: SubAgentType;
          description: string;
          config?: Partial<SubAgentConfig>;
        }
      | undefined;
    const aiService = {
      runSubAgent: async (
        type: SubAgentType,
        task: { description: string },
        config?: Partial<SubAgentConfig>,
      ) => {
        seen = { type, description: task.description, config };
        return '赤铜又炸了';
      },
    } as unknown as AIService;

    const caption = await drawReportComic({
      aiService,
      promptManager,
      groupId: '30001',
      userId: '20001',
      promptPrefix,
      presetIds: ['deepseek-q', 'deepseek-anime'],
    });

    expect(caption).toBe('赤铜又炸了');
    expect(seen?.type).toBe(SubAgentType.TASK_EXECUTION);
    expect(seen?.config?.allowedTools).toBeUndefined();
    expect(seen?.config?.maxTokens).toBeUndefined();
    expect(seen?.config?.maxToolRounds).toBeNull();
    expect(seen?.config?.systemTemplate).toBe('subagent.group_report.system');
    expect(seen?.description.startsWith(`${promptPrefix}\n\n`)).toBe(true);
    expect(seen?.description).toContain('每张图从中选一个');
    expect(seen?.description).toContain('deepseek-q');
    expect(seen?.description).toContain('deepseek-anime');
  });

  it('does not spawn an agent when no preset id exists', async () => {
    let calls = 0;
    const aiService = {
      runSubAgent: async () => {
        calls += 1;
        return '';
      },
    } as unknown as AIService;

    const caption = await drawReportComic({
      aiService,
      promptManager: new PromptManager(),
      groupId: '30001',
      userId: '20001',
      promptPrefix: '聊天记录',
      presetIds: ['missing'],
    });

    expect(caption).toBe('');
    expect(calls).toBe(0);
  });
});
