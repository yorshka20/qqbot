import type { AvatarConfig } from './types';
import { DEFAULT_AVATAR_CONFIG } from './types';

/**
 * Merge a raw (JSONC-parsed, possibly partial) avatar config onto the package
 * defaults. Kept in the avatar package so the host bot only has to forward
 * `config.avatar` verbatim — schema & defaults live next to the consumers.
 *
 * `raw` is the untyped blob from `config.getAvatarConfig()`. Unknown top-level
 * keys are ignored; unknown sub-keys pass through via the per-section spread.
 */
export function mergeAvatarConfig(raw: Record<string, unknown> | undefined): AvatarConfig {
  return {
    enabled: (raw?.enabled as boolean | undefined) ?? DEFAULT_AVATAR_CONFIG.enabled,
    vts: { ...DEFAULT_AVATAR_CONFIG.vts, ...((raw?.vts as object | undefined) ?? {}) },
    compiler: {
      ...DEFAULT_AVATAR_CONFIG.compiler,
      ...((raw?.compiler as object | undefined) ?? {}),
      layers: {
        ...(DEFAULT_AVATAR_CONFIG.compiler.layers ?? { enabled: true }),
        ...((raw?.compiler as { layers?: object } | undefined)?.layers ?? {}),
      },
    },
    idle: { ...DEFAULT_AVATAR_CONFIG.idle, ...((raw?.idle as object | undefined) ?? {}) },
    preview: { ...DEFAULT_AVATAR_CONFIG.preview, ...((raw?.preview as object | undefined) ?? {}) },
    actionMap: { ...DEFAULT_AVATAR_CONFIG.actionMap, ...((raw?.actionMap as object | undefined) ?? {}) },
  };
}
