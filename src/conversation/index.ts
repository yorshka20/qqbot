// Conversation module exports

export type { SummarizeOptions } from '../ai/services/SummarizeService';
export { SummarizeService } from '../ai/services/SummarizeService';
export { CommandRouter } from './CommandRouter';
export { ConversationManager } from './ConversationManager';
export { MessagePipeline } from './MessagePipeline';
// Scoped submodules: proactive and thread
export * from './proactive';
export * from './thread';
export type { MessageProcessingContext, MessageProcessingResult } from './types';
