// LocalAudioService — makes sound come out of the machine the bot runs on (macOS
// `say` / `afplay`), for spoken reminders and audible announcements.
//
// This is deliberately NOT a command runner like ReadOnlyShellService. The two
// programs are fixed, and no caller-supplied token is ever interpreted as a flag:
// the sound is a *name* looked up against the system sound directory (so the path
// is derived, never passed in), and the spoken text goes after `--` as a single
// argv element. That is what keeps `say -o` (writes an audio file anywhere) and
// `say -f` (reads an arbitrary file aloud) structurally unreachable rather than
// denylisted.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { logger } from '@/utils/logger';

const SYSTEM_SOUND_DIR = '/System/Library/Sounds';
const SOUND_EXT = '.aiff';

/**
 * `say` returns only once the utterance finishes, so this budget is a speech
 * duration, not a hang threshold — it has to clear MAX_SPEAK_CHARS read aloud.
 */
const SPEAK_TIMEOUT_MS = 45_000;
const SOUND_TIMEOUT_MS = 10_000;

export const MAX_SPEAK_CHARS = 160;

export interface LocalAudioResult {
  success: boolean;
  error?: string;
}

export class LocalAudioService {
  constructor(private readonly soundDir: string = SYSTEM_SOUND_DIR) {}

  /** `say` / `afplay` are macOS-only; elsewhere the capability does not exist. */
  static isSupported(): boolean {
    return process.platform === 'darwin';
  }

  listSounds(): string[] {
    try {
      return readdirSync(this.soundDir)
        .filter((f) => f.endsWith(SOUND_EXT))
        .map((f) => basename(f, SOUND_EXT))
        .sort();
    } catch (error) {
      logger.warn(`[LocalAudioService] cannot read sound dir ${this.soundDir}:`, error);
      return [];
    }
  }

  resolveSound(name: string): string | null {
    const wanted = name.trim().toLowerCase();
    return this.listSounds().find((s) => s.toLowerCase() === wanted) ?? null;
  }

  async playSound(name: string): Promise<LocalAudioResult> {
    const resolved = this.resolveSound(name);
    if (!resolved) {
      const available = this.listSounds();
      return {
        success: false,
        error: `未知提示音：${name}${available.length ? `。可用：${available.join(' / ')}` : ''}`,
      };
    }
    return this.run('afplay', [join(this.soundDir, `${resolved}${SOUND_EXT}`)], SOUND_TIMEOUT_MS);
  }

  async speak(text: string): Promise<LocalAudioResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { success: false, error: '要念的文本为空' };
    }
    if (trimmed.length > MAX_SPEAK_CHARS) {
      return { success: false, error: `文本过长（${trimmed.length} 字），上限 ${MAX_SPEAK_CHARS} 字` };
    }
    return this.run('say', ['--', trimmed], SPEAK_TIMEOUT_MS);
  }

  private run(bin: string, args: string[], timeoutMs: number): Promise<LocalAudioResult> {
    return new Promise((resolve) => {
      // Async spawn, not spawnSync: an utterance occupies the whole budget, and
      // blocking the event loop that long would stall every protocol connection.
      const child = spawn(bin, args, {
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
        },
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ success: false, error: `${bin} 超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);

      child.once('error', (error) => {
        clearTimeout(timer);
        logger.warn(`[LocalAudioService] spawn failed: ${bin}`, error);
        resolve({ success: false, error: error.message });
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { success: true } : { success: false, error: `${bin} 退出码 ${code}` });
      });
    });
  }
}
