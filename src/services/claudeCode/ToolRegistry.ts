/**
 * ToolRegistry - manages and executes Claude Code tools
 *
 * Provides a registry for tool executors that Claude Code can call
 * via the MCP Server API to perform git operations, quality checks, etc.
 */

import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteParams, ToolExecuteResult } from '../mcpServer/types';
import { GitBranchExecutor } from './executors/GitBranchExecutor';
import { GitCommitExecutor } from './executors/GitCommitExecutor';
import { GitPRExecutor } from './executors/GitPRExecutor';
import { ProjectInfoExecutor } from './executors/ProjectInfoExecutor';
import { QualityCheckExecutor } from './executors/QualityCheckExecutor';
import { ReadFileExecutor } from './executors/ReadFileExecutor';
import type { ToolExecutor } from './types';

export class ToolRegistry {
  private tools: Map<string, ToolExecutor> = new Map();
  private workingDirectory: string;

  constructor(workingDirectory?: string) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    this.register(new ReadFileExecutor(this.workingDirectory));
    this.register(new ProjectInfoExecutor(this.workingDirectory));
    this.register(new GitCommitExecutor(this.workingDirectory));
    this.register(new QualityCheckExecutor(this.workingDirectory));
    this.register(new GitBranchExecutor(this.workingDirectory));
    this.register(new GitPRExecutor(this.workingDirectory));
  }

  register(executor: ToolExecutor): void {
    this.tools.set(executor.name, executor);
    logger.debug(`[ToolRegistry] Registered tool: ${executor.name}`);
  }

  async execute(params: ToolExecuteParams): Promise<ToolExecuteResult> {
    const executor = this.tools.get(params.tool);
    if (!executor) {
      return { success: false, error: `Unknown tool: ${params.tool}` };
    }

    logger.info(`[ToolRegistry] Executing tool: ${params.tool}`, { taskId: params.taskId });

    try {
      return await executor.execute(params.parameters);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[ToolRegistry] Tool execution error: ${params.tool}`, err);
      return { success: false, error: errorMsg };
    }
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }
}
