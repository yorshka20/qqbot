// Context module exports

export { CommandContextBuilder } from './CommandContextBuilder';
export type { AddMessageOptions } from './ContextManager';
export { ContextManager } from './ContextManager';
export type { MessageContextOptions } from './HookContextBuilder';
export { HookContextBuilder } from './HookContextBuilder';
export {
  clearReply,
  computeSendAsForward,
  getReply,
  getReplyContent,
  hasReply,
  isNoReplyPath,
  replaceReply,
  replaceReplyWithSegments,
  setReply,
  setReplyWithSegments,
} from './HookContextHelpers';
export {
  enterMessageContext,
  getCurrentMessageContext,
  type MessageContextValue,
} from './MessageContextStorage';
export { TaskExecutionContextBuilder } from './TaskExecutionContextBuilder';
export type {
  BuildContextOptions,
  ContextBuilderOptions,
  ConversationContext,
  GlobalContext,
  ProactiveReplyInjectContext,
  SessionContext,
} from './types';
