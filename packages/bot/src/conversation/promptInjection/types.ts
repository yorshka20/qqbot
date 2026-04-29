import type { MessageSource } from '@/conversation/sources';
import type { HookContext } from '@/hooks/types';

export interface PromptInjection {
  /** Producer name for debug + ordering. */
  producerName: string;
  /** Sort key — lower runs first / appears earlier in prompt. Default 100. */
  priority?: number;
  /** Final fragment text to inject into system prompt. Empty string = skipped. */
  fragment: string;
}

export interface PromptInjectionContext {
  source: MessageSource;
  userId?: string;
  groupId?: string;
  /** Allow producers to read other context (e.g. recent message text). */
  hookContext: HookContext;
}

export interface PromptInjectionProducer {
  name: string;
  /** When omitted, producer is applicable to every source. */
  applicableSources?: readonly MessageSource[];
  /** Lower runs first in the prompt. Default 100. */
  priority?: number;
  /** Called per-message; must be cheap (no heavy I/O on hot path). */
  produce(ctx: PromptInjectionContext): Promise<PromptInjection | null> | PromptInjection | null;
}
