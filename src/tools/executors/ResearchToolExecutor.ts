// Research meta-tool executor — delegates data-intensive tools to a subagent
// with isolated context, returning only the summarized conclusion to the main agent.

import { inject, injectable } from 'tsyringe';
import type { SubAgentManager } from '@/agent/SubAgentManager';
import { SubAgentType } from '@/agent/types';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Default timeout for research subagent (60 seconds) */
const RESEARCH_TIMEOUT = 90000;

/**
 * Research tool executor.
 *
 * This is a **meta-tool**: it does not fetch data itself but spawns a
 * research subagent that has access to data-intensive tools (search,
 * fetch_page, rag_search, search_memory, fetch_history_by_time).
 *
 * The subagent runs in an isolated LLM context so that raw tool results
 * never enter the main reply context — only the condensed conclusion does.
 * This prevents prompt-token inflation that triggers provider TPM limits.
 */
@Tool({
  name: 'research',
  description:
    '调研工具：委托一个独立的 subagent 执行信息收集任务。subagent 拥有联网搜索、网页抓取、知识库检索、记忆查询等工具，会自主完成多步调研并返回精炼结论。你无法直接使用这些底层数据工具，必须通过本工具发起调研。',
  executor: 'research',
  visibility: ['reply'],
  parameters: {
    task: {
      type: 'string',
      required: true,
      description:
        '调研任务描述，说明你需要查找什么信息、回答什么问题。描述越具体，结果越精准。',
    },
  },
  examples: [
    '帮我查一下2024年诺贝尔物理学奖得主及其研究内容',
    '搜索并总结这篇文章的要点 https://example.com/article',
    '查找群里关于项目截止日期的讨论记录',
  ],
  triggerKeywords: ['搜索', 'search', '查', '找', '调研', '了解', '查询', '搜一下'],
  whenToUse:
    '当需要联网搜索、抓取网页、检索知识库或查询记忆时，必须通过此工具发起调研，不要直接调用底层数据工具。一次调研可完成多步信息收集（如先搜索再抓取网页），避免多次工具调用膨胀上下文。',
})
@injectable()
export class ResearchToolExecutor extends BaseToolExecutor {
  name = 'research';

  constructor(
    @inject(DITokens.SUB_AGENT_MANAGER)
    private subAgentManager: SubAgentManager,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const task = call.parameters?.task as string | undefined;

    if (!task) {
      return this.error('请提供调研任务描述', 'Missing required parameter: task');
    }

    logger.info(`[ResearchToolExecutor] Starting research subagent: ${task.slice(0, 80)}`);

    try {
      const parentContext = {
        userId: context.userId,
        groupId: context.groupId,
        messageType: context.messageType,
        conversationId: context.conversationId,
        messageId: context.messageId,
      };

      const sessionId = await this.subAgentManager.spawn(
        undefined, // no parent agent
        SubAgentType.RESEARCH,
        {
          description: task,
          input: { task },
          parentContext,
        },
        {
          timeout: RESEARCH_TIMEOUT,
          maxDepth: 1, // research subagent should not spawn further subagents
          maxChildren: 0,
          allowedTools: [], // empty = all subagent-scoped tools
          restrictedTools: ['spawn_subagent'], // no recursive spawning
          inheritSoul: false,
          inheritMemory: false,
          inheritPreference: false,
        },
      );

      await this.subAgentManager.execute(sessionId);
      const output = await this.subAgentManager.wait(sessionId, RESEARCH_TIMEOUT);

      const resultText = typeof output === 'string' ? output : JSON.stringify(output);

      logger.info(
        `[ResearchToolExecutor] Research completed (${resultText.length} chars): ${task.slice(0, 50)}`,
      );

      return this.success(resultText, {
        task,
        completed: true,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[ResearchToolExecutor] Research failed: ${errorMessage}`);
      return this.error(`调研失败: ${errorMessage}`, errorMessage);
    }
  }
}
