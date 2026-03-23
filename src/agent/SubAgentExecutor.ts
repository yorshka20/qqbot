// SubAgent Executor - executes sub-agents with isolated context

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { ChatMessage, FunctionCall, ToolDefinition, ToolUseGenerateResponse } from '@/ai/types';
import { logger } from '@/utils/logger';
import type { SubAgentManager } from './SubAgentManager';
import type { IToolRunner } from './ToolRunner';
import type { SubAgentConfig, SubAgentContext, SubAgentSession, SubAgentType } from './types';

/** Template name mapping: SubAgentType → prompt template key */
const SUBAGENT_SYSTEM_TEMPLATES: Partial<Record<SubAgentType, string>> = {
  research: 'subagent.research.system',
  analysis: 'subagent.research.system', // reuse research system prompt
};

const SUBAGENT_TASK_TEMPLATES: Partial<Record<SubAgentType, string>> = {
  research: 'subagent.research.task',
  generic: 'subagent.generic.task',
};

/**
 * SubAgent Executor
 * Executes sub-agents with isolated context and tool permissions.
 * Tool execution is done only via injected ToolRunner (no fallback callback).
 */
export class SubAgentExecutor {
  // Tool restrictions by depth
  private readonly TOOL_RESTRICTIONS_BY_DEPTH: Record<number, string[]> = {
    0: [], // Main agent - no restrictions
    1: [], // Depth 1 - can spawn sub-agents
    2: [], // Depth 2 - can spawn sub-agents
    3: ['spawn_subagent', 'file_write'], // Depth 3 - no spawn, no file write
    4: ['spawn_subagent', 'file_write', 'send_message'], // Depth 4 - further restricted
    5: ['spawn_subagent', 'file_write', 'send_message', 'http_request'], // Depth 5 - most restricted
  };

  constructor(
    private llmService: LLMService,
    private subAgentManager: SubAgentManager,
    private availableTools: ToolDefinition[],
    private toolRunner: IToolRunner,
    private promptManager: PromptManager,
    private defaultProviderName?: string,
    private defaultModel?: string,
  ) {}

  /**
   * Execute sub-agent
   */
  async execute(session: SubAgentSession): Promise<unknown> {
    this.subAgentManager.updateSessionStatus(session.id, 'running');

    try {
      // 1. Build isolated context
      const context = await this.buildContext(session);

      // 2. Filter tools based on permissions
      const tools = this.filterTools(session.config, session.depth);

      // 3. Build messages
      const messages = this.buildMessages(session, context);

      // 4. Execute LLM with tools (ToolRunner executes tool calls)
      // Use provider from session config, or fall back to the default provider configured for SubAgentExecutor.
      const providerName = session.config.providerName ?? this.defaultProviderName;
      const result = await this.llmService.generateWithTools(
        messages,
        tools,
        {
          temperature: 0.7,
          maxTokens: session.config.maxTokens ?? 1500,
          maxToolRounds: session.config.maxToolRounds ?? 5,
          model: session.config.providerName ? undefined : this.defaultModel,
          toolExecutor: (call: FunctionCall) => this.toolRunner.run(call, session),
        },
        providerName,
      );

      // 5. Parse and return result
      const output = this.parseResult(result);

      this.subAgentManager.updateSessionStatus(session.id, 'completed', output);

      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[SubAgentExecutor] Sub-agent ${session.id} failed:`, err);
      this.subAgentManager.updateSessionStatus(session.id, 'failed', undefined, err);
      throw err;
    }
  }

  /**
   * Build isolated context for sub-agent
   */
  private async buildContext(session: SubAgentSession): Promise<SubAgentContext> {
    const context: SubAgentContext = {
      sessionId: session.context.sessionId,
      episodeId: session.context.episodeId,
      history: [],
      memory: '',
      preference: '',
    };

    // For now, return minimal context
    // TODO: Implement context inheritance based on config
    // if (session.config.inheritMemory) {
    //   context.memory = await this.loadMemory(session);
    // }
    // if (session.config.inheritPreference) {
    //   context.preference = await this.loadPreference(session);
    // }

    return context;
  }

  /**
   * Filter tools based on config and depth
   */
  private filterTools(config: SubAgentConfig, depth: number): ToolDefinition[] {
    let tools = [...this.availableTools];

    // Apply depth restrictions
    const depthRestrictions = this.TOOL_RESTRICTIONS_BY_DEPTH[depth] || [];
    tools = tools.filter((t) => !depthRestrictions.includes(t.name));

    // Apply whitelist
    if (config.allowedTools.length > 0) {
      tools = tools.filter((t) => config.allowedTools.includes(t.name));
    }

    // Apply blacklist
    if (config.restrictedTools.length > 0) {
      tools = tools.filter((t) => !config.restrictedTools.includes(t.name));
    }

    logger.debug(`[SubAgentExecutor] Filtered tools for depth ${depth}: ${tools.map((t) => t.name).join(', ')}`);

    return tools;
  }

  /**
   * Build messages for LLM using prompt templates.
   */
  private buildMessages(session: SubAgentSession, context: SubAgentContext): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System message from template (config override → type-specific → hardcoded minimal)
    const systemTemplateName = session.config.systemTemplate ?? SUBAGENT_SYSTEM_TEMPLATES[session.type];
    const systemContent = this.renderTemplateOrFallback(
      systemTemplateName,
      { message: session.task.description },
      `你是一个子任务执行助手。完成以下任务并给出简洁总结。`,
    );
    messages.push({ role: 'system', content: systemContent });

    // Add memory if available
    if (context.memory) {
      messages.push({ role: 'system', content: `记忆: ${context.memory}` });
    }

    // Task input from template (type-specific → fallback to generic)
    const taskTemplateName = SUBAGENT_TASK_TEMPLATES[session.type];
    const taskContent = this.renderTemplateOrFallback(
      taskTemplateName,
      { message: session.task.description },
      `任务: ${session.task.description}\n\n输入: ${JSON.stringify(session.task.input)}`,
    );
    messages.push({ role: 'user', content: taskContent });

    return messages;
  }

  /**
   * Try to render a prompt template; return fallback string if template is not found.
   */
  private renderTemplateOrFallback(
    templateName: string | undefined,
    variables: Record<string, string>,
    fallback: string,
  ): string {
    if (!templateName) return fallback;
    try {
      return this.promptManager.render(templateName, variables);
    } catch {
      logger.debug(`[SubAgentExecutor] Template "${templateName}" not found, using fallback`);
      return fallback;
    }
  }

  /**
   * Parse result from LLM
   */
  private parseResult(result: ToolUseGenerateResponse): unknown {
    // For now, just return the text (final answer after tool rounds if any)
    // TODO: Parse structured output if needed
    return result.text;
  }
}
