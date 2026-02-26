// Context module exports

export { CommandContextBuilder } from './CommandContextBuilder';
export { ContextManager } from './ContextManager';
export type { AddMessageOptions } from './ContextManager';
export { HookContextBuilder } from './HookContextBuilder';
export type { MessageContextOptions } from './HookContextBuilder';
export {
  clearReply,
  getReply,
  getReplyContent,
  hasReply,
  replaceReply,
  replaceReplyWithSegments,
  setReply,
  setReplyWithSegments,
} from './HookContextHelpers';
export { TaskExecutionContextBuilder } from './TaskExecutionContextBuilder';
export type {
  BuildContextOptions,
  ContextBuilderOptions,
  ConversationContext,
  GlobalContext,
  ProactiveReplyInjectContext,
  SessionContext,
} from './types';
