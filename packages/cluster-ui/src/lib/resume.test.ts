import { describe, expect, test } from 'bun:test';
import { resumeCommand } from './resume';

describe('resumeCommand', () => {
  test('claude and codex each resume their own way, from the project', () => {
    expect(resumeCommand('claude-cli', 'abc', '/srv/demo')).toBe('cd /srv/demo && claude --resume abc');
    expect(resumeCommand('codex-cli', 'abc', '/srv/demo')).toBe('cd /srv/demo && codex exec resume abc');
  });

  test('a path with a space is quoted', () => {
    expect(resumeCommand('claude-cli', 'abc', '/srv/my demo')).toBe("cd '/srv/my demo' && claude --resume abc");
  });

  test('nothing to offer without a session or for a backend with no resume', () => {
    expect(resumeCommand('claude-cli', undefined)).toBeNull();
    expect(resumeCommand('gemini-cli', 'abc')).toBeNull();
  });
});
