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
    deepseek: 'deepseek',
    doubao: 'doubao',
    豆包: 'doubao',
  };

  constructor(private aiManager: AIManager) {}

  route(message: string): ProviderRouteResult {
    const text = message ?? '';

    // Prefix route only (e.g., "claude: ...", "豆包: ...").
    const explicit = this.routeByExplicitPrefix(text);
    if (explicit.providerName) {
      return explicit;
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
    const userMessage = routeResult.isExplicitPrefix ? routeResult.strippedMessage : message ?? '';

    return {
      providerName: routeResult.providerName ?? undefined,
      userMessage,
      reason: routeResult.reason,
      confidence: routeResult.confidence,
      usedExplicitPrefix: routeResult.isExplicitPrefix,
    };
  }

  private routeByExplicitPrefix(message: string): ProviderRouteResult {
    // Colon prefix only, e.g. "gpt: xxx", "claude: xxx", "deepseek: xxx", "豆包: xxx".
    // Supports ASCII and CJK provider aliases, and both ":" / "：" separators.
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
