/**
 * ClaudeCliBackend — spawns Claude Code CLI as worker processes.
 *
 * Extracted from ClaudeToolManager.executeTask pattern.
 */

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { WorkerBackend, WorkerSpawnConfig } from '../types';

export class ClaudeCliBackend implements WorkerBackend {
  name = 'claude-cli';

  constructor(
    private command: string = 'claude',
    private baseArgs: string[] = ['--print', '--dangerously-skip-permissions', '--output-format', 'text'],
  ) {}

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    const args = [...this.baseArgs, config.taskPrompt];

    logger.info(`[ClaudeCliBackend] Spawning worker ${config.workerId}: ${this.command} (cwd: ${config.projectPath})`);

    const proc = spawn({
      cmd: [this.command, ...args],
      cwd: config.projectPath,
      env: {
        ...process.env,
        ...config.env,
        CLUSTER_WORKER_ID: config.workerId,
        CLUSTER_HUB_URL: config.env.CLUSTER_HUB_URL || '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return proc;
  }
}
