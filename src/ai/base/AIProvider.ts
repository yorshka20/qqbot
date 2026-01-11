// AI Provider abstract base class

import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';

/**
 * Abstract AI Provider interface
 * All AI providers must implement this interface
 */
export abstract class AIProvider {
  /**
   * Provider name/identifier
   */
  abstract readonly name: string;

  /**
   * Generate text from prompt
   */
  abstract generate(
    prompt: string,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse>;

  /**
   * Generate text with streaming support
   */
  abstract generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse>;

  /**
   * Check if provider is available/configured
   */
  abstract isAvailable(): boolean;

  /**
   * Get provider configuration
   */
  abstract getConfig(): Record<string, unknown>;
}
