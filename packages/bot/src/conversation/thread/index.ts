// Thread scope: in-memory threads per group, context compression (history loading lives in conversation/history)

export {
  THREAD_CONTEXT_COMPRESS_SEGMENT_SIZE,
  THREAD_CONTEXT_MAX_MESSAGES_BEFORE_COMPRESS,
  ThreadContextCompressionService,
} from './ThreadContextCompressionService';
export {
  isReadableTextForThread,
  type ProactiveThread,
  type ThreadMessage,
  ThreadService,
} from './ThreadService';
