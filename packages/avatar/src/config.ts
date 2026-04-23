import type { CompilerConfig } from './compiler/types';
import type { AvatarConfig, AvatarMemoryExtractionConfig } from './types';
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
    memoryExtraction: mergeMemoryExtraction(r.memoryExtraction),
  };
}

function mergeMemoryExtraction(patch: unknown): AvatarMemoryExtractionConfig {
  const base = DEFAULT_AVATAR_CONFIG.memoryExtraction;
  if (!isRecord(patch)) {
    return { ...base, allowedSources: [...base.allowedSources] };
  }
  const debounceMs = coerceNonNegativeNumber(patch.debounceMs);
  const maxEntries = coercePositiveInt(patch.maxEntries);
  const minUserEntries = coercePositiveInt(patch.minUserEntries);
  return {
    enabled: patch.enabled === true,
    debounceMs: debounceMs ?? base.debounceMs,
    maxEntries: maxEntries ?? base.maxEntries,
    minUserEntries: minUserEntries ?? base.minUserEntries,
    // Explicitly-empty `[]` disables extraction entirely (same effect as
    // `enabled: false`); missing/invalid falls back to the safe default
    // so a typo in config doesn't accidentally open the allowlist.
    allowedSources: coerceStringArray(patch.allowedSources) ?? [...base.allowedSources],
    provider: optionalNonEmptyString(patch.provider),
  };
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function coerceNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
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
