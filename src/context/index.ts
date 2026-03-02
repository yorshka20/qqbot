// Context module exports

export { CommandContextBuilder } from './CommandContextBuilder';
export type { AddMessageOptions } from './ContextManager';
export { ContextManager } from './ContextManager';
export type { MessageContextOptions } from './HookContextBuilder';
export { HookContextBuilder } from './HookContextBuilder';
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
