/**
 * Todo Plugin
 *
 * Provides a /todo command to add TODO items to a project's ToDo.md file.
 * Supports @{alias} syntax to specify the target project (same as /claude command).
 *
 * Commands:
 * - /todo @<alias> <content> - Add a TODO item to the specified project
 * - /todo <content> - Add a TODO item to the default project
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
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
  version: '1.0.0',
  description: 'Add TODO items to project ToDo.md files',
})
export class TodoPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private registry: ProjectRegistry | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);

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

    // Append TODO item
    try {
      const existing = readFileSync(todoPath, 'utf-8');
      const newItem = `- [ ] ${content}`;
      const updated = `${existing.trimEnd()}\n${newItem}\n`;
      writeFileSync(todoPath, updated, 'utf-8');

      logger.info(`[TodoPlugin] Added TODO to ${project.alias}: ${content}`);
      return {
        success: true,
        segments: new MessageBuilder().text(`已添加 TODO 到项目 "${project.alias}":\n${newItem}`).build(),
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
