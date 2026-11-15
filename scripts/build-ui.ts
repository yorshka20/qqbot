// Build the web UIs and install each where its server serves it from: the admin WebUI into the
// bot's `webuiDir()`, the cluster console into the daemon's `clusterConsoleDir()`. Both servers
// look the directory up per request, so an install needs no restart. `bun run deploy` runs this
// for every UI; `bun run deploy --app <ui>` and `bun run build:<ui>` for one.
//
// A build goes to a staging directory first and is swapped in whole: vite empties its output
// directory before writing, and asset names are content-hashed, so building in place would serve
// a half-written UI and copying over would keep every past bundle.
//
// Usage: bun run scripts/build-ui.ts [webui] [cluster-ui]    (no name: both)

import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getRepoRoot } from '@qqbot/shared';
import {
  clusterConsoleDir,
  defaultClusterDaemonConfigPath,
  loadClusterDaemonConfig,
} from '../packages/agent-cluster/src/daemon/config';
import { webuiDir } from '../packages/bot/src/services/staticServer/webuiDir';

interface WebUi {
  packageDir: string;
  installDir: () => string;
}

export const WEB_UIS = {
  webui: { packageDir: 'packages/webui', installDir: webuiDir },
  'cluster-ui': {
    packageDir: 'packages/cluster-ui',
    installDir: () => clusterConsoleDir(loadClusterDaemonConfig(defaultClusterDaemonConfigPath())),
  },
} satisfies Record<string, WebUi>;

export type WebUiName = keyof typeof WEB_UIS;

export const WEB_UI_NAMES = Object.keys(WEB_UIS).sort() as WebUiName[];

export function isWebUiName(name: string): name is WebUiName {
  return Object.hasOwn(WEB_UIS, name);
}

/**
 * Build one UI into its staging directory; the answer swaps it in. Throws when the build fails,
 * leaving the installed UI as it was. Building everything before swapping anything is what
 * keeps a failed deploy from leaving one UI ahead of the code it rolls back to.
 */
export function stageWebUi(name: WebUiName): () => string {
  const ui: WebUi = WEB_UIS[name];
  const target = ui.installDir();
  const staging = `${target}.next`;
  const previous = `${target}.prev`;
  rmSync(staging, { recursive: true, force: true });
  const build = Bun.spawnSync([process.execPath, 'run', 'vite', 'build', '--outDir', staging, '--emptyOutDir'], {
    cwd: join(getRepoRoot(), ui.packageDir),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (build.exitCode !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`building ${name} exited with ${build.exitCode}`);
  }
  return () => {
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(target)) {
      renameSync(target, previous);
    }
    renameSync(staging, target);
    rmSync(previous, { recursive: true, force: true });
    return target;
  };
}

/** Build every named UI, then install them all; nothing is swapped in unless every build passed. */
export function buildWebUis(names: readonly WebUiName[]): string[] {
  const installs = names.map(stageWebUi);
  return installs.map((install) => install());
}

if (import.meta.main) {
  const names = process.argv.slice(2);
  const unknown = names.filter((name) => !isWebUiName(name));
  if (unknown.length > 0) {
    console.error(`unknown UI ${unknown.join(', ')}; one of ${WEB_UI_NAMES.join(', ')}`);
    process.exit(1);
  }
  for (const dir of buildWebUis(names.length > 0 ? (names as WebUiName[]) : WEB_UI_NAMES)) {
    console.log(`installed ${dir}`);
  }
}
