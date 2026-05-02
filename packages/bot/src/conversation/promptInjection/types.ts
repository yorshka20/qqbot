import type { MessageSource } from '@/conversation/sources';
import type { HookContext } from '@/hooks/types';

/**
 * Explicit layer for a producer. Replaces the old priority-bisection approach
 * with a named structural concept:
 *   - 'baseline': base.system + stable persona identity (system msg #1)
 *   - 'scene': per-source scene template (system msg #2 front)
 *   - 'runtime': volatile per-message state (system msg #2 middle)
 *   - 'tool': tool instruction block (system msg #2 back)
 */
export type PromptLayer = 'baseline' | 'scene' | 'runtime' | 'tool';

export interface PromptInjection {
  /** Producer name for debug + ordering. */
  producerName: string;
  /** Sort key — intra-layer ordering; lower appears earlier. Default 100. */
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
  /** Determines which system message / position the fragment goes into. */
  layer: PromptLayer;
  /** When omitted, producer is applicable to every source. */
  applicableSources?: readonly MessageSource[];
  /** Intra-layer ordering — lower runs first within the same layer. Default 100. */
  priority?: number;
  /** Called per-message; must be cheap (no heavy I/O on hot path). */
  produce(ctx: PromptInjectionContext): Promise<PromptInjection | null> | PromptInjection | null;
}
