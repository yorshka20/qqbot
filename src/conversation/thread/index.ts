// Thread scope: in-memory threads per group, context compression (history loading lives in conversation/history)

export {
  ThreadService,
  isReadableTextForThread,
  type ThreadMessage,
  type ProactiveThread,
} from './ThreadService';
export { ThreadContextCompressionService } from './ThreadContextCompressionService';
