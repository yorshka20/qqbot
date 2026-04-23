import type { CompilerConfig } from './compiler/types';
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
  const r = isRecord(raw) ? raw : {};

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_AVATAR_CONFIG.enabled,
    vts: mergeObject(DEFAULT_AVATAR_CONFIG.vts, r.vts),
    compiler: mergeCompilerConfig(r),
    idle: mergeObject(DEFAULT_AVATAR_CONFIG.idle, r.idle),
    preview: mergeObject(DEFAULT_AVATAR_CONFIG.preview, r.preview),
    actionMap: mergeObject(DEFAULT_AVATAR_CONFIG.actionMap, r.actionMap),
    speech: mergeObject(DEFAULT_AVATAR_CONFIG.speech, r.speech),
    llmProvider: optionalNonEmptyString(r.llmProvider),
    llmStream: r.llmStream === true,
    llmReasoningEffort: coerceReasoningEffort(r.llmReasoningEffort) ?? DEFAULT_AVATAR_CONFIG.llmReasoningEffort,
  };
}

const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high'] as const;
type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

function coerceReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(value) ? (value as ReasoningEffort) : undefined;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Shallow merge: defaults plus optional patch when patch is a plain object. */
function mergeObject<T extends object>(base: T, patch: unknown): T {
  if (!isRecord(patch)) {
    return { ...base };
  }
  return { ...base, ...patch } as T;
}

function mergeCompilerConfig(raw: Record<string, unknown>): CompilerConfig {
  const base = DEFAULT_AVATAR_CONFIG.compiler;
  const patch = isRecord(raw.compiler) ? raw.compiler : {};
  const baseLayers = base.layers ?? { enabled: true };
  const layerPatch = isRecord(patch.layers) ? patch.layers : {};

  return {
    ...base,
    ...patch,
    layers: { ...baseLayers, ...layerPatch },
  } as CompilerConfig;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}
