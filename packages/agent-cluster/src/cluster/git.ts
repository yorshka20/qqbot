import { spawn } from 'bun';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git and answer whatever it said, failure included. Both pipes drain while it runs, so large output cannot stall it. */
export async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
  const proc = spawn({
    cmd: ['git', ...args],
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run git and answer its trimmed stdout; a non-zero exit throws with what git said. */
export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await runGit(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}
