// Tool Use Reply Service - generates replies using native tool/function calling

import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskResult, TaskType } from '@/task/types';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../prompt/PromptManager';
import { PromptMessageAssembler } from '../prompt/PromptMessageAssembler';
import type { ChatMessage, FunctionCall, ToolDefinition } from '../types';
import type { LLMService } from './LLMService';

/**
 * Tool Use Reply Service
 * Generates replies using native function calling instead of TaskAnalyzer
 * Merges TaskAnalyzer and ReplyGenerationService into a single LLM call with tool use
 */
export class ToolUseReplyService {
  private readonly messageAssembler = new PromptMessageAssembler();
  private static readonly SEARCH_TASK_NAME = 'search';

  constructor(
    private llmService: LLMService,
    private taskManager: TaskManager,
    private promptManager: PromptManager,
    private hookManager?: HookManager, // Required when using taskManager.execute (Tool Use path)
  ) {}

  /**
   * Generate reply with tool use
   */
  async generateReply(context: HookContext): Promise<string> {
    const sessionId = context.metadata.get('sessionId') as string | undefined;
    const nativeWebSearchEnabled = await this.supportsNativeWebSearch(undefined, sessionId);
    const tools = this.getAvailableToolDefinitions({ nativeWebSearchEnabled });
    logger.info(`[ToolUseReplyService] Triggered ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

    const messages = await this.buildMessages(context, tools, nativeWebSearchEnabled);
    return this.generateReplyFromMessages(context, messages, {
      tools,
      sessionId,
      nativeWebSearchEnabled,
    });
  }

  /**
   * Get all tool definitions available to the reply flow.
   */
  getAvailableToolDefinitions(options?: { nativeWebSearchEnabled?: boolean }): ToolDefinition[] {
    const taskTypes = this.getAvailableTaskTypes(options);
    return this.buildToolDefinitions(taskTypes);
  }

  /**
   * Render explicit tool-choice instructions for prompt injection.
   */
  getToolUsageInstructions(
    tools: ToolDefinition[] = this.getAvailableToolDefinitions(),
    options?: { nativeWebSearchEnabled?: boolean },
  ): string {
    if (tools.length === 0) {
      return options?.nativeWebSearchEnabled
        ? '当前没有本地可用工具；若需要查询公开互联网的最新信息，请直接使用 provider 内建搜索，再基于结果回答。'
        : '当前没有可用工具，请直接回答。';
    }

    const taskTypesByName = new Map(
      this.getAvailableTaskTypes(options).map((taskType) => [taskType.name, taskType] as const),
    );
    const toolLines = tools.map((tool) => {
      const taskType = taskTypesByName.get(tool.name);
      const required = new Set(tool.parameters.required ?? []);
      const params = Object.entries(tool.parameters.properties ?? {})
        .map(([name, def]) => {
          const requiredLabel = required.has(name) ? '必填' : '可选';
          const enumLabel = Array.isArray(def.enum) && def.enum.length > 0 ? `，取值: ${def.enum.join(' / ')}` : '';
          return `${name} (${def.type}，${requiredLabel}${enumLabel})${def.description ? `: ${def.description}` : ''}`;
        })
        .join('; ');
      const usage = taskType?.whenToUse?.trim();
      const examples =
        taskType?.examples && taskType.examples.length > 0
          ? `\n  示例: ${taskType.examples.slice(0, 2).join('；')}`
          : '';
      return `- ${tool.name}: ${tool.description}${usage ? `\n  适用时机: ${usage}` : ''}${params ? `\n  参数: ${params}` : ''}${examples}`;
    });

    return [
      options?.nativeWebSearchEnabled
        ? '当问题需要公开互联网的最新事实、新闻、网页内容或实时信息时，优先使用 provider 内建搜索；当需要本地文件、memory、RAG 或应用侧数据时，再调用本地工具。'
        : '当问题需要最新事实、网页正文、搜索结果、文件内容，或你缺少关键信息时，先调用工具，再回答；不要凭空假设工具已经执行过。',
      '若当前已有上下文已经足够、只是闲聊、改写、翻译、总结用户已给出的内容，可以不调用工具，直接回答。',
      '优先直接调用最贴近目标的单个工具，尤其是本地 memory、RAG、文件、页面抓取类工具。',
      '工具结果比你自身记忆更可信；如果工具结果与已有印象冲突，以工具结果为准。',
      '如果工具执行失败、返回空结果或信息不足，要诚实说明限制；不要编造结果。',
      '在同一轮中，先解决信息获取，再基于工具结果组织最终回复；不要把“准备去查”当成最终答案。',
      '可用工具列表：',
      ...toolLines,
    ].join('\n');
  }

  private getAvailableTaskTypes(options?: { nativeWebSearchEnabled?: boolean }): TaskType[] {
    return this.taskManager.getAllTaskTypes().filter((tt) => {
      if (tt.name === 'reply') {
        return false;
      }
      if (options?.nativeWebSearchEnabled && tt.name === ToolUseReplyService.SEARCH_TASK_NAME) {
        return false;
      }
      return true;
    });
  }

  /**
   * Build tool definitions from task types
   */
  private buildToolDefinitions(taskTypes: TaskType[]): ToolDefinition[] {
    return taskTypes.map((tt) => ({
      name: tt.name,
      description: tt.description,
      parameters: this.convertToJSONSchema(tt.parameters || {}),
    }));
  }

  /**
   * Convert task parameters to JSON Schema format
   */
  private convertToJSONSchema(params: TaskType['parameters']): ToolDefinition['parameters'] {
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];

    for (const [key, def] of Object.entries(params || {})) {
      properties[key] = {
        type: def.type,
        description: def.description || '',
      };

      if (def.required) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }

  /**
   * Run a prepared message list through the tool-use loop.
   */
  async generateReplyFromMessages(
    context: HookContext,
    messages: ChatMessage[],
    options?: {
      tools?: ToolDefinition[];
      providerName?: string;
      sessionId?: string;
      temperature?: number;
      maxTokens?: number;
      maxToolRounds?: number;
      nativeWebSearchEnabled?: boolean;
    },
  ): Promise<string> {
    const tools =
      options?.tools ?? this.getAvailableToolDefinitions({ nativeWebSearchEnabled: options?.nativeWebSearchEnabled });
    if (tools.length === 0) {
      const response = await this.llmService.generateMessages(
        messages,
        {
          temperature: options?.temperature ?? 0.7,
          maxTokens: options?.maxTokens ?? 4000,
          sessionId: options?.sessionId,
          nativeWebSearch: options?.nativeWebSearchEnabled,
        },
        options?.providerName,
      );
      return response.text;
    }

    const response = await this.llmService.generateWithTools(
      messages,
      tools,
      {
        temperature: options?.temperature ?? 0.7,
        maxTokens: options?.maxTokens ?? 4000,
        maxToolRounds: options?.maxToolRounds ?? 3,
        sessionId: options?.sessionId,
        nativeWebSearch: options?.nativeWebSearchEnabled,
        toolExecutor: (call) => this.executeToolCall(call, context),
      },
      options?.providerName,
    );

    return response.text;
  }

  /**
   * Execute tool call (including spawn_subagent when SubAgent is enabled)
   */
  private async executeToolCall(call: FunctionCall, context: HookContext): Promise<unknown> {
    logger.info(`[ToolUseReplyService] Executing tool: ${call.name}`);

    const taskType = this.taskManager.getTaskType(call.name);
    if (!taskType) {
      throw new Error(`Task type not found for tool: ${call.name}`);
    }
    const executor = this.taskManager.getExecutor(taskType.executor);
    if (!executor) {
      throw new Error(`Executor not found for tool: ${call.name}`);
    }

    const task: Task = {
      type: call.name,
      parameters: JSON.parse(call.arguments),
      executor: call.name,
    };

    const taskContext = TaskExecutionContextBuilder.fromHookContext(context).withTaskResults(new Map()).build();

    if (!this.hookManager) {
      throw new Error('HookManager is required for tool execution');
    }
    const result: TaskResult = await this.taskManager.execute(task, taskContext, this.hookManager, context);

    // Return the data or reply
    return result.data ?? result.reply;
  }
  /**
   * Build messages from context (simplified version)
   */
  private async buildMessages(
    context: HookContext,
    tools: ToolDefinition[],
    nativeWebSearchEnabled = false,
  ): Promise<ChatMessage[]> {
    const basePrompt = this.promptManager.renderBasePrompt();
    const toolUsageInstructions = this.getToolUsageInstructions(tools, { nativeWebSearchEnabled });
    let sceneSystemPrompt: string;
    try {
      const contextInstruct = this.promptManager.render('llm.context.instruct');
      const toolInstruct = this.promptManager.render('llm.tool.instruct', { toolUsageInstructions });
      sceneSystemPrompt = this.promptManager.render('llm.reply.system', {
        contextInstruct,
        toolInstruct,
      });
    } catch (error) {
      logger.debug(
        `[ToolUseReplyService] LLM scene or fragment template unavailable, using fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      sceneSystemPrompt = ['你正在参与一段即时对话，请先理解上下文，再决定是否调用工具。', toolUsageInstructions].join(
        '\n\n',
      );
    }
    const currentQuery = this.safeRender(
      'llm.reply.user_frame',
      {
        userMessage: context.message.message,
      },
      context.message.message,
    );
    const historyEntries: ConversationMessageEntry[] = (context.context?.history ?? []).map((msg, index) => ({
      messageId: `ctx:${index}`,
      userId: msg.role === 'assistant' ? 0 : context.message.userId,
      nickname: context.message.sender?.nickname,
      content: msg.content,
      isBotReply: msg.role === 'assistant',
      createdAt: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp),
      segments: undefined,
    }));

    return this.messageAssembler.buildNormalMessages({
      baseSystem: basePrompt,
      sceneSystem: sceneSystemPrompt,
      historyEntries,
      finalUserBlocks: {
        currentQuery,
      },
    });
  }

  private safeRender(name: string, variables: Record<string, string>, fallback: string): string {
    try {
      return this.promptManager.render(name, variables);
    } catch (error) {
      logger.debug(
        `[ToolUseReplyService] Prompt template "${name}" unavailable, using fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  private async supportsNativeWebSearch(providerName?: string, sessionId?: string): Promise<boolean> {
    const candidate = this.llmService as LLMService & {
      supportsNativeWebSearch?: (providerName?: string, sessionId?: string) => Promise<boolean>;
    };
    if (typeof candidate.supportsNativeWebSearch !== 'function') {
      return false;
    }
    return candidate.supportsNativeWebSearch(providerName, sessionId);
  }
}
