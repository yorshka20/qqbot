// ClusterTicketsGitHandlers — direct git sync for the cluster-tickets repo path from ProjectRegistry.
// No LLM; schedule: `执行: action cluster_tickets_sync`
// Optional `actionParams`: JSON `{"alias":"other"}` (default alias: cluster-tickets).

import { inject, injectable } from 'tsyringe';
import { runClusterTicketsSyncWithRegistry } from '@/cluster/clusterTicketsGitSync';
import { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

@injectable()
export class ClusterTicketsSyncHandler implements ActionHandler {
  readonly name = 'cluster_tickets_sync';

  constructor(@inject(ProjectRegistry) private readonly projectRegistry: ProjectRegistry) {}

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    let alias: string | undefined;
    const raw = ctx.item.actionParams?.trim();
    if (raw) {
      try {
        const p = JSON.parse(raw) as { alias?: string };
        if (typeof p.alias === 'string' && p.alias.trim()) {
          alias = p.alias.trim();
        }
      } catch {
        // ignore invalid JSON
      }
    }

    const r = await runClusterTicketsSyncWithRegistry(this.projectRegistry, alias);
    if (!r.ok) {
      return r.message;
    }
    return undefined;
  }
}
