// First-party plugin barrel.
//
// Importing this module triggers each plugin file's `@RegisterPlugin`
// decorator side-effect, populating the static plugin registry consumed by
// PluginManager. Mirrors `command/handlers/index.ts`.
//
// To add a new built-in plugin: drop the file under this directory and add
// an `export *` line below. Tests under `__tests__/` are intentionally
// excluded.

export * from './AutoAcceptPlugin';
export * from './AutoRecallPlugin';
export * from './CloudflareWorkerPlugin';
export * from './ConversationConfigPlugin';
export * from './EchoPlugin';
export * from './GroupDownloadPlugin';
export * from './GroupNoticePlugin';
export * from './GroupReportPlugin';
export * from './gachaPlugin';
export * from './LanControlPlugin';
export * from './LightAppPlugin';
export * from './LogArchivePlugin';
export * from './MemoryPlugin';
export * from './MemoryTriggerPlugin';
export * from './MessageOperationPlugin';
export * from './MessageTriggerPlugin';
export * from './NightlyOpsReportPlugin';
export * from './NsfwModePlugin';
export * from './NudgePlugin';
export * from './PersonaCompletionHookPlugin';
export * from './ProactiveConversationPlugin';
export * from './ReactionPlugin';
export * from './RulePlugin';
export * from './Text2ImgSFWFilterPlugin';
export * from './TodoPlugin';
export * from './VideoAnalyzePlugin';
export * from './WhitelistPlugin';
