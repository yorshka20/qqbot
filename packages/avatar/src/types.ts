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
  };
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
    fps: 30,
    outputFps: 30,
    defaultEasing: 'easeInOutCubic',
    smoothingFactor: 0.5,
    attackRatio: 0.1,
    releaseRatio: 0.3,
    layers: { enabled: true },
    crossfadeMs: 250,
    baselineHalfLifeMs: 45000,
    idle: { loopClipActionName: 'peace_sign' },
    // restPose intentionally absent here — AnimationCompiler merges user entries
    // with DEFAULT_VRM_REST_POSE so a user tweaking one key keeps other defaults.
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
};
