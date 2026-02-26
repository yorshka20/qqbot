// Conversation module exports

export { SummarizeService } from '../ai/services/SummarizeService';
export type { SummarizeOptions } from '../ai/services/SummarizeService';
export { CommandRouter } from './CommandRouter';
export { ConversationManager } from './ConversationManager';
export { MessagePipeline } from './MessagePipeline';
export type { MessageProcessingContext, MessageProcessingResult } from './types';

// Scoped submodules: proactive and thread
export * from './proactive';
export * from './thread';
