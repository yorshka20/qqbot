import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAudioService, MAX_SPEAK_CHARS } from '../LocalAudioService';

// A stand-in sound directory keeps the catalog assertions independent of whatever
// /System/Library/Sounds happens to hold on the machine running the suite.
const soundDir = mkdtempSync(join(tmpdir(), 'local-audio-'));
mkdirSync(soundDir, { recursive: true });
for (const name of ['Tink.aiff', 'Glass.aiff', 'Basso.aiff', 'notes.txt']) {
  writeFileSync(join(soundDir, name), '');
}
const service = new LocalAudioService(soundDir);

afterAll(() => {
  rmSync(soundDir, { recursive: true, force: true });
});

describe('LocalAudioService — sound catalog', () => {
  it('lists .aiff basenames alphabetically and ignores other files', () => {
    expect(service.listSounds()).toEqual(['Basso', 'Glass', 'Tink']);
  });

  it('resolves a sound name case-insensitively', () => {
    expect(service.resolveSound('glass')).toBe('Glass');
    expect(service.resolveSound('  TINK ')).toBe('Tink');
  });

  it('does not resolve an unknown name', () => {
    expect(service.resolveSound('Nope')).toBeNull();
  });

  it('reports an empty catalog instead of throwing when the directory is missing', () => {
    expect(new LocalAudioService(join(soundDir, 'absent')).listSounds()).toEqual([]);
  });

  it('rejects a path traversal dressed up as a sound name', async () => {
    const result = await service.playSound('../../../etc/passwd');
    expect(result.success).toBe(false);
    expect(result.error).toContain('未知提示音');
  });
});

describe('LocalAudioService — speech validation', () => {
  it('rejects blank text', async () => {
    const result = await service.speak('   ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('为空');
  });

  it('rejects text over the character cap', async () => {
    const result = await service.speak('提'.repeat(MAX_SPEAK_CHARS + 1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('过长');
  });
});
