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
    哈基米: 'gemini',
    deepseek: 'deepseek',
    doubao: 'doubao',
    豆包: 'doubao',
  };

  /** Separator chars after provider prefix: space, comma (EN/CN), colon (EN/CN). */
  private static readonly PREFIX_SEPARATORS = /[\s,，:：]/;

  /** Prefix strings that can trigger provider routing (for MessageTriggerPlugin). Same set as PREFIX_ALIASES keys. */
  static getProviderTriggerPrefixes(): string[] {
    return Object.keys(ProviderRouter.PREFIX_ALIASES);
  }

  /** Alias → internal provider name (for prompts, e.g. prefix-invitation). */
  static getProviderAliasMap(): Record<string, string> {
    return { ...ProviderRouter.PREFIX_ALIASES };
  }

  constructor(private aiManager: AIManager) {}

  route(message: string): ProviderRouteResult {
    const text = message ?? '';
    const result = this.routeByExplicitPrefix(text);
    if (result.providerName) {
      return result;
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

  /**
   * Leading segment-placeholder prefix (e.g. `[Reply:93769]`, `[Image:xxx]`).
   * These are semantic markers inserted by normalizers; they sit before the user's
   * actual text and must be transparent to prefix matching.
   */
  private static readonly LEADING_PLACEHOLDERS_RE = /^(?:\s*\[[^\]]+\]\s*)+/;

  /**
   * Explicit prefix: message starts with a known provider alias followed by a separator.
   * Separator: space, comma (EN , / CN ，), or colon (EN : / CN ：).
   * E.g. "claude xxx", "claude: xxx", "claude，xxx", "claude, xxx", "claude：xxx".
   *
   * Leading `[Reply:xxx]` / `[Image:xxx]` placeholders are skipped during match
   * (reaction-triggered flows and referenced replies include them before the user text),
   * but retained in `strippedMessage` so downstream stages still see the full context.
   */
  private routeByExplicitPrefix(message: string): ProviderRouteResult {
    const trimmedWithPlaceholders = message.trimStart();
    if (!trimmedWithPlaceholders) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_not_matched',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }
    const placeholderMatch = trimmedWithPlaceholders.match(ProviderRouter.LEADING_PLACEHOLDERS_RE);
    const leadingPlaceholders = placeholderMatch ? placeholderMatch[0] : '';
    const trimmed = leadingPlaceholders
      ? trimmedWithPlaceholders.slice(leadingPlaceholders.length)
      : trimmedWithPlaceholders;
    if (!trimmed) {
      return {
        providerName: null,
        confidence: 'low',
        reason: 'prefix_not_matched',
        isExplicitPrefix: false,
        strippedMessage: message,
      };
    }
    const lower = trimmed.toLowerCase();
    const prefixes = ProviderRouter.getProviderTriggerPrefixes();
    for (const prefix of prefixes) {
      if (!lower.startsWith(prefix)) {
        continue;
      }
      const afterPrefix = trimmed.slice(prefix.length);
      if (afterPrefix.length === 0) {
        continue;
      }
      if (!ProviderRouter.PREFIX_SEPARATORS.test(afterPrefix[0])) {
        continue;
      }
      const strippedMessage = leadingPlaceholders + afterPrefix.replace(/^[\s,，:：]+\s*/, '');
      const normalized = this.normalizeProviderName(prefix);
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
    return {
      providerName: null,
      confidence: 'low',
      reason: 'prefix_not_matched',
      isExplicitPrefix: false,
      strippedMessage: message,
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
