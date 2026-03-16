// LLM Service - provides LLM text generation capability

import { logger } from '@/utils/logger';
import type { AIManager } from '../AIManager';
import type { LLMCapability } from '../capabilities/LLMCapability';
import { isLLMCapability } from '../capabilities/LLMCapability';
import type { ProviderSelector } from '../ProviderSelector';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  StreamingHandler,
  ToolDefinition,
  ToolResult,
  ToolUseGenerateOptions,
  ToolUseGenerateResponse,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import { containsDSML, parseDSMLFunctionCall, stripDSML } from '../utils/dsmlParser';

/**
 * LLM Service
 * Provides LLM text generation capability
 */
export class LLMService {
  private readonly supportedProviders = ['openai', 'anthropic', 'doubao', 'gemini', 'deepseek'];
  private readonly providersWithNativeWebSearch = ['doubao', 'anthropic'];

  /** Fallback order by cost (cheapest first). Used by getOrderedAlternativeProviderNames. */
  private readonly providerFallbackOrder = ['doubao', 'deepseek', 'gemini', 'openai', 'anthropic'];

  constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
  ) {}

  /**
   * Get fallback response when no provider is available
   * Returns a simple template response based on the prompt type
   */
  private getFallbackResponse(prompt: string): AIGenerateResponse {
    // Check if this is a summary request
    if (prompt.includes('Summarize') || prompt.includes('Summary:')) {
      // Extract conversation text if possible
      const conversationMatch = prompt.match(/User:.*?Assistant:.*/s);
      if (conversationMatch) {
        const conversationText = conversationMatch[0];
        // Create a simple summary based on message count
        const messages = conversationText.split(/\n(?=User:|Assistant:)/).filter(Boolean);
        return {
          text: `Previous conversation with ${messages.length} messages. Key topics discussed.`,
        };
      }
      return {
        text: 'Previous conversation summary: Key topics and decisions were discussed.',
      };
    }

    // Default fallback response
    return {
      text: 'I apologize, but AI service is currently unavailable. Please try again later.',
    };
  }

  /**
   * Check if provider is available
   */
  async getAvailableProvider(providerName?: string, sessionId?: string): Promise<LLMCapability | null> {
    let provider: LLMCapability | null = null;

    if (providerName) {
      // Use specified provider
      const p = this.aiManager.getProviderForCapability('llm', providerName);
      if (p && isLLMCapability(p) && p.isAvailable()) {
        provider = p;
      } else if (p && !p.isAvailable()) {
        logger.warn(
          `[LLMService] Requested provider "${providerName}" is not available (e.g. API key missing or check failed); falling back to default`,
        );
      } else {
        logger.warn(
          `[LLMService] Requested provider "${providerName}" is not registered for LLM capability; falling back to default`,
        );
      }
    } else if (sessionId && this.providerSelector) {
      // Use session-specific provider
      const sessionProviderName = await this.providerSelector.getProviderForSession(sessionId, 'llm');
      if (sessionProviderName) {
        const p = this.aiManager.getProviderForCapability('llm', sessionProviderName);
        if (p && isLLMCapability(p) && p.isAvailable()) {
          provider = p;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('llm');
      if (defaultProvider && isLLMCapability(defaultProvider) && defaultProvider.isAvailable()) {
        provider = defaultProvider;
      }
    }

    return provider;
  }

  async supportsNativeWebSearch(providerName?: string, sessionId?: string): Promise<boolean> {
    const provider = await this.getAvailableProvider(providerName, sessionId);
    if (!provider) {
      return false;
    }
    const resolvedProviderName =
      provider && 'name' in provider ? (provider as { name: string }).name : (providerName ?? '');
    return this.providerSupportsNativeWebSearch(resolvedProviderName);
  }

  async supportsToolUse(providerName?: string, sessionId?: string): Promise<boolean> {
    const provider = await this.getAvailableProvider(providerName, sessionId);
    if (!provider) {
      return false;
    }
    const resolvedProviderName =
      provider && 'name' in provider ? (provider as { name: string }).name : (providerName ?? '');
    return this.providerSupportsToolUse(resolvedProviderName);
  }

  /**
   * Generate text using LLM capability.
   * Automatically falls back to alternative providers on runtime failure.
   */
  async generate(prompt: string, options?: AIGenerateOptions, providerName?: string): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const provider = await this.getAvailableProvider(providerName, sessionId);

    // If no available provider, return fallback response
    if (!provider) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      return this.getFallbackResponse(prompt);
    }

    const resolvedName = this.resolveProviderName(provider, providerName);

    try {
      return await provider.generate(prompt, options);
    } catch (err) {
      logger.error(`[LLMService] Provider "${resolvedName}" generate failed:`, err);
      return this.generateWithFallback(resolvedName, sessionId, (p) => p.generate(prompt, options), prompt);
    }
  }

  /**
   * Generate with lite defaults (low temperature, small maxTokens) for cheap/fast tasks (e.g. prefix-invitation, analysis).
   * Supports explicit provider and model override (e.g. doubao, doubao-1-5-lite-32k-250115).
   */
  async generateLite(prompt: string, options?: AIGenerateOptions, providerName?: string): Promise<AIGenerateResponse> {
    const provider = await this.getAvailableProvider(providerName, options?.sessionId);

    if (!provider) {
      logger.warn('[LLMService] No available LLM provider for generateLite, returning fallback response');
      return this.getFallbackResponse(prompt);
    }

    const liteDefaults: AIGenerateOptions = {
      temperature: 0.1,
      maxTokens: 256,
      reasoningEffort: 'minimal',
    };
    const mergedOptions: AIGenerateOptions = {
      ...liteDefaults,
      ...options,
    };

    logger.debug(`[LLMService] generateLite: ${prompt} | ${JSON.stringify(mergedOptions)}`);

    const cap = provider as { generateLite?: (p: string, o?: AIGenerateOptions) => Promise<AIGenerateResponse> };
    if (typeof cap.generateLite === 'function') {
      return await cap.generateLite(prompt, mergedOptions);
    }

    // if provider does not support generateLite, use generate with lite defaults
    return await provider.generate(prompt, mergedOptions);
  }

  /**
   * Generate using prebuilt role-based messages (OpenAI-standard ChatMessage[]). Each provider converts to its own format.
   */
  async generateMessages(
    messages: ChatMessage[],
    options?: Omit<AIGenerateOptions, 'messages'>,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = lastContent !== undefined ? contentToPlainString(lastContent) : '';
    return this.generate(prompt, { ...(options ?? {}), messages }, providerName);
  }

  /**
   * Generate text with streaming.
   * Automatically falls back to alternative providers on runtime failure.
   */
  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const provider = await this.getAvailableProvider(providerName, sessionId);

    // If no available provider, return fallback response
    if (!provider) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      const fallbackResponse = this.getFallbackResponse(prompt);
      handler(fallbackResponse.text);
      return fallbackResponse;
    }

    const resolvedName = this.resolveProviderName(provider, providerName);

    try {
      return await provider.generateStream(prompt, handler, options);
    } catch (err) {
      logger.error(`[LLMService] Provider "${resolvedName}" generateStream failed:`, err);
      return this.generateWithFallback(
        resolvedName,
        sessionId,
        (p) => p.generateStream(prompt, handler, options),
        prompt,
      );
    }
  }

  async generateStreamMessages(
    messages: ChatMessage[],
    handler: StreamingHandler,
    options?: Omit<AIGenerateOptions, 'messages'>,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = lastContent !== undefined ? contentToPlainString(lastContent) : '';
    return this.generateStream(prompt, handler, { ...(options ?? {}), messages }, providerName);
  }

  /**
   * Generate with tool/function calling support
   * Implements multi-round tool calling loop
   */
  async generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ToolUseGenerateOptions,
    providerName?: string,
  ): Promise<ToolUseGenerateResponse> {
    const sessionId = options?.sessionId;
    const maxRounds = options?.maxToolRounds ?? 3;
    const toolExecutor = options?.toolExecutor;

    let provider = await this.getAvailableProvider(providerName, sessionId);

    // Check if provider supports tool use
    let currentProviderName =
      provider && 'name' in provider ? (provider as { name: string }).name : (providerName ?? '');
    const supportsToolUse = provider && this.providerSupportsToolUse(currentProviderName);

    // If provider doesn't support tool use, try fallback to doubao
    if (provider && !supportsToolUse) {
      logger.warn(`[LLMService] Provider "${currentProviderName}" doesn't support tool use, falling back to doubao`);
      const doubaoProvider = await this.getAvailableProvider('doubao', sessionId);
      if (doubaoProvider && this.providerSupportsToolUse('doubao')) {
        provider = doubaoProvider;
        currentProviderName = 'doubao';
      } else {
        logger.warn('[LLMService] Doubao fallback not available, will proceed without tool use');
        // Proceed without tool use - just generate normally
        return {
          ...(await this.generateMessages(messages, options, providerName)),
          stopReason: 'end_turn',
        };
      }
    }

    if (!provider) {
      logger.warn('[LLMService] No available provider for tool use');
      return {
        ...this.getFallbackResponse(contentToPlainString(messages[messages.length - 1]?.content ?? '')),
        stopReason: 'end_turn',
      };
    }

    const currentMessages = [...messages];
    let round = 0;
    const allToolCalls: ToolResult[] = [];

    while (round < maxRounds) {
      // Generate with tools
      const response = await this.generateMessagesWithToolSupport(currentMessages, tools, options, currentProviderName);

      // Check if there's a function call
      if (!response.functionCall) {
        // No tool call, return final response
        return {
          ...response,
          toolCalls: allToolCalls,
          stopReason: 'end_turn',
        };
      }

      // Execute the tool if executor is provided
      if (toolExecutor) {
        try {
          const toolResult = await toolExecutor(response.functionCall);
          allToolCalls.push({
            tool: response.functionCall.name,
            result: toolResult,
          });

          const toolResultContent = JSON.stringify(toolResult);
          if (response.toolCallId) {
            // OpenAI/DeepSeek format: assistant with tool_calls + tool message
            currentMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: response.toolCallId,
                  name: response.functionCall.name,
                  arguments: response.functionCall.arguments,
                },
              ],
            });
            currentMessages.push({
              role: 'tool',
              tool_call_id: response.toolCallId,
              content: toolResultContent,
            });
          } else {
            currentMessages.push({ role: 'assistant', content: '' });
            currentMessages.push({
              role: 'user',
              content: `Tool result for ${response.functionCall.name}: ${toolResultContent}`,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[LLMService] Tool execution error:`, error);
          allToolCalls.push({
            tool: response.functionCall.name,
            result: null,
            error: errorMessage,
          });

          const errorContent = `Tool execution failed: ${errorMessage}`;
          if (response.toolCallId) {
            currentMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: response.toolCallId,
                  name: response.functionCall.name,
                  arguments: response.functionCall.arguments,
                },
              ],
            });
            currentMessages.push({
              role: 'tool',
              tool_call_id: response.toolCallId,
              content: errorContent,
            });
          } else {
            currentMessages.push({
              role: 'user',
              content: errorContent,
            });
          }
        }
      } else {
        // No executor provided, return the function call for external handling
        return {
          ...response,
          toolCalls: allToolCalls,
          stopReason: 'tool_use',
        };
      }

      round++;
    }

    // Max rounds reached, force final generation
    logger.warn(`[LLMService] Max tool rounds (${maxRounds}) reached, forcing final response`);
    const finalResponse = await this.generateMessages(currentMessages, options, currentProviderName);

    // Strip DSML from final text — model may still attempt tool calls via text when tools are absent
    if (finalResponse.text && containsDSML(finalResponse.text)) {
      logger.warn('[LLMService] Stripping DSML text tool call from final response (max rounds exceeded)');
      finalResponse.text = stripDSML(finalResponse.text);
    }

    return {
      ...finalResponse,
      toolCalls: allToolCalls,
      stopReason: 'max_rounds',
    };
  }

  /**
   * Check if provider supports tool use
   */
  private providerSupportsToolUse(providerName: string): boolean {
    // List of providers that support tool/function calling
    return this.supportedProviders.includes(providerName.toLowerCase());
  }

  /**
   * Get alternative provider names for a capability, excluding the specified provider.
   * Ordered by cost (cheapest first) using providerFallbackOrder.
   * Providers not in the fallback order list are appended at the end.
   */
  getAlternativeProviderNames(excludeProvider?: string): string[] {
    const allProviders = this.aiManager.getProvidersForCapability('llm');
    const available = allProviders.filter((p) => p.name !== excludeProvider && p.isAvailable()).map((p) => p.name);

    // Sort by fallback order (cheapest first); unknown providers go to end
    const orderMap = new Map(this.providerFallbackOrder.map((name, i) => [name, i]));
    return available.sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999));
  }

  /**
   * Trigger an immediate health check on all AI providers.
   * Should be called reactively when a provider call fails.
   */
  async triggerHealthCheck(): Promise<void> {
    await this.aiManager.triggerHealthCheck();
  }

  /**
   * Extract the provider name from a resolved provider instance.
   */
  private resolveProviderName(provider: LLMCapability, hint?: string): string {
    if ('name' in provider) return (provider as { name: string }).name;
    return hint ?? 'unknown';
  }

  /**
   * Try alternative providers in fallback order after the primary provider failed.
   * Returns a fallback text response if all alternatives also fail.
   */
  private async generateWithFallback(
    failedProvider: string,
    sessionId: string | undefined,
    fn: (provider: LLMCapability) => Promise<AIGenerateResponse>,
    prompt: string,
  ): Promise<AIGenerateResponse> {
    const alternatives = this.getAlternativeProviderNames(failedProvider);
    for (const altName of alternatives) {
      const altProvider = await this.getAvailableProvider(altName, sessionId);
      if (!altProvider) continue;
      try {
        logger.info(`[LLMService] Falling back to provider "${altName}"`);
        return await fn(altProvider);
      } catch (altErr) {
        logger.warn(`[LLMService] Fallback provider "${altName}" also failed:`, altErr);
      }
    }
    logger.error('[LLMService] All providers failed, returning fallback response');
    return this.getFallbackResponse(prompt);
  }

  private providerSupportsNativeWebSearch(providerName: string): boolean {
    return this.providersWithNativeWebSearch.includes(providerName.toLowerCase());
  }

  /**
   * Generate messages with tool support (provider-specific implementation)
   * Passes tools in options; providers that support tool use return functionCall and tool_call_id.
   */
  private async generateMessagesWithToolSupport(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ToolUseGenerateOptions | undefined,
    providerName: string,
  ): Promise<ToolUseGenerateResponse> {
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = lastContent !== undefined ? contentToPlainString(lastContent) : '';
    const response = await this.generate(prompt, { ...(options ?? {}), messages, tools }, providerName);

    // Fallback: if no structured functionCall but text contains DSML, parse it
    if (!response.functionCall && response.text && containsDSML(response.text)) {
      const dsmlCall = parseDSMLFunctionCall(response.text);
      if (dsmlCall) {
        logger.debug(`[LLMService] Parsed DSML text function call: ${dsmlCall.name}`);
        response.functionCall = {
          name: dsmlCall.name,
          arguments: JSON.stringify(dsmlCall.arguments),
        };
        response.text = stripDSML(response.text);
      }
    }

    return {
      ...response,
      functionCall: response.functionCall,
      toolCallId: response.toolCallId,
    };
  }
}
