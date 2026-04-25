// Avatar system — public API

export { AvatarService, formatActionsForPrompt } from './AvatarService';
export {
  CHANNEL_GROUP_CHILDREN,
  CHANNEL_GROUP_IDS,
  CHANNEL_GROUPS,
  type ChannelGroup,
  getChannelGroup,
} from './channels/groups';
export type { ResolveActionOptions } from './compiler/action-map';
export type { GazeDistribution } from './compiler/layers/EyeGazeLayer';
export type { HeadLookTarget } from './compiler/layers/HeadLookLayer';
export type { PersonaPostureBias } from './compiler/layers/PersonaPostureLayer';
export type { ActionSummary, StateNodeSource } from './compiler/types';
export { mergeAvatarConfig } from './config';
export {
  type ActionCategory,
  IDENTITY_MODULATION,
  type MindModulation,
  type MindModulationProvider,
  type ModulationContext,
  sanitizeScale,
} from './mind/types';
export type { AvatarActivity, AvatarActivityPatch, AvatarPose } from './state/types';
export type { FaceTarget, GazeTarget, LegacyLive2DTag, ParsedTag, WalkMotion, WalkToTarget } from './tags';
export { parseLive2DTags, parseRichTags, stripLive2DTags } from './tags';
export type { AvatarConfig, AvatarMemoryExtractionConfig, PreviewServerConfig } from './types';
export { DEFAULT_AVATAR_CONFIG } from './types';
export { writeFileUnderDirectory } from './utils/writeFileUnderDirectory';
