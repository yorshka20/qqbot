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

export interface TriggerMessage {
  type: 'trigger';
  data: {
    action: string;
    emotion?: string;
    intensity?: number;
  };
}

export type PreviewClientMessage = TriggerMessage;

export type PreviewMessage = FrameMessage | StatusMessage;
