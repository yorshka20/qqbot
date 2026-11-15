// Sync the knowledge-base git repo once: commit local changes, rebase onto the remote, push.
// Same logic as the agenda action `kb_sync`.
//
// Usage:
//   bun run kb:sync [<path inside the kb, or a _kb link>]   (default: this checkout's _kb)

import { KNOWLEDGE_BASE_LINK, syncKnowledgeBase } from '@qqbot/agent-cluster';
import { fromRepoRoot } from '@qqbot/shared';

async function main(): Promise<void> {
  const path = process.argv[2] ?? fromRepoRoot(KNOWLEDGE_BASE_LINK);
  const result = await syncKnowledgeBase(path);
  if (!result.ok) {
    console.error(`kb sync failed: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `kb synced: ${result.root} — committed ${result.committed}, pulled ${result.pulled}, pushed ${result.pushed}`,
  );
}

main();
