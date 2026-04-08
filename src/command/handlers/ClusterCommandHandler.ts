/**
 * ClusterCommandHandler — QQ commands for Agent Cluster control.
 *
 * Commands:
 *   /cluster                       → status summary
 *   /cluster start                 → start cluster
 *   /cluster stop                  → stop cluster
 *   /cluster pause / resume        → pause/resume scheduling
 *   /cluster task <project> "desc" → submit manual task
 */

import { inject, injectable } from 'tsyringe';
import type { ClusterManager } from '@/cluster/ClusterManager';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

function textResult(content: string): CommandResult {
  return { success: true, segments: new MessageBuilder().text(content).build() };
}

@Command({
  name: 'cluster',
  description: 'Agent Cluster 控制命令',
  usage: '/cluster [status|start|stop|pause|resume|task]',
  permissions: ['owner'],
})
@injectable()
export class ClusterCommand implements CommandHandler {
  name = 'cluster';
  description = 'Agent Cluster 控制命令';
  usage = '/cluster [status|start|stop|pause|resume|task]';

  constructor(@inject(DITokens.CLUSTER_MANAGER) private clusterManager: ClusterManager) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    try {
      switch (subcommand) {
        case 'status':
          return this.handleStatus();
        case 'start':
          return this.handleStart();
        case 'stop':
          return this.handleStop();
        case 'pause':
          return this.handlePause();
        case 'resume':
          return this.handleResume();
        case 'task':
          return this.handleTask(args.slice(1));
        default:
          return {
            success: false,
            error: `未知子命令: ${subcommand}\n用法: /cluster [status|start|stop|pause|resume|task]`,
          };
      }
    } catch (err) {
      logger.error('[ClusterCommand] Error:', err);
      return {
        success: false,
        error: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private handleStatus(): CommandResult {
    const status = this.clusterManager.getStatus();
    const lines = [
      `Agent Cluster ${status.running ? '运行中' : '已停止'}${status.paused ? ' (已暂停)' : ''}`,
      `Workers: ${status.activeWorkers} active, ${status.idleWorkers} idle`,
      `Tasks: ${status.runningTasks} running, ${status.pendingTasks} pending`,
    ];

    if (status.workers.length > 0) {
      lines.push('', '--- Workers ---');
      for (const w of status.workers) {
        const uptimeMin = Math.round(w.uptime / 60_000);
        lines.push(`  ${w.id} [${w.template}] ${w.project} - ${w.status} (${uptimeMin}min)`);
        if (w.currentTaskDescription) {
          lines.push(`    ${w.currentTaskDescription.slice(0, 60)}`);
        }
      }
    }

    return textResult(lines.join('\n'));
  }

  private async handleStart(): Promise<CommandResult> {
    if (this.clusterManager.isStarted()) {
      return textResult('Agent Cluster 已在运行中');
    }
    await this.clusterManager.start();
    return textResult('Agent Cluster 已启动');
  }

  private async handleStop(): Promise<CommandResult> {
    if (!this.clusterManager.isStarted()) {
      return textResult('Agent Cluster 未在运行');
    }
    await this.clusterManager.stop();
    return textResult('Agent Cluster 已停止');
  }

  private handlePause(): CommandResult {
    this.clusterManager.pause();
    return textResult('Agent Cluster 调度已暂停');
  }

  private handleResume(): CommandResult {
    this.clusterManager.resume();
    return textResult('Agent Cluster 调度已恢复');
  }

  private async handleTask(args: string[]): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: '用法: /cluster task <project> <description>',
      };
    }

    const project = args[0];
    const description = args.slice(1).join(' ');

    const task = await this.clusterManager.submitTask(project, description);
    if (!task) {
      return { success: false, error: `任务创建失败（项目 "${project}" 不存在？）` };
    }

    return textResult(`任务已提交: ${task.id}\n项目: ${project}\n描述: ${description}`);
  }
}
