// Avatar integration plugin barrel.
//
// Importing this module triggers each plugin file's `@RegisterPlugin`
// decorator side-effect, populating the static plugin registry consumed by
// PluginManager. Tests under `__tests__/` are intentionally excluded.

export * from './AvatarPlugin';
export * from './PoseLifecyclePlugin';
export * from './SessionStrategyPlugin';
