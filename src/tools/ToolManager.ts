// ToolManager - registers and manages tools and executors

import type { ToolDefinition } from '@/ai/types';
import { getContainer } from '@/core/DIContainer';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { getAllToolMetadata, metadataToToolSpec } from './decorators';
import type { ToolCall, ToolExecutionContext, ToolExecutor, ToolResult, ToolScope, ToolSpec } from './types';

const DEFAULT_VISIBILITY: ToolScope[] = ['reply', 'subagent'];

export class ToolManager {
  private tools = new Map<string, ToolSpec>();
  private executors = new Map<string, ToolExecutor>();
  private executorClasses = new Map<string, new (...args: any[]) => ToolExecutor>();

  /**
   * Auto-register all decorated tools.
   * Uses lazy instantiation — executors are created on first execution.
   */
  autoRegisterTools(): void {
    const metadataList = getAllToolMetadata();

    for (const metadata of metadataList) {
      try {
        const name = metadata.name.toLowerCase();
        if (this.tools.has(name)) {
          continue;
        }

        const toolSpec = metadataToToolSpec(metadata);
        this.registerTool(toolSpec);

        if (!this.executors.has(metadata.executor.toLowerCase())) {
          this.executorClasses.set(metadata.executor.toLowerCase(), metadata.executorClass);
          this.registerLazyExecutor(metadata.executorClass, metadata.executor);
        }

        logger.info(`✅ [ToolManager] Auto-registered tool: ${name} (executor: ${metadata.executor})`);
      } catch (error) {
        logger.error(`[ToolManager] Failed to auto-register tool ${metadata.name}:`, error);
      }
    }
  }

  private registerLazyExecutor(executorClass: new (...args: any[]) => ToolExecutor, executorName: string): void {
    let cachedInstance: ToolExecutor | null = null;

    const getInstance = (): ToolExecutor => {
      if (cachedInstance) {
        return cachedInstance;
      }

      const container = getContainer();

      try {
        cachedInstance = container.resolve(executorClass);
        logger.debug(`[ToolManager] 🎯 Lazy-instantiated ${executorName} via DI`);
        return cachedInstance;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        if (executorClass.length === 0) {
          logger.debug(`[ToolManager] Fallback to direct instantiation for ${executorName} (no constructor params)`);
          cachedInstance = new executorClass();
          return cachedInstance;
        }

        logger.error(`[ToolManager] Failed to resolve ${executorName} via DI: ${err.message}`);
        throw new Error(`Failed to instantiate executor ${executorName}: ${err.message}`);
      }
    };

    const lazyExecutor: ToolExecutor = {
      name: executorName,
      execute: async (call: ToolCall, context: ToolExecutionContext) => {
        const executor = getInstance();
        return executor.execute(call, context);
      },
    };

    this.executors.set(executorName.toLowerCase(), lazyExecutor);
  }

  // ── Registration ──────────────────────────────────────────────────

  registerTool(toolSpec: ToolSpec): void {
    this.tools.set(toolSpec.name.toLowerCase(), toolSpec);
  }

  registerTools(toolSpecs: ToolSpec[]): void {
    for (const spec of toolSpecs) {
      this.registerTool(spec);
    }
  }

  registerExecutor(executor: ToolExecutor): void {
    const name = executor.name.toLowerCase();
    this.executorClasses.delete(name);
    this.executors.set(name, executor);
    logger.info(`⚙️ [ToolManager] Registered executor: ${name}`);
  }

  // ── Query ─────────────────────────────────────────────────────────

  getTool(name: string): ToolSpec | null {
    return this.tools.get(name.toLowerCase()) || null;
  }

  getAllTools(): ToolSpec[] {
    return Array.from(this.tools.values());
  }

  getExecutor(name: string): ToolExecutor | null {
    return this.executors.get(name.toLowerCase()) || null;
  }

  /**
   * Get tools visible in the given scope.
   * Tools without explicit visibility default to ['reply', 'subagent'].
   */
  getToolsByScope(scope: ToolScope): ToolSpec[] {
    return this.getAllTools().filter((t) => {
      const vis = t.visibility ?? DEFAULT_VISIBILITY;
      return vis.includes(scope);
    });
  }

  /**
   * Convert ToolSpec[] to OpenAI-compatible ToolDefinition[] for LLM consumption.
   * Absorbs the logic that was previously in SkillRegistry.
   */
  toToolDefinitions(specs: ToolSpec[]): ToolDefinition[] {
    return specs.map((spec) => {
      const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};
      const required: string[] = [];

      for (const [key, def] of Object.entries(spec.parameters || {})) {
        properties[key] = {
          type: def.type,
          description: def.description || '',
        };
        if (def.required) {
          required.push(key);
        }
      }

      return {
        name: spec.name,
        description: spec.description,
        parameters: {
          type: 'object' as const,
          properties,
          required,
        },
      };
    });
  }

  // ── Execution ─────────────────────────────────────────────────────

  async execute(
    call: ToolCall,
    context: ToolExecutionContext,
    hookManager: HookManager,
    hookContext: HookContext,
  ): Promise<ToolResult> {
    const toolSpec = this.getTool(call.type);
    if (!toolSpec) {
      return {
        success: false,
        reply: `Unknown tool: ${call.type}`,
        error: `Tool "${call.type}" not found`,
      };
    }

    const executorName = toolSpec.executor;
    const executor = this.getExecutor(executorName);

    if (!executor) {
      return {
        success: false,
        reply: `Executor not found: ${executorName}`,
        error: `Executor "${executorName}" not found`,
      };
    }

    if (toolSpec.parameters) {
      const validationError = this.validateParameters(call.parameters, toolSpec.parameters);
      if (validationError) {
        return {
          success: false,
          reply: `Invalid parameters: ${validationError}`,
          error: validationError,
        };
      }
    }

    const shouldExecute = await hookManager.execute('onTaskBeforeExecute', hookContext);
    if (!shouldExecute) {
      return {
        success: false,
        reply: 'Tool execution interrupted by hook',
        error: 'Tool execution interrupted by hook',
      };
    }

    try {
      logger.debug(`[ToolManager] Executing tool: ${toolSpec.name} (executor: ${executorName})`);

      const result = await executor.execute(call, context);

      hookContext.result = result;
      await hookManager.execute('onTaskExecuted', hookContext);

      if (result.success) {
        logger.debug(`[ToolManager] Tool ${toolSpec.name} executed successfully`);
      } else {
        logger.warn(`[ToolManager] Tool ${toolSpec.name} failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[ToolManager] Error executing tool ${toolSpec.name}:`, err);

      return {
        success: false,
        reply: `Tool execution failed: ${err.message}`,
        error: err.message,
      };
    }
  }

  private validateParameters(
    parameters: Record<string, unknown>,
    parameterDefs: ToolSpec['parameters'],
  ): string | null {
    if (!parameterDefs) {
      return null;
    }

    for (const [key, def] of Object.entries(parameterDefs)) {
      if (def.required && !(key in parameters)) {
        return `Missing required parameter: ${key}`;
      }

      if (key in parameters) {
        const value = parameters[key];
        const expectedType = def.type;

        if (expectedType === 'string' && typeof value !== 'string') {
          return `Parameter ${key} must be a string`;
        }
        if (expectedType === 'number' && typeof value !== 'number') {
          return `Parameter ${key} must be a number`;
        }
        if (expectedType === 'boolean' && typeof value !== 'boolean') {
          return `Parameter ${key} must be a boolean`;
        }
        if (expectedType === 'object' && (typeof value !== 'object' || value === null)) {
          return `Parameter ${key} must be an object`;
        }
        if (expectedType === 'array' && !Array.isArray(value)) {
          return `Parameter ${key} must be an array`;
        }
      }
    }

    return null;
  }
}
