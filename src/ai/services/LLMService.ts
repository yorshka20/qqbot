// LLM Service - provides LLM text generation capability

import type { HealthCheckManager } from '@/core/health';
import { logger } from '@/utils/logger';
import type { AIManager } from '../AIManager';
import type { LLMCapability } from '../capabilities/LLMCapability';
import { isLLMCapability } from '../capabilities/LLMCapability';
import type { ProviderSelector } from '../ProviderSelector';
import { TokenRateLimiter, type TokenRateLimiterConfig } from '../rateLimit';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ChatMessageToolCall,
  StreamingHandler,
  ToolDefinition,
  ToolResult,
  ToolUseGenerateOptions,
  ToolUseGenerateResponse,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import {
  containsDSML,
  containsTextToolCalls,
  parseDSMLFunctionCall,
  stripDSML,
  stripTextToolCalls,
} from '../utils/dsmlParser';

/**
 * LLM fallback configuration
 */
export interface LLMFallbackConfig {
  /** Ordered list of provider names for fallback (by cost, cheapest first) */
  fallbackOrder: string[];
}

export interface LLMServiceConfig {
  /** Providers that support tool/function calling */
  toolUseProviders: string[];
  /** LLM fallback configuration */
  fallback: LLMFallbackConfig;
  /** Optional per-provider token rate limiting */
  rateLimit?: TokenRateLimiterConfig;
}

/**
 * LLM Service
 * Provides LLM text generation capability
 */
export class LLMService {
  private readonly providersWithNativeWebSearch = ['doubao', 'anthropic'];

  /** Service configuration (tool-use providers + fallback) */
  private readonly config: LLMServiceConfig;

  /** Health check manager for tracking provider health */
  private readonly healthCheckManager?: HealthCheckManager;

  /** Token rate limiter for per-provider TPM enforcement */
  private readonly rateLimiter: TokenRateLimiter;

  private constructor(
    private aiManager: AIManager,
    private providerSelector?: ProviderSelector,
    healthCheckManager?: HealthCheckManager,
    config?: LLMServiceConfig,
  ) {
    this.healthCheckManager = healthCheckManager;
    this.config = config ?? { toolUseProviders: [], fallback: { fallbackOrder: [] } };
    this.rateLimiter = new TokenRateLimiter(this.config.rateLimit);
  }

  /**
   * Create a new LLMService instance.
   * Should only be called once during bootstrap; all other code should use the DI container instance.
   */
  static create(
    aiManager: AIManager,
    providerSelector?: ProviderSelector,
    healthCheckManager?: HealthCheckManager,
    config?: LLMServiceConfig,
  ): LLMService {
    return new LLMService(aiManager, providerSelector, healthCheckManager, config);
  }

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
   * Check if provider is available and healthy.
   * If the resolved provider is unhealthy, attempts to find a healthy fallback.
   */
  async getAvailableProvider(providerName?: string, sessionId?: string): Promise<LLMCapability | null> {
    let provider: LLMCapability | null = null;
    let resolvedName: string | undefined;

    if (providerName) {
      // Use specified provider
      const p = this.aiManager.getProviderForCapability('llm', providerName);
      if (p && isLLMCapability(p) && p.isAvailable()) {
        provider = p;
        resolvedName = providerName;
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
          resolvedName = sessionProviderName;
        }
      }
    }

    // Fall back to default provider
    if (!provider) {
      const defaultProvider = this.aiManager.getDefaultProvider('llm');
      if (defaultProvider && isLLMCapability(defaultProvider) && defaultProvider.isAvailable()) {
        provider = defaultProvider;
        resolvedName = 'name' in defaultProvider ? (defaultProvider as { name: string }).name : undefined;
      }
    }

    // Check health status and try fallback if unhealthy.
    if (provider && resolvedName && this.healthCheckManager ) {
      if (!this.healthCheckManager.isServiceHealthySync(resolvedName)) {
        logger.warn(`[LLMService] Provider "${resolvedName}" is unhealthy, trying healthy fallback`);
        const healthyFallback = await this.getFirstHealthyProvider(sessionId, resolvedName);
        if (healthyFallback) {
          return healthyFallback;
        }
        // No healthy fallback available, still return the unhealthy provider (let it try)
        logger.warn(`[LLMService] No healthy fallback available, proceeding with "${resolvedName}"`);
      }
    }

    return provider;
  }

  /**
   * Get the first healthy provider from fallback order.
   */
  private async getFirstHealthyProvider(sessionId?: string, excludeProvider?: string): Promise<LLMCapability | null> {
    const healthyProviders = this.getHealthyFallbackProviders(this.config.fallback.fallbackOrder, excludeProvider);

    for (const name of healthyProviders) {
      const p = this.aiManager.getProviderForCapability('llm', name);
      if (p && isLLMCapability(p) && p.isAvailable()) {
        logger.info(`[LLMService] Using healthy fallback provider "${name}"`);
        return p;
      }
    }
    return null;
  }

  /**
   * Get ordered fallback providers filtered by health status.
   */
  private getHealthyFallbackProviders(fallbackOrder: string[], excludeProvider?: string): string[] {
    return fallbackOrder.filter((name) => {
      if (excludeProvider && name === excludeProvider) {
        return false;
      }
      if (this.healthCheckManager) {
        return this.healthCheckManager.isServiceHealthySync(name);
      }
      return true; // No health manager = assume healthy
    });
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
   * Updates provider health status based on success/failure.
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

    // Rate limit: wait for token capacity before calling the provider.
    // Estimate prompt tokens from content length (rough: 1 token ≈ 3 chars for CJK, 4 for latin).
    const estimatedTokens = this.estimatePromptTokens(prompt, options);
    await this.rateLimiter.waitForCapacity(estimatedTokens, resolvedName);

    try {
      const result = await provider.generate(prompt, options);
      // Record actual token usage for rate limiting
      if (result.usage) {
        this.rateLimiter.recordUsage(result.usage.totalTokens, resolvedName);
      }
      // Mark provider as healthy on success
      this.healthCheckManager?.markServiceHealthy(resolvedName);
      result.resolvedProviderName = resolvedName;
      return result;
    } catch (err) {
      // Mark provider as failed
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager?.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generate failed:`, err);
      // Strip provider-specific model from options so fallback providers use their own defaults
      const fallbackOptions = options ? { ...options, model: undefined } : options;
      return this.generateWithFallback(resolvedName, sessionId, (p) => p.generate(prompt, fallbackOptions), prompt);
    }
  }

  /**
   * Generate with lite defaults (low temperature, small maxTokens) for cheap/fast tasks (e.g. prefix-invitation, analysis).
   * Supports explicit provider and model override (e.g. doubao, doubao-1-5-lite-32k-250115).
   */
  async generateLite(prompt: string, options?: AIGenerateOptions, providerName?: string): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const provider = await this.getAvailableProvider(providerName, sessionId);

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

    const resolvedName = this.resolveProviderName(provider, providerName);
    logger.debug(`[LLMService] generateLite: ${prompt} | ${JSON.stringify(mergedOptions)}`);

    try {
      const result = await this.invokeLiteGeneration(provider, prompt, mergedOptions);
      this.healthCheckManager?.markServiceHealthy(resolvedName);
      result.resolvedProviderName = resolvedName;
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager?.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generateLite failed:`, err);
      // Strip provider-specific model from options so fallback providers use their own defaults
      const fallbackOptions: AIGenerateOptions = { ...mergedOptions, model: undefined };
      return this.generateWithFallback(
        resolvedName,
        sessionId,
        (p) => this.invokeLiteGeneration(p, prompt, fallbackOptions),
        prompt,
      );
    }
  }

  /** Invoke generateLite on provider if supported, otherwise fall back to generate with lite defaults. */
  private async invokeLiteGeneration(
    provider: LLMCapability,
    prompt: string,
    options: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const cap = provider as { generateLite?: (p: string, o?: AIGenerateOptions) => Promise<AIGenerateResponse> };
    if (typeof cap.generateLite === 'function') {
      return await cap.generateLite(prompt, options);
    }
    return await provider.generate(prompt, options);
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
   * Updates provider health status based on success/failure.
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
      const result = await provider.generateStream(prompt, handler, options);
      // Mark provider as healthy on success
      this.healthCheckManager?.markServiceHealthy(resolvedName);
      result.resolvedProviderName = resolvedName;
      return result;
    } catch (err) {
      // Mark provider as failed
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager?.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generateStream failed:`, err);
      // Strip provider-specific model from options so fallback providers use their own defaults
      const fallbackOptions = options ? { ...options, model: undefined } : options;
      return this.generateWithFallback(
        resolvedName,
        sessionId,
        (p) => p.generateStream(prompt, handler, fallbackOptions),
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

    // If provider doesn't support tool use, try fallback to configured tool-use providers
    if (provider && !supportsToolUse) {
      logger.warn(
        `[LLMService] Provider "${currentProviderName}" doesn't support tool use, trying tool-use capable providers`,
      );

      // Try each tool-use provider in priority order
      let foundToolUseProvider = false;
      for (const toolProviderName of this.config.toolUseProviders) {
        // Skip unhealthy providers
        if (this.healthCheckManager && !this.healthCheckManager.isServiceHealthySync(toolProviderName)) {
          logger.debug(`[LLMService] Skipping unhealthy tool-use provider "${toolProviderName}"`);
          continue;
        }

        const toolProvider = await this.getAvailableProvider(toolProviderName, sessionId);
        if (toolProvider && this.providerSupportsToolUse(toolProviderName)) {
          provider = toolProvider;
          currentProviderName = toolProviderName;
          foundToolUseProvider = true;
          logger.info(`[LLMService] Using tool-use capable provider "${toolProviderName}"`);
          break;
        }
      }

      if (!foundToolUseProvider) {
        logger.warn('[LLMService] No tool-use capable provider available, will proceed without tool use');
        // Proceed without tool use - just generate normally
        const response = await this.generateMessages(messages, options, providerName);
        // Strip text-based tool calls the model may emit when it sees tool instructions in the prompt
        if (response.text && containsTextToolCalls(response.text)) {
          logger.warn('[LLMService] Stripping text-based tool call blocks from no-tool-use fallback response');
          response.text = stripTextToolCalls(response.text);
        }
        return {
          ...response,
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

      // Always use the resolved provider for subsequent rounds (handles internal fallback)
      if (response.resolvedProviderName) {
        currentProviderName = response.resolvedProviderName;
      }

      // Get all function calls from this response
      const calls = response.functionCalls ?? [];

      if (calls.length === 0) {
        // No tool calls, return final response
        return {
          ...response,
          resolvedProviderName: currentProviderName,
          toolCalls: allToolCalls,
          stopReason: 'end_turn',
        };
      }

      // Execute tools if executor is provided
      if (toolExecutor) {
        // Build assistant message with all tool_calls for this round
        const assistantToolCalls: ChatMessageToolCall[] = [];
        const toolMessages: ChatMessage[] = [];

        // Execute all tool calls in parallel
        const executionResults = await Promise.allSettled(
          calls.map(async (fc, idx) => {
            const callId = fc.toolCallId || `call_${round}_${idx}_${Date.now()}`;
            return { fc, callId, result: await toolExecutor(fc) };
          }),
        );

        for (let idx = 0; idx < executionResults.length; idx++) {
          const settlement = executionResults[idx];
          const fc = calls[idx];
          const callId = fc.toolCallId || `call_${round}_${idx}_${Date.now()}`;

          const toolCall: ChatMessageToolCall = {
            id: callId,
            name: fc.name,
            arguments: fc.arguments,
          };
          // Preserve thoughtSignature for Gemini thinking models.
          if (fc.thoughtSignature) {
            toolCall.thought_signature = fc.thoughtSignature;
          }
          assistantToolCalls.push(toolCall);

          if (settlement.status === 'fulfilled') {
            const toolResult = settlement.value.result;
            allToolCalls.push({ tool: fc.name, result: toolResult });
            toolMessages.push({
              role: 'tool',
              tool_call_id: callId,
              content: JSON.stringify(toolResult),
            });
          } else {
            const errorMessage =
              settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
            logger.error(`[LLMService] Tool execution error (${fc.name}):`, settlement.reason);
            allToolCalls.push({ tool: fc.name, result: null, error: errorMessage });
            toolMessages.push({
              role: 'tool',
              tool_call_id: callId,
              content: `Tool execution failed: ${errorMessage}`,
            });
          }
        }

        // Append single assistant message with all tool_calls, then all tool result messages
        currentMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: assistantToolCalls,
        });
        for (const msg of toolMessages) {
          currentMessages.push(msg);
        }

        if (calls.length > 1) {
          logger.info(`[LLMService] Executed ${calls.length} parallel tool calls in round ${round + 1}`);
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

    // Max rounds reached, force final generation with explicit instruction to produce text answer
    logger.warn(`[LLMService] Max tool rounds (${maxRounds}) reached, forcing final response`);
    currentMessages.push({
      role: 'user',
      content:
        'You have used all available tool rounds. Please provide your final answer now based on the information you have gathered so far. Do not attempt to call any more tools.',
    });
    const finalResponse = await this.generateMessages(currentMessages, options, currentProviderName);

    // Strip text-based tool calls from final text — model may still attempt tool calls via text when tools are absent
    if (finalResponse.text && containsDSML(finalResponse.text)) {
      logger.warn('[LLMService] Stripping DSML text tool call from final response (max rounds exceeded)');
      finalResponse.text = stripDSML(finalResponse.text);
    }
    if (finalResponse.text && containsTextToolCalls(finalResponse.text)) {
      logger.warn('[LLMService] Stripping text-based tool call blocks from final response (max rounds exceeded)');
      finalResponse.text = stripTextToolCalls(finalResponse.text);
    }

    return {
      ...finalResponse,
      resolvedProviderName: currentProviderName,
      toolCalls: allToolCalls,
      stopReason: 'max_rounds',
    };
  }

  /**
   * Check if a named provider supports tool use.
   * Queries the provider instance first (AIProvider.supportsToolUse property),
   * then falls back to the configured toolUseProviders list for backward compatibility.
   */
  providerSupportsToolUse(providerName: string): boolean {
    const provider = this.aiManager.getProviderForCapability('llm', providerName);
    if (provider) {
      return provider.supportsToolUse;
    }
    // Provider not registered — fallback to config list
    return this.config.toolUseProviders.includes(providerName.toLowerCase());
  }

  /**
   * Get alternative provider names for a capability, excluding the specified provider.
   * Ordered by cost (cheapest first) using configured fallbackOrder.
   * Filters out unhealthy providers when health service is available.
   * Providers not in the fallback order list are appended at the end.
   */
  getAlternativeProviderNames(excludeProvider?: string): string[] {
    const allProviders = this.aiManager.getProvidersForCapability('llm');
    const available = allProviders
      .filter((p) => {
        if (p.name === excludeProvider) return false;
        if (!p.isAvailable()) return false;
        // Filter out unhealthy providers
        if (this.healthCheckManager && !this.healthCheckManager.isServiceHealthySync(p.name)) {
          logger.debug(`[LLMService] Excluding unhealthy provider "${p.name}" from alternatives`);
          return false;
        }
        return true;
      })
      .map((p) => p.name);

    // Sort by fallback order (cheapest first); unknown providers go to end
    const orderMap = new Map(this.config.fallback.fallbackOrder.map((name, i) => [name, i]));
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
    fn: (provider: LLMCapability, altName: string) => Promise<AIGenerateResponse>,
    prompt: string,
  ): Promise<AIGenerateResponse> {
    const alternatives = this.getAlternativeProviderNames(failedProvider);
    for (const altName of alternatives) {
      const altProvider = await this.getAvailableProvider(altName, sessionId);
      if (!altProvider) continue;
      try {
        logger.info(`[LLMService] Falling back to provider "${altName}"`);
        const result = await fn(altProvider, altName);
        result.resolvedProviderName = altName;
        return result;
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
   * Rough token estimate for rate-limit budgeting.
   * Not intended to be accurate — just good enough to predict whether
   * we're approaching the TPM window so we can throttle proactively.
   */
  private estimatePromptTokens(prompt: string, options?: AIGenerateOptions): number {
    let charCount = prompt.length;
    if (options?.messages) {
      for (const msg of options.messages) {
        if (typeof msg.content === 'string') {
          charCount += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') charCount += part.text.length;
          }
        }
      }
    }
    // Conservative estimate: ~2.5 chars per token (CJK-heavy content).
    return Math.ceil(charCount / 2.5);
  }

  /**
   * Generate messages with tool support (provider-specific implementation)
   * Passes tools in options; providers that support tool use return functionCalls array.
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

    // Fallback: if no structured functionCalls but text contains DSML, parse it
    if (!response.functionCalls?.length && response.text && containsDSML(response.text)) {
      const dsmlCall = parseDSMLFunctionCall(response.text);
      if (dsmlCall) {
        logger.debug(`[LLMService] Parsed DSML text function call: ${dsmlCall.name}`);
        response.functionCalls = [{ name: dsmlCall.name, arguments: JSON.stringify(dsmlCall.arguments) }];
        response.text = stripDSML(response.text);
      }
    }

    return {
      ...response,
      functionCalls: response.functionCalls,
    };
  }
}
