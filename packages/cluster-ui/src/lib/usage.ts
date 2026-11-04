import type { ClusterTaskUsage } from '@qqbot/api-types';

function trimmed(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/** Token counts at a glance: exact below a thousand, then `k` and `M` with the noise dropped. */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${trimmed(n / 1000, 1)}k`;
  }
  return `${trimmed(n / 1_000_000, 2)}M`;
}

export interface UsageFacts {
  context: string;
  input: string;
  output: string;
  cache: string;
  turns: string;
  cost: string | null;
  final: boolean;
}

const UNKNOWN: UsageFacts = {
  context: '未知',
  input: '未知',
  output: '未知',
  cache: '未知',
  turns: '未知',
  cost: null,
  final: false,
};

export function usageFacts(usage: ClusterTaskUsage | undefined): UsageFacts {
  if (!usage) {
    return { ...UNKNOWN };
  }
  return {
    context: formatTokens(usage.contextTokens),
    input: formatTokens(usage.inputTokens),
    output: formatTokens(usage.outputTokens),
    cache: formatTokens(usage.cacheReadTokens + usage.cacheCreationTokens),
    turns: usage.turns === undefined ? '未知' : String(usage.turns),
    cost: usage.costUsd === undefined ? null : `$${usage.costUsd.toFixed(2)}`,
    final: usage.final === true,
  };
}
