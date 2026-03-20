// ExecuteCodeToolExecutor - allows LLM to write and execute JavaScript code

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../../decorators';
import type { ToolManager } from '../../ToolManager';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../../types';
import { BaseToolExecutor } from '../BaseToolExecutor';
import { CodeSandbox } from './CodeSandbox';
import { SandboxContext } from './SandboxContext';
import type { SandboxConfig } from './types';
import { DEFAULT_SANDBOX_CONFIG } from './types';

@Tool({
  name: 'execute_code',
  description:
    '执行一段 JavaScript 代码并返回结果。代码在沙箱环境中运行，可以通过 `tools` 对象调用其他工具（如 `await tools.search({ query: "..." })`）。支持 async/await、fetch、JSON 处理等。适用于需要数据处理、计算、多步骤编排或灵活组合多个工具的场景。',
  executor: 'execute_code',
  visibility: ['reply', 'subagent'],
  parameters: {
    code: {
      type: 'string',
      required: true,
      description:
        'JavaScript 代码字符串。可以使用 await，通过 tools.xxx() 调用其他工具，通过 console.log() 输出中间结果。最后一个表达式的值或 return 的值将作为结果返回。',
    },
    timeout: {
      type: 'number',
      required: false,
      description: '执行超时时间（毫秒），默认 10000。最大 30000。',
    },
  },
  examples: ['帮我写代码搜索三个关键词并汇总结果', '用代码分析一下这些数据', '并行调用多个工具然后合并结果'],
  triggerKeywords: ['执行代码', '写代码', 'execute', 'code', '计算', '编程'],
  whenToUse:
    '当你需要进行复杂数据处理、数学计算、组合调用多个工具（尤其是并行调用）、或者用代码逻辑来编排多步骤任务时使用。不要用于简单的单个工具调用——直接调用对应工具即可。',
})
@injectable()
export class ExecuteCodeToolExecutor extends BaseToolExecutor {
  name = 'execute_code';

  private static readonly MAX_TIMEOUT_MS = 30_000;

  constructor(@inject(DITokens.TOOL_MANAGER) private toolManager: ToolManager) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const code = call.parameters?.code as string | undefined;
    if (!code?.trim()) {
      return this.error('请提供要执行的代码', 'Missing required parameter: code');
    }

    const timeoutMs = this.resolveTimeout(call.parameters?.timeout as number | undefined);
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, timeoutMs };

    logger.info(`[ExecuteCodeToolExecutor] Executing code (timeout: ${timeoutMs}ms, length: ${code.length})`);

    // Build sandbox context with tool wrappers
    const sandboxContext = new SandboxContext(this.toolManager, context, config);
    const globals = sandboxContext.buildGlobals();

    // Execute in sandbox
    const sandbox = new CodeSandbox(config);
    const result = await sandbox.execute(code, globals);

    // Merge console output from context
    result.consoleOutput = sandboxContext.getConsoleLogs();

    // Format the response
    return this.formatResult(result, config);
  }

  private resolveTimeout(requested: number | undefined): number {
    if (requested == null) return DEFAULT_SANDBOX_CONFIG.timeoutMs;
    return Math.min(Math.max(requested, 1000), ExecuteCodeToolExecutor.MAX_TIMEOUT_MS);
  }

  private formatResult(
    result: {
      success: boolean;
      returnValue?: unknown;
      consoleOutput: string[];
      error?: string;
      executionTimeMs: number;
    },
    config: SandboxConfig,
  ): ToolResult {
    const parts: string[] = [];

    // Console output
    if (result.consoleOutput.length > 0) {
      parts.push('=== Console Output ===');
      parts.push(result.consoleOutput.join('\n'));
    }

    if (result.success) {
      // Return value
      if (result.returnValue !== undefined && result.returnValue !== null) {
        parts.push('=== Return Value ===');
        const serialized =
          typeof result.returnValue === 'string' ? result.returnValue : JSON.stringify(result.returnValue, null, 2);
        parts.push(serialized);
      }
      parts.push(`\n(executed in ${result.executionTimeMs}ms)`);

      let output = parts.join('\n');
      if (output.length > config.maxOutputLength) {
        output = `${output.slice(0, config.maxOutputLength)}\n... (output truncated)`;
      }

      return this.success(output, {
        returnValue: result.returnValue,
        consoleOutput: result.consoleOutput,
        executionTimeMs: result.executionTimeMs,
      });
    }

    // Error case
    parts.push('=== Error ===');
    parts.push(result.error ?? 'Unknown error');
    if (result.consoleOutput.length > 0) {
      parts.push(`\n(partial console output above, failed after ${result.executionTimeMs}ms)`);
    } else {
      parts.push(`\n(failed after ${result.executionTimeMs}ms)`);
    }

    return this.error(parts.join('\n'), result.error ?? 'Code execution failed');
  }
}
