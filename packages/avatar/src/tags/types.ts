export type { HeadLookTarget } from '../compiler/layers/HeadLookLayer';

export interface LegacyLive2DTag {
  emotion: string;
  action: string;
  intensity: number;
}

export type GazeTarget =
  | { type: 'named'; name: 'camera' | 'left' | 'right' | 'up' | 'down' | 'center' }
  | { type: 'point'; x: number; y: number }
  | { type: 'clear' };

export type WalkToTarget = 'camera' | 'center' | 'back';
export type FaceTarget = 'camera' | 'back' | 'left' | 'right';

export type WalkMotion =
  | { type: 'forward'; meters: number }
  | { type: 'strafe'; meters: number }
  | { type: 'turn'; degrees: number }
  | { type: 'orbit'; degrees: number; radius?: number }
  | { type: 'to'; target: WalkToTarget }
  | { type: 'face'; target: FaceTarget }
  | { type: 'stop' };

export type ParsedTag =
  | { kind: 'action'; action: string; emotion: string; intensity: number }
  | { kind: 'emotion'; emotion: string; intensity: number }
  | { kind: 'gaze'; target: GazeTarget }
  | { kind: 'hold'; dur: 'brief' | 'short' | 'long' }
  | { kind: 'walk'; motion: WalkMotion }
  | { kind: 'headLook'; target: import('../compiler/layers/HeadLookLayer').HeadLookTarget | null };
