import type { CompilerConfig } from './compiler/types';
import type { VTSConfig } from './drivers/types';
import type { IdleConfig } from './state/types';

/**
 * Top-level avatar system configuration.
 * Composes sub-configs for each avatar subsystem.
 */
export interface AvatarConfig {
  /** Enable the avatar system (default: false) */
  enabled: boolean;
  /** VTube Studio driver configuration */
  vts: VTSConfig;
  /** Animation compiler configuration */
  compiler: CompilerConfig;
  /** Idle state machine configuration */
  idle: IdleConfig;
  /** Preview server configuration */
  preview: PreviewServerConfig;
  /** Optional action-map override. If path is unset, the package default is used. */
  actionMap: { path?: string };
  /** Text-to-speech configuration */
  speech: {
    enabled: boolean;
    maxCharsPerUtterance: number;
    utteranceGapMs: number;
    /** If set, each synthesized utterance is also written under this path relative to the repo root (e.g. `output/tts`). */
    exportTtsWavDir?: string;
  };
  /**
   * When set, the Live2D pipeline (`/avatar`, Bilibili danmaku → avatar, livemode) uses
   * this `ai.providers` name instead of `ai.defaultProviders.llm`.
   * Does not affect normal chat reply generation.
   */
  llmProvider?: string;
  /**
   * Live2D LLM mode: `true` = `generateStream` (API streaming); `false` = one-shot `generate`.
   * Per-enqueue override: `Live2DInput.meta.llmStream` (boolean) wins. Default: `false`.
   */
  llmStream: boolean;
  /**
   * Reasoning effort forwarded to the Live2D LLM call. The avatar path is
   * pure live roleplay — a hidden `<think>` block is a pure TTFT tax, and on
   * thinking-capable models (e.g. Groq qwen3-32b) it also tends to pull the
   * model out of character. Default `'none'`.
   *
   * Values: `'none' | 'minimal' | 'low' | 'medium' | 'high'`. Only providers
   * that speak the reasoning_effort dialect (Groq qwen3-*, OpenAI o-series,
   * Anthropic extended-thinking) act on this; others ignore it.
   */
  llmReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Memory extraction for Live2D conversations. When enabled, after each
   * successful reply the recent thread history is queued for a debounced
   * MemoryExtractService.extractAndUpsert run, scoped to the synthetic
   * Live2D groupId (`live2d:avatar-cmd:global`, `live2d:bilibili-live:<room>`, …).
   * This is what populates the `<memory_context>` block read by the
   * avatar PromptAssemblyStage — without it the read path is a no-op
   * because nothing ever writes under those groupIds.
   *
   * Opt-in by default (`enabled: false`) because extraction fires an
   * additional LLM call per debounce tick and the live2d scopes are less
   * fact-dense than real group chats.
   */
  memoryExtraction: AvatarMemoryExtractionConfig;
}

/**
 * Controls post-reply memory extraction for the Live2D pipeline. Mirrors
 * `MemoryPlugin` but scoped to live2d threads only.
 */
export interface AvatarMemoryExtractionConfig {
  /** Global switch. Default `false` (opt-in). */
  enabled: boolean;
  /**
   * Idle time (ms) after the last reply before extract fires for a thread.
   * Default `600000` (10 min) — matches MemoryPlugin's sane default and
   * avoids hammering the extract LLM on every avatar utterance.
   */
  debounceMs: number;
  /**
   * Cap on how many recent thread entries (user + assistant) are fed to
   * extract per run. Keeps the extract prompt bounded even if a live2d
   * thread grows unexpectedly. Default `80`.
   */
  maxEntries: number;
  /**
   * Minimum number of NON-bot entries before a run is worth firing. Avoids
   * running extract on threads that only contain synthetic idle-trigger
   * messages (e.g. `(直播间暂时安静)`). Default `3`.
   */
  minUserEntries: number;
  /**
   * Live2D sources (the `source` field on `Live2DInput`) whose threads
   * are eligible for memory extraction. Default `['bilibili-danmaku-batch']`
   * — the only source that represents *real* viewer utterances. Both
   * `avatar-cmd` (admin probe) and `livemode-private-batch` (mock
   * livestream) are excluded by default because their content is
   * essentially dev/test traffic and would pollute long-term memory
   * with self-referential or rehearsal lines.
   *
   * Kept as `string[]` here (not the typed `Live2DSource` union) so the
   * avatar package doesn't have to depend on the bot package's pipeline
   * types. The coordinator does a string-equality check against
   * `Live2DInput.source`.
   */
  allowedSources: string[];
  /**
   * LLM provider for the extract + analyze pass. Falls back to
   * `ai.taskProviders.memoryExtract` → `avatar.llmProvider` →
   * `ai.defaultProviders.llm` in `Live2DMemoryExtractionCoordinator`.
   */
  provider?: string;
}

/**
 * Preview server configuration for avatar frame preview.
 */
export interface PreviewServerConfig {
  /** Enable the preview server (default: false) */
  enabled: boolean;
  /** Port to listen on (default: 9222) */
  port: number;
  /** Host to bind to (default: localhost) */
  host: string;
}

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  enabled: false,
  vts: {
    enabled: true,
    host: 'localhost',
    port: 8001,
    pluginName: 'qqbot-avatar',
    pluginDeveloper: 'qqbot',
    tokenFilePath: 'data/avatar/.vts-token',
    throttleFps: 30,
  },
  compiler: {
    fps: 60,
    outputFps: 60,
    defaultEasing: 'easeInOutCubic',
    smoothingFactor: 0.5,
    attackRatio: 0.1,
    releaseRatio: 0.3,
    layers: { enabled: true },
    crossfadeMs: 250,
    baselineHalfLifeMs: 3000,
    idle: { loopClipActionName: 'peace_sign' },
  },
  idle: {
    idleIntervalMin: 3000,
    idleIntervalMax: 8000,
  },
  preview: {
    enabled: false,
    port: 9222,
    host: 'localhost',
  },
  actionMap: {},
  speech: {
    enabled: false,
    maxCharsPerUtterance: 80,
    utteranceGapMs: 200,
  },
  llmStream: false,
  llmReasoningEffort: 'none',
  memoryExtraction: {
    enabled: false,
    debounceMs: 600_000,
    maxEntries: 80,
    minUserEntries: 3,
    // Only real Bilibili danmaku feeds long-term memory by default. Admin
    // `/avatar` and mock `/livemode` are excluded so test/probe utterances
    // don't end up in user facts.
    allowedSources: ['bilibili-danmaku-batch'],
  },
};
