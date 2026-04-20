// ClusterTicketsGitHandlers — direct git sync for the cluster-tickets repo path from ProjectRegistry.
// No LLM; schedule: `执行: action cluster_tickets_sync`
// Optional `actionParams`: JSON `{"alias":"other"}` (default alias: cluster-tickets).

import { runClusterTicketsSyncWithRegistry } from '@/cluster/clusterTicketsGitSync';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

export class ClusterTicketsSyncHandler implements ActionHandler {
  readonly name = 'cluster_tickets_sync';

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

    const registry = getContainer().resolve<ProjectRegistry>(DITokens.PROJECT_REGISTRY);
    const r = await runClusterTicketsSyncWithRegistry(registry, alias);
    if (!r.ok) {
      return r.message;
    }
    return undefined;
  }
}
