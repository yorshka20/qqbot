/**
 * Types for the Avatar Preview Server.
 */

import type { ModelKind } from '../compiler/types';
export type { ModelKind };

export interface PreviewConfig {
  port: number;
  host: string;
}

export interface PreviewFrame {
  timestamp: number;
  params: Record<string, number>;
}

export interface PreviewStatus {
  /** Current discrete pose ('neutral' | 'listening' | 'thinking'). */
  pose: string;
  /** Current global ambient-layer gain — 1.0 = full ambient, lower = suppressed. */
  ambientGain: number;
  fps: number;
  activeAnimations: number;
  queueLength: number;
  /** Snapshot of per-channel baseline values (from endPose harvesting). Optional — populated when compiler has state. */
  channelBaseline?: Record<string, number>;
  /** Summary of currently active animations with phase and optional fade-out timestamp. */
  activeAnimationDetails?: Array<{
    name: string;
    phase: 'attack' | 'sustain' | 'release';
    fadeOut?: number;
    /** Added in B 2/3: whether the action plays as ADSR envelope or as a sampled clip. Optional for forward-compat with older snapshots. */
    kind?: 'envelope' | 'clip';
  }>;
  /**
   * Authoritative root pose from the WalkingLayer. Broadcast so HUDs can
   * display current position without deriving it from frame params (which
   * would be renderer-side replication of bot state). Absent when no
   * WalkingLayer is registered (e.g. cubism model).
   */
  rootPosition?: { x: number; z: number; facing: number };
}

export interface FrameMessage {
  type: 'frame';
  data: PreviewFrame;
}

export interface StatusMessage {
  type: 'status';
  data: PreviewStatus;
}

/**
 * Audio utterance pushed from bot's SpeechService for PC-side playback.
 * Renderer plays via a single <audio> element at startAtEpochMs wall-clock.
 * Bot queues server-side; renderer does not. utteranceId correlates with
 * lip-sync tracks.
 */
export interface AudioMessage {
  type: 'audio';
  data: {
    base64: string; // base64-encoded audio bytes
    mime: string; // 'audio/mpeg' | 'audio/wav' | ...
    startAtEpochMs: number; // wall-clock epoch ms; past-due = play immediately
    durationMs: number; // informational; real duration from decoder
    utteranceId: string; // stable id, e.g. crypto.randomUUID()
    /** Original utterance text (post sentence-split), surfaced so the renderer
     *  can display subtitles / toasts alongside playback. */
    text: string;
  };
}

export interface TriggerMessage {
  type: 'trigger';
  data: {
    action: string;
    emotion?: string;
    intensity?: number;
  };
}

/**
 * Client → server: manually speak a phrase through SpeechService,
 * bypassing the LLM reply path. Used by the HUD's debug text input so we
 * can verify the end-to-end TTS → lip-sync pipeline without generating a
 * real private-chat reply.
 */
export interface SpeakMessage {
  type: 'speak';
  data: {
    /** Arbitrary text; goes through the same sentence-split + queue as LLM replies. */
    text: string;
  };
}

/**
 * Client → server: 30Hz burst of the renderer-machine system audio's
 * instantaneous RMS. Consumed by AmbientAudioLayer on the compiler side to
 * drive body.z / brow in response to BGM.
 *
 * Only sent when user has explicitly enabled BGM Reactivity in the HUD.
 * Renderer drops on closed socket (same as TriggerMessage).
 *
 * Contract source: qqbot-avatar-renderer ticket
 * 2026-04-20-renderer-system-audio-capture. Bot-side schema MUST stay in sync.
 */
export interface AmbientAudioMessage {
  type: 'ambient-audio';
  data: {
    /** Instantaneous RMS over the renderer's last analyser frame, linear [0, ~1]. */
    rms: number;
    /** Wall-clock ms when the sample was taken on renderer (Date.now()). */
    tMs: number;
  };
}

/**
 * Describes a single tunable numeric parameter exposed by a layer or the
 * compiler itself. Rendered as a slider on the HUD tuning panel.
 *
 * Contract source: qqbot ticket 2026-04-20-avatar-tunable-params-api.
 * Consumer: qqbot-avatar-renderer ticket 2026-04-20-renderer-tuning-panel.
 */
export interface TunableParam {
  /** Unique within its section. e.g. 'silenceFloor', 'body.z.omega'. */
  id: string;
  /** Human-readable label for the slider. */
  label: string;
  /** Slider min bound. */
  min: number;
  /** Slider max bound. */
  max: number;
  /** Slider step size. */
  step: number;
  /** Current runtime value. */
  value: number;
  /** Default value (for 'Reset' button). */
  default: number;
}

/** A group of tunable params sharing a source — one layer or the compiler. */
export interface TunableSection {
  /**
   * Conventions:
   * - `layer:<layerId>` — e.g. 'layer:ambient-audio'
   * - `compiler:<subsystem>` — e.g. 'compiler:spring-damper'
   */
  id: string;
  label: string;
  params: TunableParam[];
}

/** Renderer → bot: request the current list of tunables. */
export interface TunableParamsRequestMessage {
  type: 'tunable-params-request';
}

/** Bot → renderer: response to request, or pushed on layer-set change. */
export interface TunableParamsMessage {
  type: 'tunable-params';
  data: {
    sections: TunableSection[];
  };
}

/** Renderer → bot: set one param. No ack; renderer is optimistic. */
export interface TunableParamSetMessage {
  type: 'tunable-param-set';
  data: {
    sectionId: string;
    paramId: string;
    value: number;
  };
}

/**
 * Renderer → bot: renderer handshake sent on WS open (or model hot-swap).
 * Declares which model format the renderer has loaded so the bot can
 * route model-specific layer/action filtering.
 *
 * Contract source: qqbot ticket 2026-04-21-avatar-model-aware-handshake.
 * `protocolVersion` is always 1 for this revision.
 * `modelKind` is null when the renderer has not yet loaded any model.
 */
export interface HelloMessage {
  type: 'hello';
  modelKind: ModelKind | null;
  protocolVersion: 1;
}

/**
 * Canonical expression names supported by the avatar renderer protocol.
 * Order is intentional and must not be alphabetized — it reflects grouping
 * by expression category (emotion → viseme → eyelid → gaze).
 *
 * Contract source: qqbot ticket 2026-04-22-avatar-renderer-capabilities-api.
 */
export const CANONICAL_EXPRESSIONS = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'neutral',
  'aa',
  'ih',
  'ee',
  'oh',
  'ou',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
] as const;

/** Union type of all canonical expression name literals. */
export type CanonicalExpressionName = (typeof CANONICAL_EXPRESSIONS)[number];

/**
 * Renderer capability report sent from renderer → bot after model load (or
 * model hot-swap). Declares what the loaded model supports so the bot can
 * route expressions, channels, and custom morph targets appropriately.
 *
 * Contract source: qqbot ticket 2026-04-22-avatar-renderer-capabilities-api.
 */
export interface RendererCapabilities {
  /** Subset of CANONICAL_EXPRESSIONS that the loaded model actually has morphs for. */
  expressions: CanonicalExpressionName[];
  /** Channel names (e.g. 'head.x', 'body.z') the renderer processes. */
  supportedChannels: string[];
  /** Non-canonical morph target names exposed by the model (vendor / artist-defined). */
  customExpressions: string[];
  /** Identifies which model is currently loaded. */
  modelId: {
    kind: 'cubism' | 'vrm';
    /** URL slug or filename stem used to address the model in /assets. */
    slug: string;
    /** Human-readable model title, if provided by the renderer. */
    title?: string;
  };
}

/**
 * Renderer → bot: capability report sent after model load or hot-swap.
 * Tells the bot what expressions, channels, and morph targets are available
 * for the currently loaded model so routing decisions can be made server-side.
 */
export interface CapabilitiesMessage {
  type: 'capabilities';
  data: RendererCapabilities;
}

/**
 * Client → server: semantic locomotion command. All avatar movement intents
 * flow through this single discriminated union so the HUD (and eventually the
 * LLM) never touches world coordinates. The bot's `WalkingLayer` resolves
 * each `kind` into an authoritative trajectory and emits the usual
 * `vrm.root.*` channels on the frame stream — the wire to the renderer is
 * unchanged (always absolute x / z / rotY).
 *
 * Direction / sign conventions:
 *  - `forward.meters`: positive = along current facing, negative = backward.
 *  - `strafe.meters`: positive = character's own right, negative = own left.
 *    Character's right is always resolved from their facing, so "left" stays
 *    consistent regardless of camera / viewer pose.
 *  - `turn.radians`: positive = turn to character's own right (CW from above,
 *    matches Three.js Ry sign). Negative = left.
 *  - `orbit.sweepRad`: positive = CCW from above (math convention). With the
 *    default centre derived to the character's left, positive sweep arcs the
 *    character leftward.
 *
 * A new command interrupts any pending motion server-side (prior Promise
 * rejects with WalkInterruptedError, which the bot swallows internally in
 * this WS path). Fire-and-forget; no ack.
 */
export type WalkCommandData =
  | { kind: 'forward'; meters: number }
  | { kind: 'strafe'; meters: number }
  | { kind: 'turn'; radians: number }
  | {
      kind: 'orbit';
      sweepRad: number;
      radius?: number;
      center?: { x: number; z: number };
      keepFacingTangent?: boolean;
    }
  | { kind: 'to'; x: number; z: number; face?: number }
  | { kind: 'stop' };

export interface WalkCommandMessage {
  type: 'walk-command';
  data: WalkCommandData;
}

export type PreviewClientMessage =
  | TriggerMessage
  | SpeakMessage
  | AmbientAudioMessage
  | TunableParamsRequestMessage
  | TunableParamSetMessage
  | HelloMessage
  | WalkCommandMessage
  | CapabilitiesMessage;

export type PreviewMessage = FrameMessage | StatusMessage | AudioMessage | TunableParamsMessage;
