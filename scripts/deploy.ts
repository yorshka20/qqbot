// Deploy — bring the bot up to the latest code: fetch, fast-forward only, install dependencies,
// restart. This is the only path that changes code or dependencies; a restart (crash restart,
// `/restart`, the process manager's restart) runs whatever is checked out. So a crash restart can
// never pull unreviewed code, and a branch that has diverged can never stop the bot from starting.
//
// A deploy is refused before the running bot is touched when the checkout and its upstream have
// diverged, or when a fast-forward would run over uncommitted changes to tracked files. Once the
// bot is stopped, a failure moves the checkout back to the commit it was running and starts it
// there. Dependencies install while the bot is stopped, so nothing holds node_modules open
// (bun EEXIST).
//
// Written in TypeScript rather than shell so it runs on every platform the bot does.
//
// Usage: bun run deploy            update and restart
//        bun run deploy --check    report what a deploy would do; exit 1 if it would be refused

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

class DeployRefused extends Error {}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new DeployRefused(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} exited with ${result.exitCode}`);
  }
}

/** The bot under its process manager (PM2). The one place to change when the manager is replaced. */
const botService = {
  stop: () => run(['pm2', 'stop', 'qq-bot']),
  // Starting the ecosystem resumes the stopped app, or registers it when PM2 has never seen it.
  start: () => run(['pm2', 'start', path.join(ROOT, 'ecosystem.config.cjs')]),
};

type Plan = { pull: false; localCommits: number } | { pull: true; upstream: string; upstreamCommits: number };

function planDeploy(): Plan {
  git('fetch', '--quiet');
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  const upstreamCommits = Number(git('rev-list', '--count', `HEAD..${upstream}`));
  const localCommits = Number(git('rev-list', '--count', `${upstream}..HEAD`));
  if (upstreamCommits === 0) {
    return { pull: false, localCommits };
  }
  if (localCommits > 0) {
    throw new DeployRefused(
      `the checkout and ${upstream} have diverged (${localCommits} local, ${upstreamCommits} upstream commits); reconcile them first`,
    );
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new DeployRefused(
      'uncommitted changes to tracked files would be fast-forwarded over; commit or stash them first',
    );
  }
  return { pull: true, upstream, upstreamCommits };
}

function describe(plan: Plan): string {
  if (plan.pull) {
    return `fast-forward ${plan.upstreamCommits} commit(s) from ${plan.upstream}, install, restart`;
  }
  const local = plan.localCommits > 0 ? ` (${plan.localCommits} local commit(s) not yet pushed)` : '';
  return `nothing to pull${local}; install, restart`;
}

let plan: Plan;
try {
  plan = planDeploy();
} catch (error) {
  console.error(`deploy refused: ${(error as Error).message}`);
  process.exit(1);
}
console.log(`deploy: ${describe(plan)}`);
if (process.argv.includes('--check')) {
  process.exit(0);
}

const running = git('rev-parse', 'HEAD');
botService.stop();
try {
  if (plan.pull) {
    run(['git', 'merge', '--ff-only', plan.upstream]);
  }
  run([process.execPath, 'install']);
} catch (error) {
  // The tree was clean before the fast-forward (planDeploy checks), so resetting loses nothing.
  if (git('rev-parse', 'HEAD') !== running) {
    run(['git', 'reset', '--hard', running]);
  }
  console.error(`deploy failed: ${(error as Error).message}; starting the bot on ${running.slice(0, 8)}`);
  botService.start();
  process.exit(1);
}
botService.start();
console.log(`deploy: done at ${git('rev-parse', '--short', 'HEAD')}`);
