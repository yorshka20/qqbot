// TTSManager assembly: a bare TTSManager is only a registry, so the app's instance is built
// here from `tts.providers[]` (or the legacy single-provider shape). The DI factory for
// TTS_MANAGER calls this, so TTSCommandHandler (QQ voice path), AvatarService (renderer
// speech path) and the `speak` tool all get the same provider set.

import type { Config } from '@/core/config';
import type { HealthCheckManager } from '@/core/health';
import { logger } from '@/utils/logger';
import { FishAudioProvider } from './providers/FishAudioProvider';
import { SovitsProvider } from './providers/SovitsProvider';
import { TTSManager } from './TTSManager';
import type { TTSProvider } from './TTSProvider';

export function createTTSManager(config: Config, healthCheckManager: HealthCheckManager): TTSManager {
  const ttsManager = new TTSManager();
  const rawTTS = config.getTTSConfig() as Record<string, unknown> | undefined;
  for (const entry of collectTTSProviderEntries(rawTTS)) {
    try {
      const provider = instantiateTTSProvider(entry);
      if (provider) {
        ttsManager.register(provider);
      } else {
        logger.warn(`[TTSManager] Unknown TTS provider type: ${String(entry.type)} (skipped)`);
      }
    } catch (err) {
      logger.warn(`[TTSManager] TTS provider ${String(entry.name ?? entry.type)} failed to initialize (skipped):`, err);
    }
  }

  const desiredDefault = typeof rawTTS?.defaultProvider === 'string' ? rawTTS.defaultProvider : null;
  if (desiredDefault) {
    try {
      ttsManager.setDefault(desiredDefault);
    } catch (err) {
      logger.warn(
        `[TTSManager] tts.defaultProvider="${desiredDefault}" is not a registered provider; falling back to first registered`,
        err,
      );
    }
  }
  ttsManager.attachHealthManager(healthCheckManager);

  const summary = ttsManager.listAll().map((p) => `${p.name}${p.isAvailable() ? '' : ' (unavailable)'}`);
  if (summary.length > 0) {
    logger.info(`[TTSManager] TTS providers registered: ${summary.join(', ')}`);
  } else {
    logger.debug('[TTSManager] No TTS providers configured');
  }
  return ttsManager;
}

interface TTSProviderEntry {
  type: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Gather provider entries from the raw `tts` config blob.
 *
 * - If `tts.providers` is an array, return it as-is.
 * - Otherwise fall back to the legacy single-provider shape: top-level
 *   `apiKey` + optional `model`/`format`/`voiceMap`/`defaultVoice`/`referenceId`
 *   are synthesized into a single `{ type: 'fish-audio', name: 'fish-audio', … }`
 *   entry. This lets existing configs keep working without migration.
 * - Empty / missing `tts` returns `[]`.
 */
function collectTTSProviderEntries(raw: Record<string, unknown> | undefined): TTSProviderEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw.providers)) {
    return raw.providers.filter((p): p is TTSProviderEntry => typeof p === 'object' && p !== null);
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.length > 0) {
    return [
      {
        type: 'fish-audio',
        name: 'fish-audio',
        apiKey: raw.apiKey,
        model: raw.model,
        format: raw.format,
        voiceMap: raw.voiceMap,
        defaultVoice: raw.defaultVoice ?? raw.referenceId,
      },
    ];
  }
  return [];
}

/**
 * Instantiate a TTSProvider from a config entry. `type` discriminates which
 * concrete provider class to construct. Unknown types return null (caller
 * logs and skips so one bad entry doesn't block the rest).
 */
function instantiateTTSProvider(entry: TTSProviderEntry): TTSProvider | null {
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
  switch (entry.type) {
    case 'fish-audio':
      return new FishAudioProvider({
        name,
        apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
        voiceMap:
          entry.voiceMap && typeof entry.voiceMap === 'object' && !Array.isArray(entry.voiceMap)
            ? (entry.voiceMap as Record<string, string>)
            : {},
        defaultVoice: typeof entry.defaultVoice === 'string' ? entry.defaultVoice : '',
        model: typeof entry.model === 'string' ? entry.model : undefined,
        format: entry.format === 'mp3' || entry.format === 'wav' ? (entry.format as 'mp3' | 'wav') : undefined,
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      });
    case 'sovits':
      return new SovitsProvider({
        name,
        endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : '',
        bodyTemplate:
          entry.bodyTemplate && typeof entry.bodyTemplate === 'object' && !Array.isArray(entry.bodyTemplate)
            ? (entry.bodyTemplate as Record<string, unknown>)
            : {},
        method: entry.method === 'GET' || entry.method === 'POST' ? entry.method : undefined,
        headers:
          entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
            ? (entry.headers as Record<string, string>)
            : undefined,
        defaultVoice: typeof entry.defaultVoice === 'string' ? entry.defaultVoice : undefined,
        pcmSampleRate:
          typeof entry.pcmSampleRate === 'number' && entry.pcmSampleRate > 0 ? entry.pcmSampleRate : undefined,
      });
    default:
      return null;
  }
}
