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
  state: string;
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

export type PreviewClientMessage = TriggerMessage;

export type PreviewMessage = FrameMessage | StatusMessage | AudioMessage;
