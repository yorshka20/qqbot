import type { AIManager } from '@/ai/AIManager';

export type ProviderRouteConfidence = 'high' | 'low';

export interface ProviderRouteResult {
  providerName: string | null;
  confidence: ProviderRouteConfidence;
  reason: string;
  isExplicitPrefix: boolean;
  strippedMessage: string;
}

export interface ProviderReplyRoutingResult {
  providerName?: string;
  userMessage: string;
  reason: string;
  confidence: ProviderRouteConfidence;
  usedExplicitPrefix: boolean;
}

/**
 * ProviderRouter performs request-level provider routing for reply generation.
 * It never persists selection; it only suggests provider for current request.
 */
export class ProviderRouter {
  private static readonly PREFIX_ALIASES: Record<string, string> = {
    claude: 'anthropic',
    gpt: 'openai',
    openai: 'openai',
    gemini: 'gemini',
    deepseek: 'deepseek',
    doubao: 'doubao',
    豆包: 'doubao',
  };

  /** Prefix strings that can trigger provider routing (for MessageTriggerPlugin). Same set as PREFIX_ALIASES keys. */
  static getProviderTriggerPrefixes(): string[] {
    return Object.keys(ProviderRouter.PREFIX_ALIASES);
  }

  constructor(private aiManager: AIManager) {}

  route(message: string): ProviderRouteResult {
    const text = message ?? '';

    // Try colon prefix first (e.g., "claude: ...", "豆包: ...").
    const explicitColon = this.routeByExplicitPrefixColon(text);
    if (explicitColon.providerName) {
      return explicitColon;
    }

    // Then try space-separated prefix (e.g., "claude 你好", "deepseek 写代码").
    const explicitSpace = this.routeByExplicitPrefixSpace(text);
    if (explicitSpace.providerName) {
      return explicitSpace;
    }

    return {
      providerName: null,
      confidence: 'low',
      reason: 'no_match',
      isExplicitPrefix: false,
      strippedMessage: text,
    };
  }

  routeReplyInput(message: string): ProviderReplyRoutingResult {
    const routeResult = this.route(message);
    const userMessage = routeResult.isExplicitPrefix ? routeResult.strippedMessage : (message ?? '');

    return {
      providerName: routeResult.providerName ?? undefined,
      userMessage,
      reason: routeResult.reason,
      confidence: routeResult.confidence,
      usedExplicitPrefix: routeResult.isExplicitPrefix,
    };
  }

  /** Colon prefix only, e.g. "gpt: xxx", "claude: xxx", "豆包: xxx". */
  private routeByExplicitPrefixColon(message: string): ProviderRouteResult {
    const match = message.match(/^\s*([\p{L}][\p{L}\p{N}_-]{0,31})\s*[:：]\s*([\s\S]*)$/u);
    if (!match) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_not_matched',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }

    const rawPrefix = match[1];
    const strippedMessage = (match[2] ?? '').trimStart();
    const normalized = this.normalizeProviderName(rawPrefix);

    if (!normalized || !this.isLlmProviderAvailable(normalized)) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_provider_unavailable',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }

    return {
      providerName: normalized,
      confidence: 'high',
      reason: 'explicit_prefix',
      isExplicitPrefix: true,
      strippedMessage,
    };
  }

  /** Space-separated prefix, e.g. "claude 你好", "deepseek 写代码". First word must be a known provider alias. */
  private routeByExplicitPrefixSpace(message: string): ProviderRouteResult {
    const match = message.match(/^\s*([\p{L}\p{N}_-]+)\s+([\s\S]*)$/u);
    if (!match) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_not_matched',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }

    const rawPrefix = match[1];
    const strippedMessage = (match[2] ?? '').trimStart();
    const normalized = this.normalizeProviderName(rawPrefix);

    if (!normalized || !this.isLlmProviderAvailable(normalized)) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_provider_unavailable',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }

    return {
      providerName: normalized,
      confidence: 'high',
      reason: 'explicit_prefix_space',
      isExplicitPrefix: true,
      strippedMessage,
    };
  }

  private normalizeProviderName(name: string): string | null {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return ProviderRouter.PREFIX_ALIASES[normalized] ?? normalized;
  }

  private isLlmProviderAvailable(providerName: string): boolean {
    const provider = this.aiManager.getProviderForCapability('llm', providerName);
    return Boolean(provider?.isAvailable());
  }
}
