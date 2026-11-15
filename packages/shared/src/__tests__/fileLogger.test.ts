// The file logger runs in a child process: the test run itself has NO_FILE_LOG set, and the
// logger is built once, when it is imported.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOGGER = join(import.meta.dir, '..', 'logger.ts');

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'qqbot-file-logger-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

function run(script: string): string {
  const env: Record<string, string> = { ...process.env, QQBOT_LOGS_DIR: logsDir, LOG_LEVEL: 'info' } as Record<
    string,
    string
  >;
  delete env.NO_FILE_LOG;
  env.NO_CONSOLE_LOG = '1';
  const result = Bun.spawnSync([process.execPath, '-e', `import * as log from ${JSON.stringify(LOGGER)};\n${script}`], {
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}

const logFiles = () => readdirSync(logsDir, { recursive: true }).filter((name) => String(name).endsWith('.log'));

describe('FileLogger', () => {
  it('leaves no file behind in a process that never logs, or only below its level', () => {
    run("log.logger.debug('below info');");
    expect(logFiles()).toEqual([]);
  });

  it('opens one file at the first entry and tells a listener its path', () => {
    const heard = run(
      "log.onLogFile((path) => console.log(path)); log.logger.info('first'); log.logger.warn('second');",
    ).trim();
    const files = logFiles();
    expect(files).toHaveLength(1);
    expect(heard).toBe(join(logsDir, String(files[0])));
    const content = readFileSync(heard, 'utf8');
    expect(content).toContain('[INFO] first');
    expect(content).toContain('[WARN] second');
  });
});
