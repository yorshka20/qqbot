export interface LegacyLive2DTag {
  emotion: string;
  action: string;
  intensity: number;
}

export type GazeTarget =
  | { type: 'named'; name: 'camera' | 'left' | 'right' | 'up' | 'down' | 'center' }
  | { type: 'point'; x: number; y: number }
  | { type: 'clear' };

export type ParsedTag =
  | { kind: 'action'; action: string; emotion: string; intensity: number }
  | { kind: 'emotion'; emotion: string; intensity: number }
  | { kind: 'gaze'; target: GazeTarget }
  | { kind: 'hold'; dur: 'brief' | 'short' | 'long' };
