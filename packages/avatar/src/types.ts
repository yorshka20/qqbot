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
};
