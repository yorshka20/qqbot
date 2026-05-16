// Deterministic lifetime ownership for MCP stdio child-process subtrees.
//
// The MCP SDK's StdioClientTransport spawns the server via `bunx -y <pkg>`,
// producing a subtree (bunx -> node <pkg>) inside the bot's own process group.
// The SDK's close() signals only the DIRECT child (bunx), so the node
// grandchild is orphaned even on the graceful path; and close() runs last in
// the shutdown chain, so any earlier hang/throw — or a SIGKILL — leaves the
// whole subtree reparented to init (ppid=1) permanently. This module makes the
// bot the explicit owner: every spawned root pid is tracked and its entire
// descendant tree is killed early on shutdown and synchronously on exit.

import { execFileSync } from 'node:child_process';
import { logger } from '@/utils/logger';

const liveChildPids = new Set<number>();
let exitHandlerInstalled = false;

function listChildPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 when a pid has no children — that is not an error here.
    return [];
  }
}

// Leaves-first so a parent cannot observe a half-dead tree and act on it.
function collectTree(pid: number, acc: number[]): void {
  for (const child of listChildPids(pid)) {
    collectTree(child, acc);
  }
  acc.push(pid);
}

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// MCP search servers are stateless, so the grace window before SIGKILL is
// short — it must also stay under PM2's default kill_timeout (1600ms) so the
// children are reaped before PM2 SIGKILLs the bot itself.
async function killTree(pid: number, graceMs = 800): Promise<void> {
  const tree: number[] = [];
  collectTree(pid, tree);
  for (const p of tree) signalPid(p, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!tree.some(isAlive)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const p of tree) if (isAlive(p)) signalPid(p, 'SIGKILL');
}

// Synchronous best-effort kill for the process 'exit' handler, where no async
// work can run. Goes straight to SIGKILL — there is no time to wait.
function killTreeSync(pid: number): void {
  const tree: number[] = [];
  collectTree(pid, tree);
  for (const p of tree) signalPid(p, 'SIGKILL');
}

export function registerMcpChild(pid: number): void {
  liveChildPids.add(pid);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once('exit', () => {
      for (const p of liveChildPids) killTreeSync(p);
    });
  }
}

export function unregisterMcpChild(pid: number): void {
  liveChildPids.delete(pid);
}

/** Kill one tracked MCP subtree and stop tracking it. */
export async function killMcpChild(pid: number): Promise<void> {
  await killTree(pid);
  liveChildPids.delete(pid);
}

/** Kill every tracked MCP subtree. Called first in the shutdown sequence. */
export async function killAllMcpChildren(): Promise<void> {
  await Promise.all([...liveChildPids].map(killMcpChild));
}

/**
 * Edge-case layer (NOT a root fix): a bot killed with SIGKILL (OOM, `kill -9`,
 * `pm2 delete --force`) cannot run any in-process cleanup, so its MCP subtree
 * is reparented to init. On the next boot the bot reclaims its own kind of
 * orphan before spawning a fresh one — the standard supervisor-restart
 * reclamation pattern for "the supervisor itself may die uncleanly". It is
 * intentionally narrow: it matches the MCP package name AND ppid==1, so a live
 * bot's healthy child (whose ppid is that live bot) is never touched.
 * Follow-up: drop this once the MCP SDK supports detached/process-group spawn
 * so PM2 can own subtree teardown directly.
 */
export function reapOrphanedMcpChildren(packageName: string): void {
  let pids: number[] = [];
  try {
    const out = execFileSync('pgrep', ['-P', '1', '-f', packageName], { encoding: 'utf8' });
    pids = out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return; // none orphaned
  }
  if (pids.length === 0) return;
  logger.warn(
    `[mcpChildReaper] Reaping ${pids.length} orphaned "${packageName}" process(es) from a previous unclean exit: ${pids.join(', ')}`,
  );
  for (const p of pids) {
    const tree: number[] = [];
    collectTree(p, tree);
    for (const t of tree) signalPid(t, 'SIGKILL');
  }
}
