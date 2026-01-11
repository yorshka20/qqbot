// AI Provider type definitions

/**
 * AI generation options
 */
export interface AIGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  stream?: boolean;
}

/**
 * AI generation response
 */
export interface AIGenerateResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Streaming response handler
 */
export type StreamingHandler = (chunk: string) => void;
