// Shared-prefix fan-out: one long context, several tasks appended after it.
//
// Every task in a run sends the same request envelope (provider, model, system prompt,
// tool list) and the same user-message prefix; only the task suffix differs. That is
// what lets the provider's prefix cache serve every task after the first one.

import type { AIGenerateOptions, AIGenerateResponse } from '@qqbot/llm';
import type { ToolResult } from '@/ai/types';
import type { ProtocolName } from '@/core/config/types/protocol';

/** The chat a run belongs to: where its tools deliver and what it is keyed by. */
export interface FanoutTarget {
  chat: 'group' | 'private';
  id: string;
  /** Display name of the chat, as the trigger knows it. */
  name: string;
  protocol: ProtocolName;
}

/** What one run hands each of its tasks. */
export interface FanoutRun<C> {
  ctx: C;
  target: FanoutTarget;
}

export interface FanoutTaskLimits {
  reasoningEffort: NonNullable<AIGenerateOptions['reasoningEffort']>;
  timeout: number;
  maxToolRounds: number;
}

export interface FanoutTaskOutput {
  text: string;
  toolCalls: ToolResult[];
  usage?: AIGenerateResponse['usage'];
}

/**
 * One task appended after a fanout's shared prefix.
 *
 * A live task runs in the run itself. It names the tools it may call, but it does not choose
 * the tool list the model sees: that is the union across the run's live tasks, so the
 * envelope stays identical for every one of them. Calls outside `tools` are refused at
 * execution time.
 *
 * A deferred task does not run in the run: it receives the single-turn request it would have
 * made (the run's system prompt; the prefix followed by its suffix) and runs it its own way,
 * e.g. on a batch API. It has no tools and does not affect the envelope.
 */
export type FanoutTask<C, P = unknown> = LiveFanoutTask<C, P> | DeferredFanoutTask<C, P>;

export interface LiveFanoutTask<C, P = unknown> {
  readonly mode: 'live';
  readonly name: string;
  readonly tools: readonly string[];
  readonly limits: FanoutTaskLimits;
  parseParams(raw: unknown): P;
  suffix(run: FanoutRun<C>, params: P): string;
  handle(output: FanoutTaskOutput, run: FanoutRun<C>, params: P): Promise<void>;
}

export interface DeferredFanoutRequest {
  system: string;
  prompt: string;
}

export interface DeferredFanoutTask<C, P = unknown> {
  readonly mode: 'deferred';
  readonly name: string;
  parseParams(raw: unknown): P;
  suffix(run: FanoutRun<C>, params: P): string;
  defer(request: DeferredFanoutRequest, run: FanoutRun<C>, params: P): Promise<void>;
}

export interface FanoutTaskReport {
  name: string;
  /** `deferred`: handed its request to run elsewhere. */
  status: 'ok' | 'failed' | 'deferred';
  rounds: number;
  usage?: AIGenerateResponse['usage'];
}

export type FanoutRunReport =
  | { status: 'busy' }
  | { status: 'no_tasks' }
  | { status: 'no_context' }
  | { status: 'ran'; tasks: FanoutTaskReport[] };
