/**
 * Build the cluster console and install it where the daemon serves it from:
 * `<stateDir>/ui`, with stateDir from `$CLUSTER_STATE_DIR` (default `data/cluster`, as in
 * `cluster.example.jsonc`). The daemon looks the directory up per request, so no restart is needed.
 */

import { cpSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const stateDir = resolve(repoRoot, process.env.CLUSTER_STATE_DIR || 'data/cluster');
const dist = join(repoRoot, 'packages/cluster-ui/dist');
const ui = join(stateDir, 'ui');
const staging = join(stateDir, 'ui.next');

const build = Bun.spawnSync(['bun', 'run', '--filter', '@qqbot/cluster-ui', 'build'], {
  cwd: repoRoot,
  stdio: ['inherit', 'inherit', 'inherit'],
});
if (build.exitCode !== 0) {
  process.exit(build.exitCode);
}

// Asset names are content-hashed, so copying over the old build would keep every past bundle.
rmSync(staging, { recursive: true, force: true });
cpSync(dist, staging, { recursive: true });
rmSync(ui, { recursive: true, force: true });
renameSync(staging, ui);
console.log(`cluster-ui installed to ${ui}`);
