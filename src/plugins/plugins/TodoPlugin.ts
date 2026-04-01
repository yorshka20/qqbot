/**
 * Todo Plugin
 *
 * Provides a /todo command to add TODO items to a project's ToDo.md file.
 * Supports @{alias} syntax to specify the target project (same as /claude command).
 * Before inserting, sends the raw content to LLM for optimization (better expression, subtask breakdown).
 *
 * Commands:
 * - /todo @<alias> <content> - Add a TODO item to the specified project
 * - /todo <content> - Add a TODO item to the default project
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { logger } from '@/utils/logger';

const USAGE = `/todo <content> - 添加 TODO 到默认项目
/todo @<alias> <content> - 添加 TODO 到指定项目`;

const TEMPLATE_PATH = resolve(process.cwd(), 'template/ToDo.md');

@RegisterPlugin({
  name: 'todo',
  version: '1.1.0',
  description: 'Add TODO items to project ToDo.md files with LLM optimization',
})
export class TodoPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private registry: ProjectRegistry | null = null;
  private llmService!: LLMService;
  private promptManager!: PromptManager;
  private config!: Config;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.config = container.resolve<Config>(DITokens.CONFIG);

    try {
      const claudeCodeService = container.resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
      this.registry = claudeCodeService.getProjectRegistry();
    } catch {
      logger.warn('[TodoPlugin] ClaudeCodeService not available - project resolution disabled');
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    const handler = new PluginCommandHandler(
      'todo',
      'Add TODO items to project ToDo.md files',
      USAGE,
      async (args: string[], context: CommandContext) => {
        return await this.executeTodoCommand(args, context);
      },
      this.context,
      ['admin', 'owner'],
    );

    this.commandManager.register(handler, this.name);
    logger.info('[TodoPlugin] Todo plugin enabled');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    this.commandManager.unregister('todo');
    logger.info('[TodoPlugin] Todo plugin disabled');
  }

  private async executeTodoCommand(_args: string[], _context: CommandContext): Promise<CommandResult> {
    if (_args.length === 0) {
      return {
        success: true,
        segments: new MessageBuilder().text(`使用方法:\n${USAGE}`).build(),
      };
    }

    // Parse @alias and content
    let projectIdentifier: string | undefined;
    let content: string;

    if (_args[0].startsWith('@')) {
      projectIdentifier = _args[0].slice(1);
      content = _args.slice(1).join(' ');
    } else {
      content = _args.join(' ');
    }

    if (!content.trim()) {
      return {
        success: false,
        segments: new MessageBuilder().text('请提供 TODO 内容').build(),
        error: 'Missing content',
      };
    }

    // Resolve project
    if (!this.registry) {
      return {
        success: false,
        segments: new MessageBuilder().text('项目注册表未配置，无法解析项目路径').build(),
        error: 'ProjectRegistry not available',
      };
    }

    const project = this.registry.resolve(projectIdentifier);
    if (!project) {
      const hint = projectIdentifier
        ? `未找到项目: ${projectIdentifier}\n使用 /claude projects 查看已注册项目`
        : '未配置默认项目';
      return {
        success: false,
        segments: new MessageBuilder().text(hint).build(),
        error: 'Project not found',
      };
    }

    // Ensure ToDo.md exists
    const todoPath = resolve(project.path, 'ToDo.md');
    try {
      this.ensureTodoFile(todoPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        segments: new MessageBuilder().text(`创建 ToDo.md 失败: ${msg}`).build(),
        error: msg,
      };
    }

    // Read existing todo content for LLM context
    const existingContent = readFileSync(todoPath, 'utf-8');

    // Optimize content via LLM
    let optimizedContent: string;
    try {
      optimizedContent = await this.optimizeTodoContent(content, existingContent, project.path, project.alias);
      logger.info(`[TodoPlugin] LLM optimized TODO: "${content}" -> "${optimizedContent}"`);
    } catch (error) {
      logger.warn('[TodoPlugin] LLM optimization failed, using raw content:', error);
      optimizedContent = `- [ ] ${content}`;
    }

    // Append optimized TODO item
    try {
      const updated = `${existingContent.trimEnd()}\n${optimizedContent}\n`;
      writeFileSync(todoPath, updated, 'utf-8');

      logger.info(`[TodoPlugin] Added TODO to ${project.alias}`);
      return {
        success: true,
        segments: new MessageBuilder().text(`已添加 TODO 到项目 "${project.alias}":\n${optimizedContent}`).build(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('[TodoPlugin] Failed to write ToDo.md:', error);
      return {
        success: false,
        segments: new MessageBuilder().text(`写入 ToDo.md 失败: ${msg}`).build(),
        error: msg,
      };
    }
  }

  /**
   * Use LLM to optimize the raw todo content.
   * Renders the task.todo-optimize prompt template and calls LLM for better task description.
   */
  private async optimizeTodoContent(
    rawContent: string,
    existingTodoContent: string,
    projectPath: string,
    projectAlias: string,
  ): Promise<string> {
    const aiConfig = this.config.getAIConfig();
    const provider = aiConfig?.taskProviders?.todoOptimize ?? aiConfig?.defaultProviders?.llm;

    const prompt = this.promptManager.render('task.todo-optimize', {
      rawContent,
      existingTodoContent,
      projectPath,
      projectAlias,
    });

    const response = await this.llmService.generate(
      prompt,
      {
        temperature: 0.3,
        maxTokens: 1024,
        ...(aiConfig?.taskProviders?.todoOptimizeModel ? { model: aiConfig.taskProviders.todoOptimizeModel } : {}),
      },
      provider,
    );

    const text = response.text?.trim();
    if (!text) {
      throw new Error('LLM returned empty response');
    }

    // Strip markdown code block fences if present
    const cleaned = text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '').trim();

    // Validate: must contain at least one checkbox item
    if (!cleaned.includes('- [ ]')) {
      throw new Error('LLM response does not contain valid checkbox items');
    }

    return cleaned;
  }

  /**
   * Ensure ToDo.md exists at the given path.
   * If it doesn't exist, create it from template/ToDo.md.
   */
  private ensureTodoFile(todoPath: string): void {
    if (existsSync(todoPath)) {
      return;
    }

    const dir = dirname(todoPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(TEMPLATE_PATH)) {
      const template = readFileSync(TEMPLATE_PATH, 'utf-8');
      writeFileSync(todoPath, template, 'utf-8');
      logger.info(`[TodoPlugin] Created ToDo.md from template at ${todoPath}`);
    } else {
      // Fallback: create a minimal ToDo.md
      const fallback = '# ToDo\n\n## Tasks\n\n';
      writeFileSync(todoPath, fallback, 'utf-8');
      logger.info(`[TodoPlugin] Created minimal ToDo.md at ${todoPath}`);
    }
  }
}
