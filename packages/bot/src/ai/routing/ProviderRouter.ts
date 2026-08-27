import type { AIManager } from '@/ai/AIManager';

export type ProviderRouteConfidence = 'high' | 'low';

export type ProviderTriggerKind = 'prefix' | 'nickname';

export interface ProviderRouteResult {
  /** Resolved provider, or null when no provider was named (default-nickname or no match). */
  providerName: string | null;
  confidence: ProviderRouteConfidence;
  reason: string;
  /** True only when a concrete provider name was resolved. Drives paid-tier preference. */
  hasExplicitProvider: boolean;
  strippedMessage: string;
  /** null = the message did not trigger provider routing at all. */
  triggerKind: ProviderTriggerKind | null;
}

export interface ProviderReplyRoutingResult {
  providerName?: string;
  userMessage: string;
  reason: string;
  confidence: ProviderRouteConfidence;
  usedExplicitProvider: boolean;
  triggerKind: ProviderTriggerKind | null;
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

  /**
   * Color-nickname aliases. Unlike PREFIX_ALIASES these match anywhere in the
   * message, so longer keys must be tried first (`橙色高手` before `高手`).
   * A null value means "no specific provider" — fall back to the configured default.
   * Colors follow each vendor's brand color (see card styles PROVIDER_THEMES).
   */
  private static readonly NICKNAME_ALIASES: Record<string, string | null> = {
    橙色高手: 'anthropic',
    紫色高手: 'gemini',
    蓝色高手: 'deepseek',
    绿色高手: 'openai',
    青色高手: 'doubao',
    高手: null,
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

  /** Nickname → internal provider name (null = configured default). */
  static getNicknameAliasMap(): Record<string, string | null> {
    return { ...ProviderRouter.NICKNAME_ALIASES };
  }

  constructor(private aiManager: AIManager) {}

  route(message: string): ProviderRouteResult {
    const text = message ?? '';
    const nickname = this.routeByNickname(text);
    if (nickname.triggerKind) {
      return nickname;
    }
    const result = this.routeByExplicitPrefix(text);
    if (result.providerName) {
      return result;
    }
    return {
      providerName: null,
      confidence: 'low',
      reason: 'no_match',
      hasExplicitProvider: false,
      strippedMessage: text,
      triggerKind: null,
    };
  }

  routeReplyInput(message: string): ProviderReplyRoutingResult {
    const routeResult = this.route(message);
    const userMessage = routeResult.triggerKind ? routeResult.strippedMessage : (message ?? '');

    return {
      providerName: routeResult.providerName ?? undefined,
      userMessage,
      reason: routeResult.reason,
      confidence: routeResult.confidence,
      usedExplicitProvider: routeResult.hasExplicitProvider,
      triggerKind: routeResult.triggerKind,
    };
  }

  /**
   * Leading segment-placeholder prefix (e.g. `[Reply:93769]`, `[Image:xxx]`).
   * These are semantic markers inserted by normalizers; they sit before the user's
   * actual text and must be transparent to prefix matching.
   */
  private static readonly LEADING_PLACEHOLDERS_RE = /^(?:\s*\[[^\]]+\]\s*)+/;

  /**
   * Nickname: a known color nickname appears anywhere in the message.
   * Longer nicknames win so that `橙色高手` is not shadowed by the bare `高手`.
   *
   * An empty remainder still counts as a match — deciding whether a bare mention
   * deserves a reply belongs to the trigger layer, not to routing.
   */
  private routeByNickname(message: string): ProviderRouteResult {
    const notMatched: ProviderRouteResult = {
      providerName: null,
      confidence: 'low',
      reason: 'nickname_not_matched',
      hasExplicitProvider: false,
      strippedMessage: message,
      triggerKind: null,
    };

    const trimmedWithPlaceholders = message.trimStart();
    if (!trimmedWithPlaceholders) {
      return notMatched;
    }
    const placeholderMatch = trimmedWithPlaceholders.match(ProviderRouter.LEADING_PLACEHOLDERS_RE);
    const leadingPlaceholders = placeholderMatch ? placeholderMatch[0] : '';
    const trimmed = leadingPlaceholders
      ? trimmedWithPlaceholders.slice(leadingPlaceholders.length)
      : trimmedWithPlaceholders;
    if (!trimmed) {
      return notMatched;
    }

    const lower = trimmed.toLowerCase();
    const nicknames = Object.keys(ProviderRouter.NICKNAME_ALIASES).sort((a, b) => b.length - a.length);
    for (const nickname of nicknames) {
      const idx = lower.indexOf(nickname.toLowerCase());
      if (idx < 0) {
        continue;
      }
      const rest = (trimmed.slice(0, idx) + trimmed.slice(idx + nickname.length).replace(/^[\s,，:：]+/, '')).trim();
      const strippedMessage = leadingPlaceholders + rest;
      const providerName = ProviderRouter.NICKNAME_ALIASES[nickname];
      if (providerName == null) {
        return {
          providerName: null,
          confidence: 'high',
          reason: 'nickname_default',
          hasExplicitProvider: false,
          strippedMessage,
          triggerKind: 'nickname',
        };
      }
      if (!this.isLlmProviderAvailable(providerName)) {
        return {
          providerName: null,
          confidence: 'low',
          reason: 'nickname_provider_unavailable',
          hasExplicitProvider: false,
          strippedMessage: message,
          triggerKind: null,
        };
      }
      return {
        providerName,
        confidence: 'high',
        reason: 'nickname_match',
        hasExplicitProvider: true,
        strippedMessage,
        triggerKind: 'nickname',
      };
    }
    return notMatched;
  }

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
        hasExplicitProvider: false,
        strippedMessage: message,
        triggerKind: null,
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
        hasExplicitProvider: false,
        strippedMessage: message,
        triggerKind: null,
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
          hasExplicitProvider: false,
          strippedMessage: message,
          triggerKind: null,
        };
      }
      return {
        providerName: normalized,
        confidence: 'high',
        reason: 'explicit_prefix',
        hasExplicitProvider: true,
        strippedMessage,
        triggerKind: 'prefix',
      };
    }
    return {
      providerName: null,
      confidence: 'low',
      reason: 'prefix_not_matched',
      hasExplicitProvider: false,
      strippedMessage: message,
      triggerKind: null,
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
