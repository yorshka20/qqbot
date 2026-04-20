/**
 * Delegates to the same path as agenda action `cluster_tickets_sync`:
 * {@link runClusterTicketsSyncWithRegistry} (ProjectRegistry alias → git sync).
 *
 *   /cluster-sync              → alias `cluster-tickets`
 *   /cluster-sync <alias>      → another registered project path
 */

import { inject, injectable } from 'tsyringe';
import { CLUSTER_TICKETS_REGISTRY_ALIAS, runClusterTicketsSyncWithRegistry } from '@/cluster/clusterTicketsGitSync';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

function textResult(content: string): CommandResult {
  return { success: true, segments: new MessageBuilder().text(content).build() };
}

@Command({
  name: 'cluster-sync',
  description: '同步 cluster-tickets 仓库（路径来自 ProjectRegistry，与 agenda action cluster_tickets_sync 相同）',
  usage: `/cluster-sync [<别名，默认 ${CLUSTER_TICKETS_REGISTRY_ALIAS}>]`,
  permissions: ['owner'],
})
@injectable()
export class ClusterTicketsSyncCommand implements CommandHandler {
  name = 'cluster-sync';
  description = '同步 cluster-tickets 仓库（路径来自 ProjectRegistry，与 agenda action cluster_tickets_sync 相同）';
  usage = `/cluster-sync [<别名，默认 ${CLUSTER_TICKETS_REGISTRY_ALIAS}>]`;

  constructor(@inject(DITokens.PROJECT_REGISTRY) private projectRegistry: ProjectRegistry) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const alias = args[0]?.trim() || undefined;
    const r = await runClusterTicketsSyncWithRegistry(this.projectRegistry, alias);
    if (!r.ok) {
      return { success: false, error: r.message };
    }
    return textResult(`已同步: ${r.path}（${r.alias}）`);
  }
}
