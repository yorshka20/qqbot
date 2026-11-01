// LLM Service - provides LLM text generation capability

import { inject, singleton } from 'tsyringe';
import { ProviderSelector } from '@/ai/ProviderSelector';
import { HttpClientError } from '@/api/http/HttpClient';
import { getCurrentMessageContext } from '@/context/MessageContextStorage';
import type { Config } from '@/core/config';
import type { LLMTarget } from '@/core/config/types/ai';
import { DITokens } from '@/core/DITokens';
import { HealthCheckManager } from '@/core/health/HealthCheckManager';
import { END_TURN_TOOL_NAME } from '@/tools/executors/EndTurnToolExecutor';
import { formatLogSections, type LogSection, logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import type { AIManager } from '../AIManager';
import type { LLMCapability } from '../capabilities/LLMCapability';
import { isLLMCapability } from '../capabilities/LLMCapability';
import { foldReasoningIntoContent } from '../prompt/PromptMessageAssembler';
import { TokenRateLimiter, type TokenRateLimiterConfig } from '../rateLimit';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  ChatMessageToolCall,
  ContentPart,
  FunctionCall,
  LLMCallOptions,
  LLMTraceObserver,
  StreamingHandler,
  ToolDefinition,
  ToolResult,
  ToolUseCallOptions,
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

type TokenUsage = NonNullable<AIGenerateResponse['usage']>;

/** A resolved LLM call: the provider instance, and the target it serves with the model made concrete. */
interface Route {
  provider: LLMCapability;
  target: LLMTarget;
}

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
 * Outer hard-timeout for any provider.generate call. Acts as a safety net so
 * a hanging provider (observed: Gemini SDK silently waits past httpOptions.timeout
 * under certain network anomalies) cannot stall the message pipeline indefinitely.
 * Callers can override via AIGenerateOptions.timeout (used both for provider-level
 * HTTP timeout and this guard).
 */
const DEFAULT_GENERATE_HARD_TIMEOUT_MS = 120_000;

function withHardTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[LLMService] ${label} hard-timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * A provider reported success but returned neither text nor tool calls. No caller
 * asks for an empty completion, so it is a failed call, and a silent one: a provider
 * that states why it produced nothing (a non-stop finish reason) throws its own error
 * instead. Observed on DeepSeek as reasoning cut off mid-sentence under
 * `finish_reason: stop`.
 */
export class EmptyCompletionError extends Error {
  constructor(label: string, detail = 'no text, no tool calls') {
    super(`[LLMService] ${label} returned an empty completion (${detail})`);
    this.name = 'EmptyCompletionError';
  }
}

/** Every provider completion LLMService accepts goes through here. */
async function awaitCompletion(
  completion: Promise<AIGenerateResponse>,
  timeoutMs: number,
  label: string,
): Promise<AIGenerateResponse> {
  const result = await withHardTimeout(completion, timeoutMs, label);
  if (!result.text?.trim() && !result.functionCalls?.length) {
    throw new EmptyCompletionError(label);
  }
  return result;
}

/**
 * Turns `generateWithTools` appends after the assembled request envelope. They are
 * plumbing, not user speech, so each says so and points back at `<current_query>` —
 * `base.system.txt` tells the model to read them that way. They stay on the `user`
 * role because a mid-conversation `system` message is not portable across providers
 * (Anthropic and Gemini take their system prompt as a separate top-level field).
 */
const TOOL_IMAGE_NOTICE =
  '[工具补充材料] 以下是工具取回的图片，不是新的用户发言。看完后继续回答 <current_query> 里的问题。';
const TOOL_VISION_NOTICE =
  '[工具补充材料] 以下是工具取回图片的 AI 视觉分析结果，不是新的用户发言。结合它继续回答 <current_query> 里的问题。';
const TOOL_ROUNDS_EXHAUSTED_NOTICE =
  '[系统提示] 工具调用轮次已用尽，不要再调用任何工具。现在直接基于已获得的信息，回答 <current_query> 里的问题。';
const EXEMPT_ROUNDS_EXHAUSTED_NOTICE =
  '[系统提示] 检索类工具的额外轮次已用完，后续检索会开始占用总轮次预算。请基于已查到的内容继续，只在确实缺少关键事实时才再检索。';

/**
 * Ceiling on rounds spent purely on `roundExempt` tools, which are otherwise not
 * charged to the turn's budget. Without it a model that only ever retrieves
 * never advances `round` and the loop cannot terminate — the exemption buys
 * retrieval room, it does not remove the bound.
 */
const DEFAULT_MAX_EXEMPT_ROUNDS = 4;
const END_TURN_VOIDED_NOTICE =
  '[系统提示] 同一轮里有工具调用失败，所以 end_turn 没有生效，本次回复还没结束。先看失败原因，能补救就补救（比如卡片渲染失败就改用文字回复），再和最终内容一起调用 end_turn。那一轮写的文字没有丢，会和你之后的最终文本一起发出，不要重写。';
const END_TURN_REQUIRED_NOTICE =
  '[系统提示] 你上一条只写了文字、没有调用工具，这段文字会照常发出。本次回复要调用 end_turn 才会结束：已经说完就调用 end_turn；还要做别的（比如刚才说要去查的事），现在调用对应的工具。不要把写过的话再写一遍。';

function joinRoundText(held: string, text: string | undefined): string {
  return [held, text?.trim() ?? ''].filter(Boolean).join('\n\n');
}

/**
 * Errors that warrant a same-provider retry before falling back. Covers
 * server-side overload (5xx, rate-limit) and socket-level blips where the
 * response was cut mid-read — observed when DeepSeek's reasoning stalls past
 * an intermediate proxy's ~60s idle timeout, surfacing as
 * "Failed to parse JSON response: The socket connection was closed unexpectedly".
 *
 * Excludes 4xx (client error — retry won't help). Hard-timeouts and
 * AbortError are handled separately via `retryOnTimeout` so the synchronous
 * `generate()` path can fall back faster while background `generateFixed()`
 * jobs can still ride out a slow first attempt.
 */
const TRANSIENT_LLM_ERROR_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\brate[\s_-]?limit/i,
  /\b50[234]\b/,
  /socket.*(closed|hang[\s_-]?up)/i,
  /\b(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
  /Failed to parse JSON response/i,
  /closed unexpectedly/i,
];

const HARD_TIMEOUT_PATTERN = /hard-timeout|Request timeout/i;

export function isTransientLLMError(err: Error, opts?: { retryOnTimeout?: boolean }): boolean {
  // A silent empty completion is worth another try on the same provider. A provider
  // that says why it produced nothing (e.g. "no content (finish_reason=length)")
  // throws a plain error that matches no pattern below, so it goes straight to fallback.
  if (err instanceof EmptyCompletionError) {
    return true;
  }
  const msg = err.message;
  if (HARD_TIMEOUT_PATTERN.test(msg) || err.name === 'AbortError') {
    return opts?.retryOnTimeout ?? false;
  }
  // Prefer the HTTP status over the message text: a provider's error body may not
  // echo the status code (e.g. Anthropic 529 reads only "Overloaded"). Retry on
  // rate-limit (429) and any server-side error (5xx incl. 529); other 4xx are
  // client errors where a retry won't help.
  if (err instanceof HttpClientError && err.status !== undefined) {
    if (err.status === 429 || err.status >= 500) return true;
    if (err.status >= 400) return false;
  }
  return TRANSIENT_LLM_ERROR_PATTERNS.some((p) => p.test(msg));
}

/**
 * Where a call sits in its conversation. generateWithTools sends one growing message
 * list every round under one id; any other call is a conversation of its own.
 */
interface ConversationRound {
  conversationId: string;
  /** Leading messages that earlier rounds of the conversation already sent. */
  sentCount: number;
}

function newConversation(): ConversationRound {
  return { conversationId: randomUUID(), sentCount: 0 };
}

function promptLogSection(message: ChatMessage, toolNames: Map<string, string>): LogSection {
  const toolName = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
  const text = message.content === undefined ? '' : contentToPlainString(message.content);
  const lines = [...(text ? [text] : []), ...(message.tool_calls ?? []).map((c) => `→ ${c.name} ${c.arguments}`)];
  return { label: toolName ? `${message.role}:${toolName}` : message.role, content: lines.join('\n') };
}

/**
 * LLM Service
 * Provides LLM text generation capability
 */
@singleton()
export class LLMService {
  private readonly providersWithNativeWebSearch = ['doubao', 'anthropic'];

  /** Service configuration (tool-use providers + fallback) */
  private readonly config: LLMServiceConfig;

  /** Token rate limiter for per-provider TPM enforcement */
  private readonly rateLimiter: TokenRateLimiter;

  /** Observers notified after every completed LLM call (e.g. dump-to-markdown). */
  private readonly traceObservers: LLMTraceObserver[] = [];

  /** Register an observer for completed LLM calls. Observers are invoked in a
   *  try/catch so a faulty observer never breaks generation. */
  addTraceObserver(observer: LLMTraceObserver): void {
    this.traceObservers.push(observer);
  }

  /** Build a trace entry from a completed call and fan it out to observers. */
  private emitTrace(
    opLabel: string,
    provider: string,
    prompt: string,
    options: AIGenerateOptions | undefined,
    result: AIGenerateResponse,
    startedAt: number,
    conversationId: string,
  ): void {
    if (this.traceObservers.length === 0) return;
    const entry = {
      opLabel,
      conversationId,
      provider,
      resolvedModel: result.resolvedModel,
      systemPrompt: options?.systemPrompt,
      prompt,
      messages: options?.messages,
      tools: options?.tools,
      response: {
        text: result.text,
        functionCalls: result.functionCalls,
        usage: result.usage,
        reasoningContent: result.reasoningContent,
      },
      durationMs: Date.now() - startedAt,
      sessionId: options?.sessionId,
      turnKey: getCurrentMessageContext()?.logTag,
    };
    for (const observer of this.traceObservers) {
      try {
        observer(entry);
      } catch (err) {
        logger.warn('[LLMService] trace observer failed:', err);
      }
    }
  }

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(ProviderSelector) private providerSelector: ProviderSelector,
    @inject(HealthCheckManager) private healthCheckManager: HealthCheckManager,
    @inject(DITokens.CONFIG) config: Config,
  ) {
    const aiConfig = config.getAIConfig();
    if (!aiConfig?.llmFallback) {
      throw new Error('[LLMService] ai.llmFallback is required in config');
    }
    this.config = {
      toolUseProviders: aiConfig.toolUseProviders ?? [],
      fallback: aiConfig.llmFallback,
      rateLimit: aiConfig.rateLimit
        ? {
            defaultTokensPerMinute: aiConfig.rateLimit.defaultTokensPerMinute ?? 0,
            providers: aiConfig.rateLimit.providers,
          }
        : undefined,
    };
    this.rateLimiter = new TokenRateLimiter(this.config.rateLimit);
  }

  /**
   * Run a provider operation with same-provider transient retry. Returns
   * the op result on success, or throws the last error after retries are
   * exhausted (or immediately, for non-transient errors). Callers handle
   * fallback after this throws.
   *
   * In-flight retries are silent — `markServiceUnhealthy` is left to the
   * caller so a single network blip doesn't blacklist a provider for
   * concurrent requests. Only the final, propagated failure should mark
   * the provider unhealthy.
   */
  private async runWithProviderRetry<T>(
    providerName: string,
    op: () => Promise<T>,
    opts?: { maxRetries?: number; retryDelayMs?: number; opLabel?: string; retryOnTimeout?: boolean },
  ): Promise<T> {
    const maxRetries = opts?.maxRetries ?? 1;
    const retryDelayMs = opts?.retryDelayMs ?? 1500;
    const label = opts?.opLabel ?? 'generate';

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= maxRetries) break;
        if (!isTransientLLMError(lastError, { retryOnTimeout: opts?.retryOnTimeout })) break;
        const backoffMs = Math.min(retryDelayMs * 2 ** attempt, 30_000);
        logger.warn(
          `[LLMService] ${label} on "${providerName}" transient error, retrying in ${backoffMs}ms (${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastError ?? new Error(`[LLMService] ${label} failed`);
  }

  /**
   * Get fallback response when no provider is available.
   *
   * Never derives task-shaped content from the prompt: callers such as summarization
   * feed the result straight back into conversation state, where an invented
   * "summary" is indistinguishable from a real one.
   */
  private getFallbackResponse(_prompt: string): AIGenerateResponse {
    return {
      text: 'I apologize, but AI service is currently unavailable. Please try again later.',
    };
  }

  /**
   * The provider a call routed to `target` (or, without one, by session/default) would
   * run on. Capability probes (`supportsToolUse`, `supportsNativeWebSearch`) and external
   * services use this; generation entry points resolve the full route themselves.
   */
  async getAvailableProvider(target?: LLMTarget, sessionId?: string): Promise<LLMCapability | null> {
    const route = await this.resolveRoute(target, sessionId);
    return route?.provider ?? null;
  }

  /**
   * Where a call routed to `target` (or, without one, by session/default) would run: the
   * provider instance and the target with its model made concrete. Callers that must know
   * the model before generating (the prompt's model identity) read it here.
   */
  async resolveTarget(
    target?: LLMTarget,
    sessionId?: string,
  ): Promise<{ provider: LLMCapability; target: LLMTarget } | null> {
    const route = await this.resolveRoute(target, sessionId);
    return route ? { provider: route.provider, target: route.target } : null;
  }

  /** The default LLM, for background jobs that call `generateFixed` without a target of their own. */
  getDefaultLLM(): LLMTarget | null {
    return this.aiManager.getDefaultLLM();
  }

  /**
   * Resolve the route of a generation call: an explicit `target`, else the session's
   * override, else the default LLM.
   *
   * - An explicit target is honored even when its provider is marked unhealthy — it is
   *   attempted once and the caller's catch path runs the fallback chain. This preserves
   *   explicit intent (e.g. `claude,` prefix routing).
   * - A session/default route whose provider is unhealthy is swapped to the first healthy
   *   provider in the fallback order, on that provider's own model.
   *
   * The model always travels with its provider: a route that ends up on a different
   * provider than the one requested drops the requested model with it.
   */
  private async resolveRoute(target: LLMTarget | undefined, sessionId: string | undefined): Promise<Route | null> {
    let route: Route | null = null;

    if (target) {
      route = this.routeTo(target);
      if (!route) {
        logger.warn(
          `[LLMService] Requested provider "${target.provider}" is not registered or not available; falling back to default`,
        );
      }
    } else if (sessionId) {
      const sessionTarget = await this.providerSelector.getSessionOverride(sessionId, 'llm');
      if (sessionTarget) {
        route = this.routeTo(sessionTarget);
      }
    }

    if (!route) {
      const defaultTarget = this.aiManager.getDefaultLLM();
      route = defaultTarget ? this.routeTo(defaultTarget) : null;
    }
    if (!route) return null;

    const providerName = route.target.provider;
    if (!this.healthCheckManager.isServiceHealthySync(providerName)) {
      if (target) {
        logger.warn(
          `[LLMService] Explicit provider "${providerName}" is marked unhealthy; attempting anyway (honoring caller intent)`,
        );
      } else {
        logger.warn(`[LLMService] Provider "${providerName}" is unhealthy, trying healthy fallback`);
        const healthyFallback = this.getFirstHealthyRoute(providerName);
        if (healthyFallback) return healthyFallback;
        logger.warn(`[LLMService] No healthy fallback available, proceeding with "${providerName}"`);
      }
    }
    return route;
  }

  /** The registered provider for `target`, with the target's model made concrete; null when unavailable. */
  private routeTo(target: LLMTarget): Route | null {
    const provider = this.aiManager.getProviderForCapability('llm', target.provider);
    if (!provider || !isLLMCapability(provider) || !provider.isAvailable()) {
      return null;
    }
    return { provider, target: { provider: target.provider, model: target.model ?? provider.getDefaultModel?.() } };
  }

  /** The model that actually served a call: what the provider reported wins (Gemini
   *  swaps to the paid model mid-call), then the target's model. Stamped centrally so
   *  providers don't each have to remember to report it. */
  private stampResolvedModel(result: AIGenerateResponse, target: LLMTarget): void {
    result.resolvedModel = result.resolvedModel ?? target.model;
  }

  /**
   * The first healthy provider in the fallback order, on its own model.
   */
  private getFirstHealthyRoute(excludeProvider: string): Route | null {
    for (const name of this.getHealthyFallbackProviders(this.config.fallback.fallbackOrder, excludeProvider)) {
      const route = this.routeTo({ provider: name });
      if (route) {
        logger.info(`[LLMService] Using healthy fallback provider "${name}"`);
        return route;
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
      return this.healthCheckManager.isServiceHealthySync(name);
    });
  }

  async supportsNativeWebSearch(target?: LLMTarget, sessionId?: string): Promise<boolean> {
    const route = await this.resolveRoute(target, sessionId);
    return route ? this.providerSupportsNativeWebSearch(route.target.provider) : false;
  }

  async supportsToolUse(target?: LLMTarget, sessionId?: string): Promise<boolean> {
    const route = await this.resolveRoute(target, sessionId);
    return route ? this.providerSupportsToolUse(route.target.provider) : false;
  }

  /**
   * Generate text using a **fixed** provider with retry-only (no fallback).
   *
   * Use this for cost-sensitive background tasks (article analysis, batch processing)
   * where falling back to an expensive provider would be wasteful.
   *
   * @param providerName  Required — the provider to pin to.
   * @param prompt        The prompt text.
   * @param options       Generation options.
   * @param retryConfig   Retry configuration for transient errors.
   * @throws Error if provider is unavailable or all retries exhausted.
   */
  async generateFixed(
    target: LLMTarget,
    prompt: string,
    options: LLMCallOptions,
    retryConfig?: { maxRetries?: number; retryDelayMs?: number },
  ): Promise<AIGenerateResponse> {
    const maxRetries = retryConfig?.maxRetries ?? 3;
    const retryDelayMs = retryConfig?.retryDelayMs ?? 2000;

    // Resolve the target strictly — no fallback to default or session provider
    const route = this.routeTo(target);
    if (!route) {
      throw new Error(`[LLMService] generateFixed: provider "${target.provider}" is not available`);
    }
    const { provider } = route;
    const providerName = route.target.provider;

    const estimatedTokens = this.estimatePromptTokens(prompt, options);
    await this.rateLimiter.waitForCapacity(estimatedTokens, providerName);
    this.logLLMPrompt(providerName, options, 0);

    const startedAt = Date.now();
    try {
      const result = await this.runWithProviderRetry(
        providerName,
        async () => {
          const hardTimeoutMs = options?.timeout ?? DEFAULT_GENERATE_HARD_TIMEOUT_MS;
          return await awaitCompletion(
            provider.generate(prompt, this.optionsForProvider(provider, options, route.target)),
            hardTimeoutMs,
            `generateFixed:${providerName}`,
          );
        },
        { maxRetries, retryDelayMs, opLabel: 'generateFixed', retryOnTimeout: true },
      );
      if (result.usage) {
        this.rateLimiter.recordUsage(result.usage.totalTokens, providerName);
      }
      result.resolvedProviderName = providerName;
      this.stampResolvedModel(result, route.target);
      this.logLLMUsage(providerName, prompt, options, result);
      this.emitTrace('generateFixed', providerName, prompt, options, result, startedAt, randomUUID());
      this.healthCheckManager.markServiceHealthy(providerName);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.healthCheckManager.markServiceUnhealthy(providerName, error.message);
      throw error;
    }
  }

  /**
   * Generate text using LLM capability.
   * Automatically falls back to alternative providers on runtime failure.
   * Updates provider health status based on success/failure.
   */
  async generate(prompt: string, options: LLMCallOptions, target?: LLMTarget): Promise<AIGenerateResponse> {
    return this.generateInRound(prompt, options, target, newConversation());
  }

  /**
   * A tool loop may finish silently only when the turn has already produced
   * something the user can see. `end_turn` is a claim that the round's other
   * output went through; when the provider dropped its final text and emitted
   * only the tool call, the claim is false and the turn is an empty completion,
   * not a deliberate silent finish.
   *
   * Gemini 3 thinking models are the observed source: the whole answer can stay
   * in a `thought` part while the visible text is empty, so the reasoning exists
   * but never becomes output. Passing `allowEmptyEndTurn` covers the legitimate
   * case where content came from an earlier round or the held text.
   */
  private assertEndTurnHasContent(
    result: AIGenerateResponse,
    options: LLMCallOptions,
    allowEmptyEndTurn: boolean,
    label: string,
  ): void {
    if (allowEmptyEndTurn || result.text?.trim()) {
      return;
    }
    const calls = result.functionCalls ?? [];
    if (!calls.some((call) => call.name === END_TURN_TOOL_NAME)) {
      return;
    }
    const contentCall = (options.tools ?? []).some(
      (tool) => tool.deliversContent && calls.some((call) => call.name === tool.name),
    );
    if (contentCall) {
      return;
    }
    logger.warn(
      `[LLMService] ${label} ended with end_turn but produced no visible content ` +
        `(reasoning=${result.reasoningContent?.length ?? 0} chars, tokens=${result.usage?.totalTokens ?? 'unknown'}); ` +
        'treating it as an empty completion',
    );
    throw new EmptyCompletionError(label, 'end_turn without any user-visible content');
  }

  /** `generate()` for one round of a conversation, possibly a later round of a tool loop. */
  private async generateInRound(
    prompt: string,
    options: LLMCallOptions,
    target: LLMTarget | undefined,
    round: ConversationRound,
    allowEmptyEndTurn = false,
  ): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const route = await this.resolveRoute(target, sessionId);

    // If no available provider, return fallback response
    if (!route) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      return this.getFallbackResponse(prompt);
    }

    const { provider } = route;
    const resolvedName = route.target.provider;

    // Rate limit: wait for token capacity before calling the provider.
    // Estimate prompt tokens from content length (rough: 1 token ≈ 3 chars for CJK, 4 for latin).
    const estimatedTokens = this.estimatePromptTokens(prompt, options);
    await this.rateLimiter.waitForCapacity(estimatedTokens, resolvedName);
    this.logLLMPrompt(resolvedName, options, round.sentCount);

    const startedAt = Date.now();
    try {
      const result = await this.runWithProviderRetry(
        resolvedName,
        async () => {
          const hardTimeoutMs = options?.timeout ?? DEFAULT_GENERATE_HARD_TIMEOUT_MS;
          const result = await awaitCompletion(
            provider.generate(prompt, this.optionsForProvider(provider, options, route.target)),
            hardTimeoutMs,
            `generate:${resolvedName}`,
          );
          this.assertEndTurnHasContent(result, options, allowEmptyEndTurn, `generate:${resolvedName}`);
          return result;
        },
        // Two backoff retries (1.5s, 3s) before falling back: rides out brief
        // upstream overload (e.g. Anthropic 529) without delaying the reply too much.
        { opLabel: 'generate', maxRetries: 2 },
      );
      // Record actual token usage for rate limiting
      if (result.usage) {
        this.rateLimiter.recordUsage(result.usage.totalTokens, resolvedName);
      }
      result.resolvedProviderName = resolvedName;
      this.stampResolvedModel(result, route.target);
      this.logLLMUsage(resolvedName, prompt, options, result);
      this.emitTrace('generate', resolvedName, prompt, options, result, startedAt, round.conversationId);
      // Mark provider as healthy on success
      this.healthCheckManager.markServiceHealthy(resolvedName);
      return result;
    } catch (err) {
      // Mark provider as failed
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generate failed:`, err);
      return this.generateWithFallback(
        resolvedName,
        (alt) => {
          const t = options?.timeout ?? DEFAULT_GENERATE_HARD_TIMEOUT_MS;
          const label = `generate-fallback:${alt.target.provider}`;
          return awaitCompletion(
            alt.provider.generate(prompt, this.optionsForProvider(alt.provider, options, alt.target)),
            t,
            label,
          ).then((result) => {
            this.assertEndTurnHasContent(result, options, allowEmptyEndTurn, label);
            return result;
          });
        },
        prompt,
      );
    }
  }

  /**
   * Generate with lite defaults (low temperature, small maxTokens) for cheap/fast tasks (e.g. prefix-invitation, analysis).
   * Supports an explicit target (e.g. doubao / doubao-1-5-lite-32k-250115).
   */
  async generateLite(prompt: string, options: LLMCallOptions, target?: LLMTarget): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const route = await this.resolveRoute(target, sessionId);

    if (!route) {
      logger.warn('[LLMService] No available LLM provider for generateLite, returning fallback response');
      return this.getFallbackResponse(prompt);
    }

    const resolvedName = route.target.provider;
    const mergedOptions: LLMCallOptions = {
      temperature: 0.1,
      ...options,
    };

    this.logLLMPrompt(resolvedName, mergedOptions, 0);

    const startedAt = Date.now();
    try {
      const result = await this.runWithProviderRetry(
        resolvedName,
        async () => {
          const hardTimeoutMs = mergedOptions?.timeout ?? DEFAULT_GENERATE_HARD_TIMEOUT_MS;
          return await awaitCompletion(
            this.invokeLiteGeneration(route, prompt, mergedOptions),
            hardTimeoutMs,
            `generateLite:${resolvedName}`,
          );
        },
        { opLabel: 'generateLite' },
      );
      result.resolvedProviderName = resolvedName;
      this.stampResolvedModel(result, route.target);
      this.logLLMUsage(resolvedName, prompt, mergedOptions, result);
      this.emitTrace('generateLite', resolvedName, prompt, mergedOptions, result, startedAt, randomUUID());
      this.healthCheckManager.markServiceHealthy(resolvedName);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generateLite failed:`, err);
      return this.generateWithFallback(
        resolvedName,
        (alt) => {
          const t = mergedOptions.timeout ?? DEFAULT_GENERATE_HARD_TIMEOUT_MS;
          return awaitCompletion(this.invokeLiteGeneration(alt, prompt, mergedOptions), t, `generateLite-fallback`);
        },
        prompt,
      );
    }
  }

  /** Invoke generateLite on provider if supported, otherwise fall back to generate with lite defaults. */
  private async invokeLiteGeneration(
    route: Route,
    prompt: string,
    options: LLMCallOptions,
  ): Promise<AIGenerateResponse> {
    const { provider } = route;
    const providerOptions = this.optionsForProvider(provider, options, route.target);
    const cap = provider as { generateLite?: (p: string, o?: AIGenerateOptions) => Promise<AIGenerateResponse> };
    if (typeof cap.generateLite === 'function') {
      return await cap.generateLite(prompt, providerOptions);
    }
    return await provider.generate(prompt, providerOptions);
  }

  /**
   * Generate using prebuilt role-based messages (OpenAI-standard ChatMessage[]). Each provider converts to its own format.
   */
  private async generateFromMessages(
    messages: ChatMessage[],
    options: Omit<LLMCallOptions, 'messages'>,
    target: LLMTarget | undefined,
    round: ConversationRound,
  ): Promise<AIGenerateResponse> {
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = lastContent !== undefined ? contentToPlainString(lastContent) : '';
    return this.generateInRound(prompt, { ...options, messages }, target, round);
  }

  /**
   * Generate text with streaming.
   * Automatically falls back to alternative providers on runtime failure.
   * Updates provider health status based on success/failure.
   */
  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options: LLMCallOptions,
    target?: LLMTarget,
  ): Promise<AIGenerateResponse> {
    const sessionId = options?.sessionId;
    const route = await this.resolveRoute(target, sessionId);

    // If no available provider, return fallback response
    if (!route) {
      logger.warn('[LLMService] No available LLM provider, returning fallback response');
      const fallbackResponse = this.getFallbackResponse(prompt);
      handler(fallbackResponse.text);
      return fallbackResponse;
    }

    const { provider } = route;
    const resolvedName = route.target.provider;
    this.logLLMPrompt(resolvedName, options, 0);

    const startedAt = Date.now();
    try {
      const result = await provider.generateStream(
        prompt,
        handler,
        this.optionsForProvider(provider, options, route.target),
      );
      // Mark provider as healthy on success
      this.healthCheckManager.markServiceHealthy(resolvedName);
      result.resolvedProviderName = resolvedName;
      this.stampResolvedModel(result, route.target);
      this.emitTrace('generateStream', resolvedName, prompt, options, result, startedAt, randomUUID());
      return result;
    } catch (err) {
      // Mark provider as failed
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.healthCheckManager.markServiceUnhealthy(resolvedName, errorMessage);
      logger.error(`[LLMService] Provider "${resolvedName}" generateStream failed:`, err);
      return this.generateWithFallback(
        resolvedName,
        (alt) =>
          alt.provider.generateStream(prompt, handler, this.optionsForProvider(alt.provider, options, alt.target)),
        prompt,
      );
    }
  }

  /**
   * Generate with tool/function calling support
   * Implements multi-round tool calling loop
   */
  async generateWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ToolUseCallOptions,
    target?: LLMTarget,
  ): Promise<ToolUseGenerateResponse> {
    // No tools — short-circuit to plain generate.
    if (tools.length === 0) {
      const response = await this.generateFromMessages(messages, options, target, newConversation());
      await this.emitReasoning(response, options, [], new Set(), target?.provider);
      return { ...response, stopReason: 'end_turn', openingPromptTokens: response.usage?.promptTokens };
    }

    const sessionId = options?.sessionId;
    const maxRounds = options?.maxToolRounds;
    const toolExecutor = options?.toolExecutor;

    // The loop resolves its route once; every round then runs on an explicit target.
    let currentTarget = (await this.resolveRoute(target, sessionId))?.target;

    // If provider doesn't support tool use, try fallback to configured tool-use providers
    if (currentTarget && !this.providerSupportsToolUse(currentTarget.provider)) {
      logger.warn(
        `[LLMService] Provider "${currentTarget.provider}" doesn't support tool use, trying tool-use capable providers`,
      );

      // Try each tool-use provider in priority order
      let foundToolUseProvider = false;
      for (const toolProviderName of this.config.toolUseProviders) {
        // Skip unhealthy providers
        if (!this.healthCheckManager.isServiceHealthySync(toolProviderName)) {
          logger.debug(`[LLMService] Skipping unhealthy tool-use provider "${toolProviderName}"`);
          continue;
        }

        const toolRoute = this.routeTo({ provider: toolProviderName });
        if (toolRoute && this.providerSupportsToolUse(toolProviderName)) {
          currentTarget = toolRoute.target;
          foundToolUseProvider = true;
          logger.info(`[LLMService] Using tool-use capable provider "${toolProviderName}"`);
          break;
        }
      }

      if (!foundToolUseProvider) {
        logger.warn('[LLMService] No tool-use capable provider available, will proceed without tool use');
        // Proceed without tool use - just generate normally
        const response = await this.generateFromMessages(messages, options, target, newConversation());
        await this.emitReasoning(response, options, [], new Set(), target?.provider);
        // Strip text-based tool calls the model may emit when it sees tool instructions in the prompt
        if (response.text && containsTextToolCalls(response.text)) {
          logger.warn('[LLMService] Stripping text-based tool call blocks from no-tool-use fallback response');
          response.text = stripTextToolCalls(response.text);
        }
        return {
          ...response,
          stopReason: 'end_turn',
          openingPromptTokens: response.usage?.promptTokens,
        };
      }
    }

    if (!currentTarget) {
      logger.warn('[LLMService] No available provider for tool use');
      return {
        ...this.getFallbackResponse(contentToPlainString(messages[messages.length - 1]?.content ?? '')),
        stopReason: 'end_turn',
      };
    }

    const currentMessages = [...messages];
    let round = 0;
    const conversationId = randomUUID();
    let sentCount = 0;
    const allToolCalls: ToolResult[] = [];
    // Accumulate token usage across every round so the returned response reports
    // the full cost of the tool-augmented generation, not just the final round.
    const accUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let sawUsage = false;
    let openingPromptTokens: number | undefined;
    // Thinking from every round, not just the last: on a tool-using turn the
    // reasoning that chose the tools is usually the interesting part, and the
    // final round's `reasoningContent` alone would drop it. Reported per round via
    // emitReasoning (before that round's tools run) rather than joined at the end.
    const accReasoning: string[] = [];
    const seenReasoning = new Set<string>();
    // A loop that offers end_turn ends only through it. Writing text and stopping is
    // ambiguous: a heads-up the model failed to follow with its tool call looks exactly
    // like a final reply. Such a round is held and the model is asked whether it is done;
    // the next round decides what the text was.
    const requiresEndTurn = toolExecutor !== undefined && tools.some((tool) => tool.name === END_TURN_TOOL_NAME);
    let heldText = '';
    // Rounds spent only on roundExempt (retrieval) tools are charged here instead
    // of to `round`, so looking something up never costs the model the room to act
    // on it. Bounded separately — see DEFAULT_MAX_EXEMPT_ROUNDS.
    const exemptToolNames = new Set(tools.filter((tool) => tool.roundExempt).map((tool) => tool.name));
    let exemptRoundsUsed = 0;
    // Tools that put something in front of the user (a card, a message, a voice
    // message, a reaction, an image). A silent end_turn is valid only after one
    // of them succeeded, or after this turn's text was delivered.
    const contentToolNames = new Set(tools.filter((tool) => tool.deliversContent).map((tool) => tool.name));
    let contentDelivered = false;

    while (maxRounds === undefined || round < maxRounds) {
      // Generate with tools
      const response = await this.generateMessagesWithToolSupport(
        currentMessages,
        tools,
        options,
        currentTarget,
        { conversationId, sentCount },
        contentDelivered || heldText.trim().length > 0,
      );
      sentCount = currentMessages.length;
      sawUsage = this.accumulateUsage(accUsage, response.usage) || sawUsage;
      if (round === 0) {
        openingPromptTokens = response.usage?.promptTokens;
      }
      await this.emitReasoning(response, options, accReasoning, seenReasoning, currentTarget.provider);

      // A round served by a fallback provider moves the rest of the loop there, on that
      // provider's own model — the previous target's model means nothing to it.
      if (response.resolvedProviderName && response.resolvedProviderName !== currentTarget.provider) {
        currentTarget = { provider: response.resolvedProviderName };
      }

      // Surface the provider/model that actually served this round before its tool
      // calls run, so mid-loop tools (e.g. send_card footer) can report the truth.
      options?.onProviderResolved?.({ providerName: currentTarget.provider, model: response.resolvedModel });

      // Get all function calls from this response
      const calls = response.functionCalls ?? [];

      if (calls.length === 0) {
        if (!requiresEndTurn) {
          return {
            ...response,
            usage: sawUsage ? { ...accUsage } : response.usage,
            reasoningContent: accReasoning.length > 0 ? accReasoning.join('\n\n---\n\n') : undefined,
            resolvedProviderName: currentTarget.provider,
            toolCalls: allToolCalls,
            openingPromptTokens,
            stopReason: 'end_turn',
          };
        }
        heldText = joinRoundText(heldText, response.text);
        if (maxRounds !== undefined && round + 1 >= maxRounds) {
          logger.warn(
            `[LLMService] Round ${round + 1} wrote text without end_turn and no round is left to ask; ending`,
          );
          return {
            ...response,
            text: heldText,
            usage: sawUsage ? { ...accUsage } : response.usage,
            reasoningContent: accReasoning.length > 0 ? accReasoning.join('\n\n---\n\n') : undefined,
            resolvedProviderName: currentTarget.provider,
            toolCalls: allToolCalls,
            openingPromptTokens,
            stopReason: 'max_rounds',
          };
        }
        logger.info(`[LLMService] Round ${round + 1} wrote text without end_turn; asking whether the turn is done`);
        currentMessages.push(LLMService.assistantTurn(response, currentTarget.provider));
        currentMessages.push({ role: 'user', content: END_TURN_REQUIRED_NOTICE });
        round++;
        continue;
      }

      // Execute tools if executor is provided
      if (toolExecutor) {
        const roundText = joinRoundText(heldText, response.text);
        heldText = '';
        await this.emitToolRoundText(roundText, calls, options);
        // Text written beside non-end_turn tools is delivered by the caller, so it
        // counts as user-visible output for a later silent end_turn.
        if (roundText.trim() && options.onToolRoundText && !calls.some((call) => call.name === END_TURN_TOOL_NAME)) {
          contentDelivered = true;
        }

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

        // Collect vision content parts from tool results (e.g. fetch_image)
        const pendingVisionParts: ContentPart[] = [];
        // Set when a tool signalled end-of-turn (end_turn): finish this round's
        // bookkeeping, then exit the loop without asking the model for more.
        let endTurnRequested = false;
        let endTurnMessageIndex = -1;
        let roundHadFailure = false;

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
            let toolResult = settlement.value.result;
            let callFailed = false;

            // Extract loop-control sentinel from wrapped tool results (end_turn)
            if (toolResult && typeof toolResult === 'object' && '__endTurn' in (toolResult as object)) {
              const wrapped = toolResult as { __endTurn: boolean; result: unknown };
              endTurnRequested = endTurnRequested || wrapped.__endTurn;
              endTurnMessageIndex = toolMessages.length;
              toolResult = wrapped.result;
            }

            if (toolResult && typeof toolResult === 'object' && '__failed' in (toolResult as object)) {
              roundHadFailure = true;
              callFailed = true;
              toolResult = (toolResult as { __failed: true; result: unknown }).result;
            }

            // Extract vision content parts from wrapped tool results
            if (toolResult && typeof toolResult === 'object' && '__contentParts' in (toolResult as object)) {
              const wrapped = toolResult as { __contentParts: ContentPart[]; result: unknown };
              pendingVisionParts.push(...wrapped.__contentParts);
              toolResult = wrapped.result;
            }

            if (!callFailed && contentToolNames.has(fc.name)) {
              contentDelivered = true;
            }

            allToolCalls.push({ tool: fc.name, result: toolResult });
            // Strings pass through as-is so the model sees natural text; objects get
            // serialized to JSON. JSON.stringify on a string would wrap it in quotes
            // (`"text"`) and escape internal newlines, which is harder for the model
            // to read and inflates tokens.
            const toolContent = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            toolMessages.push({
              role: 'tool',
              tool_call_id: callId,
              content: toolContent,
            });
          } else {
            const errorMessage =
              settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
            logger.error(`[LLMService] Tool execution error (${fc.name}):`, settlement.reason);
            roundHadFailure = true;
            allToolCalls.push({ tool: fc.name, result: null, error: errorMessage });
            toolMessages.push({
              role: 'tool',
              tool_call_id: callId,
              content: `Tool execution failed: ${errorMessage}`,
            });
          }
        }

        // The model calls end_turn beside its last actions on the assumption they go through.
        // When one fails, ending would drop it silently (a failed card leaves no reply at all),
        // so the end is void: the model sees the failure and closes the turn again. The
        // round's text was not delivered (it was meant as the final text), so it is held.
        if (endTurnRequested && roundHadFailure) {
          logger.info(`[LLMService] end_turn in round ${round + 1} voided by a failed tool call in the same round`);
          endTurnRequested = false;
          toolMessages[endTurnMessageIndex] = { ...toolMessages[endTurnMessageIndex], content: END_TURN_VOIDED_NOTICE };
          heldText = roundText;
        }

        // Append single assistant message with all tool_calls, then all tool result messages.
        // Keep any text the model emitted alongside the calls — every provider mapper
        // handles assistant text + tool_calls together, and dropping it would blind the
        // model to its own words in later rounds.
        // Preserve reasoning_content for thinking models (required by DeepSeek; ignored by others).
        // Stamp the serving provider so a later provider (after mid-loop fallback) can tell
        // foreign tool_calls turns (fold/degrade for signature compatibility) from its own
        // (replay verbatim so the model keeps its first-person action record).
        currentMessages.push(LLMService.assistantTurn(response, currentTarget.provider, assistantToolCalls));
        for (const msg of toolMessages) {
          currentMessages.push(msg);
        }

        // Inject vision content from tool results as a user message
        if (pendingVisionParts.length > 0) {
          const currentProvider = this.aiManager.getProvider(currentTarget.provider);
          const supportsVision = currentProvider?.supportsCapability('vision') ?? false;

          if (supportsVision) {
            // Provider supports vision — inject image content parts directly
            // Images have to ride in a user message — `tool` messages are text-only on
            // every provider here — so the text part says what this turn actually is,
            // and base.system tells the model to keep answering <current_query>.
            currentMessages.push({
              role: 'user',
              content: [{ type: 'text' as const, text: TOOL_IMAGE_NOTICE }, ...pendingVisionParts],
            });
          } else {
            // Provider doesn't support vision — use vision provider to describe the image, inject as text
            const description = await this.describeImageWithVisionProvider(pendingVisionParts);
            currentMessages.push({
              role: 'user',
              content: `${TOOL_VISION_NOTICE}\n${description}`,
            });
          }
          logger.info(
            `[LLMService] Injected ${pendingVisionParts.length} vision content part(s) from tool results (directVision=${supportsVision})`,
          );
        }

        if (calls.length > 1) {
          logger.info(`[LLMService] Executed ${calls.length} parallel tool calls in round ${round + 1}`);
        }

        // A tool declared the turn over (end_turn): exit without another LLM call.
        // Any text the model emitted alongside the tool calls still flows out via
        // `text` — the dispatcher decides delivery; nothing is silently dropped here.
        if (endTurnRequested) {
          logger.info(`[LLMService] end_turn called in round ${round + 1}, ending turn`);
          return {
            ...response,
            text: roundText,
            usage: sawUsage ? { ...accUsage } : response.usage,
            reasoningContent: accReasoning.length > 0 ? accReasoning.join('\n\n---\n\n') : undefined,
            resolvedProviderName: currentTarget.provider,
            toolCalls: allToolCalls,
            openingPromptTokens,
            stopReason: 'end_turn_tool',
          };
        }
      } else {
        // No executor provided, return the function call for external handling
        return {
          ...response,
          usage: sawUsage ? { ...accUsage } : response.usage,
          reasoningContent: accReasoning.length > 0 ? accReasoning.join('\n\n---\n\n') : undefined,
          toolCalls: allToolCalls,
          openingPromptTokens,
          stopReason: 'tool_use',
        };
      }

      // A round that only retrieved is charged to the exempt budget, not to `round`.
      // "Only": one non-exempt call alongside means the model also acted, so the
      // round is ordinary — otherwise pairing any tool with a search would make it free.
      const retrievalOnlyRound = calls.every((fc) => exemptToolNames.has(fc.name));
      if (retrievalOnlyRound && exemptRoundsUsed < DEFAULT_MAX_EXEMPT_ROUNDS) {
        exemptRoundsUsed++;
        logger.debug(
          `[LLMService] Round ${round + 1} was retrieval-only; charged to exempt budget (${exemptRoundsUsed}/${DEFAULT_MAX_EXEMPT_ROUNDS})`,
        );
        if (exemptRoundsUsed === DEFAULT_MAX_EXEMPT_ROUNDS) {
          currentMessages.push({ role: 'user', content: EXEMPT_ROUNDS_EXHAUSTED_NOTICE });
        }
        continue;
      }

      round++;
    }

    // Max rounds reached, force final generation with explicit instruction to produce text answer
    logger.warn(`[LLMService] Max tool rounds (${maxRounds}) reached, forcing final response`);
    currentMessages.push({ role: 'user', content: TOOL_ROUNDS_EXHAUSTED_NOTICE });
    const finalResponse = await this.generateFromMessages(currentMessages, options, currentTarget, {
      conversationId,
      sentCount,
    });
    sawUsage = this.accumulateUsage(accUsage, finalResponse.usage) || sawUsage;
    await this.emitReasoning(finalResponse, options, accReasoning, seenReasoning, currentTarget.provider);

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
      text: joinRoundText(heldText, finalResponse.text),
      usage: sawUsage ? { ...accUsage } : finalResponse.usage,
      reasoningContent: accReasoning.length > 0 ? accReasoning.join('\n\n---\n\n') : undefined,
      resolvedProviderName: currentTarget.provider,
      toolCalls: allToolCalls,
      openingPromptTokens,
      stopReason: 'max_rounds',
    };
  }

  /**
   * Report one round's thinking to the caller as soon as it lands, and record it
   * for the turn-level total.
   *
   * `seen` is what keeps a block from being reported twice: the same response is
   * reachable by more than one path (a round that also ends the turn), and a
   * provider may repeat identical reasoning across rounds.
   */
  private async emitReasoning(
    response: AIGenerateResponse,
    options: ToolUseGenerateOptions | undefined,
    acc: string[],
    seen: Set<string>,
    provider: string | undefined,
  ): Promise<void> {
    const text = response.reasoningContent?.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    acc.push(text);
    if (!options?.onReasoning) {
      return;
    }
    try {
      await options.onReasoning(text, response.resolvedProviderName ?? provider);
    } catch (err) {
      logger.warn('[LLMService] onReasoning callback failed:', err);
    }
  }

  /** The loop-transcript entry for what a round said, with what each provider needs to replay it. */
  private static assistantTurn(
    response: AIGenerateResponse,
    provider: string,
    toolCalls?: ChatMessageToolCall[],
  ): ChatMessage {
    const message: ChatMessage = { role: 'assistant', content: response.text ?? '', provider };
    if (toolCalls) {
      message.tool_calls = toolCalls;
    }
    if (response.reasoningContent) {
      message.reasoning_content = response.reasoningContent;
    }
    if (response.thinkingBlocks?.length) {
      message.thinking_blocks = response.thinkingBlocks;
    }
    return message;
  }

  /**
   * Hand the text a tool round wrote to the caller before the round's tools run. A
   * failing callback is logged and swallowed: whatever the caller does with the text,
   * it must not cost the turn its tools or its reply.
   */
  private async emitToolRoundText(
    roundText: string,
    calls: FunctionCall[],
    options: ToolUseGenerateOptions | undefined,
  ): Promise<void> {
    const text = roundText.trim();
    if (!text || !options?.onToolRoundText) {
      return;
    }
    try {
      await options.onToolRoundText(text, calls);
    } catch (err) {
      logger.warn('[LLMService] onToolRoundText callback failed:', err);
    }
  }

  /**
   * Add a single response's token usage into an accumulator. Returns true when
   * usage was present (so callers can tell "summed real numbers" from "no usage
   * reported at all" and avoid emitting a misleading all-zero total).
   */
  private accumulateUsage(acc: TokenUsage, usage?: TokenUsage): boolean {
    if (!usage) return false;
    acc.promptTokens += usage.promptTokens;
    acc.completionTokens += usage.completionTokens;
    acc.totalTokens += usage.totalTokens;
    if (usage.cachedPromptTokens !== undefined) {
      acc.cachedPromptTokens = (acc.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
    }
    return true;
  }

  /**
   * Use a vision-capable provider to describe image content parts as text.
   * Called when the current LLM provider doesn't support vision but tool results contain images.
   */
  private async describeImageWithVisionProvider(visionParts: ContentPart[]): Promise<string> {
    const visionProvider = this.aiManager.getDefaultProvider('vision');
    if (!visionProvider || !isLLMCapability(visionProvider)) {
      logger.warn('[LLMService] No vision-capable provider available for image description');
      return '[图片内容无法分析：没有可用的视觉分析模型]';
    }

    const visionProviderName = 'name' in visionProvider ? (visionProvider as { name: string }).name : 'unknown';

    try {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text' as const,
              text: '请详细描述这张图片的内容。如果图片中包含文字、代码、表格等，请完整识别并输出。',
            },
            ...visionParts,
          ],
        },
      ];

      const result = await visionProvider.generate('', {
        messages,
        temperature: 0.1,
        reasoningEffort: 'none',
      });

      logger.info(`[LLMService] Vision provider "${visionProviderName}" described image: ${result.text.length} chars`);
      return result.text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[LLMService] Vision provider "${visionProviderName}" failed to describe image: ${errMsg}`);
      return `[图片内容分析失败: ${errMsg}]`;
    }
  }

  /**
   * Options adapted to what this provider does with an assistant turn's reasoning.
   *
   * Reasoning is carried on `reasoning_content` so it never appears in the text a model
   * reads as its own output format. A provider that declares `echoesReasoningNatively`
   * puts the field on its own API channel; for the rest the field would be dropped, so it
   * is folded into the turn's text here.
   *
   * This has to be decided against the provider that will actually run, not the one the
   * turn was assembled for — `generateWithFallback` hands the call to a different provider
   * after a failure, and its options object is already built by then.
   */
  private optionsForProvider(provider: LLMCapability, options: LLMCallOptions, target: LLMTarget): AIGenerateOptions {
    const providerOptions: AIGenerateOptions = { ...options, model: target.model };
    if (!providerOptions.messages?.length) {
      return providerOptions;
    }
    if ((provider as { echoesReasoningNatively?: boolean }).echoesReasoningNatively) {
      return providerOptions;
    }
    return { ...providerOptions, messages: foldReasoningIntoContent(providerOptions.messages) };
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
        if (!this.healthCheckManager.isServiceHealthySync(p.name)) {
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
   * Try alternative providers in fallback order after the primary provider failed.
   * Returns a fallback text response if all alternatives also fail.
   */
  private async generateWithFallback(
    failedProvider: string,
    fn: (alt: Route) => Promise<AIGenerateResponse>,
    prompt: string,
  ): Promise<AIGenerateResponse> {
    const alternatives = this.getAlternativeProviderNames(failedProvider);
    for (const altName of alternatives) {
      // An alternative runs on its own model: the failed target's model belongs to the failed provider.
      const alt = this.routeTo({ provider: altName });
      if (!alt) continue;
      try {
        logger.info(`[LLMService] Falling back to provider "${altName}"`);
        const result = await fn(alt);
        result.resolvedProviderName = altName;
        this.stampResolvedModel(result, alt.target);
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
   * Log structured LLM usage info for daily stats parsing.
   * Format: [LLMService] usage | provider=X | promptTokens=X | completionTokens=X | totalTokens=X | promptChars=X | responseChars=X
   */
  private logLLMUsage(
    provider: string,
    prompt: string,
    options: AIGenerateOptions | undefined,
    result: AIGenerateResponse,
  ): void {
    const promptChars = this.countPromptChars(prompt, options);
    const responseChars = result.text?.length ?? 0;
    const pt = result.usage?.promptTokens ?? 0;
    const ct = result.usage?.completionTokens ?? 0;
    const tt = result.usage?.totalTokens ?? 0;
    const cached = result.usage?.cachedPromptTokens;
    // [STATS] tag: daily stats parses this line for token/char usage — do not remove.
    // The cache field goes last so DailyStatsBackend's positional pattern still matches.
    logger.info(
      `[STATS] [LLMService] usage | provider=${provider} | promptTokens=${pt} | completionTokens=${ct} | totalTokens=${tt} | promptChars=${promptChars} | responseChars=${responseChars}${cached === undefined ? '' : ` | cachedPromptTokens=${cached}`}`,
    );
  }

  /**
   * Log one entry per LLM call: a header line, then the part of the request that is
   * not already on record, one section per message.
   *
   * System messages and a bare `prompt` are template renders whose text lives in
   * `prompts/`, so only the header records them; the dynamic part of a request is
   * its user / assistant / tool messages. When `options.messages` is set, providers
   * ignore `prompt` altogether. The first `sentCount` messages were logged by an
   * earlier round of the same tool loop, which re-sends the whole conversation.
   */
  private logLLMPrompt(provider: string, options: AIGenerateOptions, sentCount: number): void {
    const messages = options.messages ?? [];
    const fresh = sentCount > 0 ? ` | new=${messages.length - sentCount}` : '';
    const header = `[LLMService] prompt | provider=${provider} | messages=${messages.length}${fresh}`;
    const toolNames = new Map(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => [c.id, c.name] as const)));
    const sections = messages
      .slice(sentCount)
      .filter((m) => m.role !== 'system')
      .map((m) => promptLogSection(m, toolNames));
    logger.info(sections.length > 0 ? `${header}\n${formatLogSections(sections)}` : header);
  }

  /** Count total prompt character length including messages. */
  private countPromptChars(prompt: string, options?: AIGenerateOptions): number {
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
    return charCount;
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
    options: ToolUseCallOptions,
    target: LLMTarget,
    round: ConversationRound,
    allowEmptyEndTurn: boolean,
  ): Promise<ToolUseGenerateResponse> {
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = lastContent !== undefined ? contentToPlainString(lastContent) : '';
    const response = await this.generateInRound(
      prompt,
      { ...options, messages, tools },
      target,
      round,
      allowEmptyEndTurn,
    );

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
