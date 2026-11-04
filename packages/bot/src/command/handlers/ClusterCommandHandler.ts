/**
 * ClusterCommandHandler — QQ commands for Agent Cluster control, over the cluster daemon's HTTP API.
 *
 * Commands:
 *   /cluster                          → status summary
 *   /cluster pause / resume           → pause/resume scheduling
 *   /cluster task <project> "desc"    → submit manual task
 *   /cluster ask list                 → list pending hub_ask requests
 *   /cluster ask answer <id> <text>   → answer a pending hub_ask request
 *   /cluster health [template]        → verify worker template provider credentials
 *   /cluster start / stop             → explain that the daemon is run by the supervisor
 */

import { logger } from '@qqbot/shared';
import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClusterClient } from '@/integrations/agent-cluster/ClusterClient';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

function textResult(content: string): CommandResult {
  return { success: true, segments: new MessageBuilder().text(content).build() };
}

const NOT_CONFIGURED = 'cluster 未配置（config.clusterClient）';
const DAEMON_MANAGED_BY_SUPERVISOR =
  'cluster daemon 由 supervisor 管理，不在 bot 进程内：\n' +
  '  bun run cluster:start | cluster:stop | cluster:restart | cluster:status\n' +
  '调度的暂停/恢复用 /cluster pause 与 /cluster resume';

@Command({
  name: 'cluster',
  description: 'Agent Cluster 控制命令',
  usage: '/cluster [status|pause|resume|task|ask|health]',
  permissions: ['owner'],
})
@injectable()
export class ClusterCommand implements CommandHandler {
  name = 'cluster';
  description = 'Agent Cluster 控制命令';
  usage = '/cluster [status|pause|resume|task|ask|health]';

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const subcommand = args[0]?.toLowerCase() || 'status';
    const client = this.client();
    if (!client) {
      return { success: false, error: NOT_CONFIGURED };
    }

    try {
      switch (subcommand) {
        case 'status':
          return await this.handleStatus(client);
        case 'start':
        case 'stop':
          return textResult(DAEMON_MANAGED_BY_SUPERVISOR);
        case 'pause':
          await client.pause();
          return textResult('Agent Cluster 调度已暂停');
        case 'resume':
          await client.resume();
          return textResult('Agent Cluster 调度已恢复');
        case 'task':
          return await this.handleTask(client, args.slice(1));
        case 'ask':
          return await this.handleAsk(client, args.slice(1), context);
        case 'health':
          return await this.handleHealth(client, args.slice(1));
        default:
          return {
            success: false,
            error: `未知子命令: ${subcommand}\n用法: /cluster [status|pause|resume|task|ask|health]`,
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

  private client(): ClusterClient | null {
    // container-lookup: optional-service the cluster client exists only when clusterClient is configured
    const container = getContainer();
    return container.isRegistered(DITokens.CLUSTER_CLIENT)
      ? container.resolve<ClusterClient>(DITokens.CLUSTER_CLIENT)
      : null;
  }

  private async handleStatus(client: ClusterClient): Promise<CommandResult> {
    const { status } = await client.getStatus();
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

  private async handleAsk(client: ClusterClient, args: string[], context: CommandContext): Promise<CommandResult> {
    const sub = args[0]?.toLowerCase();

    if (sub === 'list' || sub === undefined) {
      const pending = await client.getPendingHelpRequests();
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
      const ok = await client.answerHelpRequest(askId, answer, answeredBy);
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

  private async handleTask(client: ClusterClient, args: string[]): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: '用法: /cluster task <project> <description>',
      };
    }

    const project = args[0];
    const description = args.slice(1).join(' ');
    const task = await client.submitTask(project, description);
    return textResult(`任务已提交: ${task.id}\n项目: ${project}\n描述: ${description}`);
  }

  private async handleHealth(client: ClusterClient, args: string[]): Promise<CommandResult> {
    const results = await client.probeWorkerTemplates(args[0] ? { templates: [args[0]] } : undefined);
    const ok = results.filter((r) => r.ok);
    const lines = [`Worker 凭据检查: ${ok.length}/${results.length} 可用`];
    for (const r of results) {
      const seconds = (r.durationMs / 1000).toFixed(1);
      if (r.ok) {
        const detail = [r.model, r.credentialSource].filter(Boolean).join(' via ');
        lines.push(`  ✓ ${r.templateName} (${r.type}${detail ? `, ${detail}` : ''}, ${seconds}s)`);
      } else {
        lines.push(`  ✗ ${r.templateName} (${r.type}): ${(r.reason ?? 'unknown').slice(0, 160)}`);
      }
    }
    return textResult(lines.join('\n'));
  }
}
