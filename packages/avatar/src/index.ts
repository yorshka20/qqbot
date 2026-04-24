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
export type { ActionSummary } from './compiler/types';
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
// TTS subsystem — consumed by bot commands and the avatar speech pipeline.
export { FishAudioProvider, type FishAudioProviderOptions } from './tts/providers/FishAudioProvider';
export { SovitsProvider, type SovitsProviderOptions } from './tts/providers/SovitsProvider';
export { TTSManager } from './tts/TTSManager';
export type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from './tts/TTSProvider';
export type { AvatarConfig, AvatarMemoryExtractionConfig, PreviewServerConfig } from './types';
export { DEFAULT_AVATAR_CONFIG } from './types';
export { writeFileUnderDirectory } from './utils/writeFileUnderDirectory';
