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

export type PreviewClientMessage = TriggerMessage | SpeakMessage;

export type PreviewMessage = FrameMessage | StatusMessage | AudioMessage;
