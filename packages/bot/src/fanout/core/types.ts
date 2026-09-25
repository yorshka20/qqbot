// Shared-prefix fan-out: one long context, several tasks appended after it.
//
// Every task in a run sends the same request envelope (provider, model, system prompt,
// tool list) and the same user-message prefix; only the task suffix differs. That is
// what lets the provider's prefix cache serve every task after the first one.

import type { AIGenerateResponse, ToolResult } from '@/ai/types';
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
  maxTokens: number;
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
 * A task names the tools it may call, but it does not choose the tool list the model
 * sees: that is the union across the run, so the envelope stays identical for every
 * task. Calls outside `tools` are refused at execution time.
 */
export interface FanoutTask<C, P = unknown> {
  readonly name: string;
  readonly tools: readonly string[];
  readonly limits: FanoutTaskLimits;
  parseParams(raw: unknown): P;
  suffix(run: FanoutRun<C>, params: P): string;
  handle(output: FanoutTaskOutput, run: FanoutRun<C>, params: P): Promise<void>;
}

export interface FanoutTaskReport {
  name: string;
  status: 'ok' | 'failed';
  rounds: number;
  usage?: AIGenerateResponse['usage'];
}

export type FanoutRunReport =
  | { status: 'busy' }
  | { status: 'no_tasks' }
  | { status: 'no_context' }
  | { status: 'ran'; tasks: FanoutTaskReport[] };
