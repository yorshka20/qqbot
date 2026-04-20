/**
 * Types for the Avatar Preview Server.
 */

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
  activeAnimationDetails?: Array<{ name: string; phase: 'attack' | 'sustain' | 'release'; fadeOut?: number }>;
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

export type PreviewClientMessage =
  | TriggerMessage
  | SpeakMessage
  | AmbientAudioMessage
  | TunableParamsRequestMessage
  | TunableParamSetMessage;

export type PreviewMessage = FrameMessage | StatusMessage | AudioMessage | TunableParamsMessage;
