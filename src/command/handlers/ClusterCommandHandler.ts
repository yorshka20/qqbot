/**
 * ClusterCommandHandler — QQ commands for Agent Cluster control.
 *
 * Commands:
 *   /cluster                          → status summary
 *   /cluster start                    → start cluster
 *   /cluster stop                     → stop cluster
 *   /cluster pause / resume           → pause/resume scheduling
 *   /cluster task <project> "desc"    → submit manual task
 *   /cluster ask list                 → list pending hub_ask requests
 *   /cluster ask answer <id> <text>   → answer a pending hub_ask request
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

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
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
        case 'ask':
          return this.handleAsk(args.slice(1), context);
        default:
          return {
            success: false,
            error: `未知子命令: ${subcommand}\n用法: /cluster [status|start|stop|pause|resume|task|ask]`,
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

  private handleAsk(args: string[], context: CommandContext): CommandResult {
    const sub = args[0]?.toLowerCase();

    if (sub === 'list' || sub === undefined) {
      const pending = this.clusterManager.getPendingHelpRequests();
      if (pending.length === 0) {
        return textResult('当前没有待处理的 hub_ask 请求');
      }
      const lines: string[] = [`待处理 hub_ask 请求 (${pending.length}):`];
      for (const req of pending) {
        // Truncate long questions to keep the QQ message readable.
        const q = req.question.length > 200 ? `${req.question.slice(0, 200)}…` : req.question;
        lines.push('', `askId: ${req.id}`);
        lines.push(`worker: ${req.workerId}${req.taskId ? ` (task=${req.taskId})` : ''}`);
        lines.push(`type: ${req.type}`);
        lines.push(`问题: ${q}`);
        if (req.options && req.options.length > 0) {
          lines.push('选项:');
          req.options.forEach((opt, i) => {
            lines.push(`  ${i + 1}. ${opt}`);
          });
        }
      }
      lines.push('', '回复: /cluster ask answer <askId> <答复内容>');
      return textResult(lines.join('\n'));
    }

    if (sub === 'answer') {
      const askId = args[1];
      const answer = args.slice(2).join(' ').trim();
      if (!askId || !answer) {
        return {
          success: false,
          error: '用法: /cluster ask answer <askId> <答复内容>',
        };
      }
      // Stamp `answeredBy` with the QQ user id of the operator so the
      // worker (and audit log / WebUI) sees who actually replied. Owner
      // permissions are already enforced at the command-decorator level
      // (`permissions: ['owner']`).
      const answeredBy = `qq:${context.userId}`;
      const ok = this.clusterManager.answerHelpRequest(askId, answer, answeredBy);
      if (!ok) {
        return {
          success: false,
          error: `未找到 askId=${askId} 的待处理请求（已应答 / 已过期 / 不存在）`,
        };
      }
      return textResult(`已应答 askId=${askId}`);
    }

    return {
      success: false,
      error: '用法: /cluster ask [list|answer <id> <text>]',
    };
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
