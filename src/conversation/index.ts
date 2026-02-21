// Conversation module exports

export { ConversationManager } from './ConversationManager';
export { MessagePipeline } from './MessagePipeline';
export { CommandRouter } from './CommandRouter';
export { SummarizeService } from './SummarizeService';
export type { SummarizeOptions } from './SummarizeService';
export type { MessageProcessingResult, MessageProcessingContext } from './types';

// Scoped submodules: proactive and thread
export * from './proactive';
export * from './thread';
