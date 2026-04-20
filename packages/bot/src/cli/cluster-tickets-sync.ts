// Sync the cluster-tickets git repo once. Same logic as agenda `cluster_tickets_sync` and `/cluster-sync`.
//
// Usage:
//   bun run src/cli/cluster-tickets-sync.ts [--alias cluster-tickets]

import 'reflect-metadata';

import { CLUSTER_TICKETS_REGISTRY_ALIAS, runClusterTicketsSyncWithRegistry } from '@/cluster/clusterTicketsGitSync';
import { Config } from '@/core/config';
import { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const alias = getArg('alias');
  const configPath = process.env.CONFIG_PATH;
  const config = configPath ? new Config(configPath) : new Config();
  const registry = new ProjectRegistry(config.getProjectRegistryConfig());

  console.log(`Syncing cluster-tickets repo (alias "${alias ?? CLUSTER_TICKETS_REGISTRY_ALIAS}")...`);
  const r = await runClusterTicketsSyncWithRegistry(registry, alias);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.log(`Done: ${r.path} (${r.alias})`);
}

main();
