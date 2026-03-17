// QualityCheckExecutor - runs code quality checks (typecheck, lint, test, build)

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ToolDefinition, ToolExecuteResult } from '../../mcpServer/types';
import { BaseToolExecutor } from '../types';

type CheckType = 'typecheck' | 'lint' | 'test' | 'build' | 'all';

interface CheckResult {
  check: string;
  success: boolean;
  output: string;
  exitCode: number;
}

export class QualityCheckExecutor extends BaseToolExecutor {
  name = 'quality_check';

  definition: ToolDefinition = {
    name: 'quality_check',
    description: '运行代码质量检查。包括类型检查、lint、测试。',
    parameters: {
      checks: {
        type: 'array',
        required: false,
        description: '要执行的检查类型: typecheck/lint/test/build/all。默认 all。',
        enum: ['typecheck', 'lint', 'test', 'build', 'all'],
      },
      fix: {
        type: 'boolean',
        required: false,
        description: '是否自动修复可修复的问题（仅 lint）。默认 false。',
      },
      testPattern: {
        type: 'string',
        required: false,
        description: '测试文件匹配模式。仅 test 时有效。',
      },
    },
    examples: [
      'quality_check checks=["typecheck", "lint"]',
      'quality_check checks=["lint"] fix=true',
      'quality_check checks=["test"] testPattern="auth"',
      'quality_check checks=["all"]',
    ],
    whenToUse: '在提交代码前或 PR 创建前，确保代码质量符合项目标准。',
  };

  constructor(private workingDirectory: string) {
    super();
  }

  async execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult> {
    const rawChecks = parameters.checks as CheckType[] | CheckType | undefined;
    const fix = (parameters.fix as boolean | undefined) ?? false;
    const testPattern = parameters.testPattern as string | undefined;

    // Normalize checks parameter
    let checks: CheckType[];
    if (!rawChecks) {
      checks = ['all'];
    } else if (Array.isArray(rawChecks)) {
      checks = rawChecks;
    } else {
      checks = [rawChecks];
    }

    // Expand 'all'
    if (checks.includes('all')) {
      checks = ['typecheck', 'lint', 'test', 'build'];
    }

    logger.info(`[QualityCheckExecutor] Running checks: ${checks.join(', ')}`);

    const results: CheckResult[] = [];

    for (const check of checks) {
      const result = await this.runCheck(check, fix, testPattern);
      results.push(result);
    }

    const allPassed = results.every((r) => r.success);
    const failed = results.filter((r) => !r.success);

    const summary = results.map((r) => `${r.success ? '✓' : '✗'} ${r.check}`).join('\n');

    if (allPassed) {
      return this.success(`All checks passed:\n${summary}`, { results, passed: results.length });
    }

    const failedDetails = failed.map((r) => `=== ${r.check} (exit ${r.exitCode}) ===\n${r.output}`).join('\n\n');

    return {
      success: false,
      message: `${failed.length}/${results.length} checks failed:\n${summary}`,
      error: failedDetails,
      data: { results, passed: results.length - failed.length, failed: failed.length },
    };
  }

  private async runCheck(check: CheckType, fix: boolean, testPattern?: string): Promise<CheckResult> {
    let cmd: string[];

    switch (check) {
      case 'typecheck':
        cmd = ['bun', 'run', 'typecheck'];
        break;
      case 'lint':
        cmd = fix ? ['bun', 'run', 'lint:fix'] : ['bun', 'run', 'lint'];
        break;
      case 'test':
        cmd = testPattern ? ['bun', 'test', testPattern] : ['bun', 'test'];
        break;
      case 'build':
        cmd = ['bun', 'run', 'build'];
        break;
      default:
        return { check, success: false, output: `Unknown check type: ${check}`, exitCode: 1 };
    }

    logger.debug(`[QualityCheckExecutor] Running: ${cmd.join(' ')}`);

    const proc = spawn({
      cmd,
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();

    return { check, success: exitCode === 0, output, exitCode };
  }
}
