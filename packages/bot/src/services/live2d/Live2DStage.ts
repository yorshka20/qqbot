// Live2DStage — the shared contract that every pipeline step implements.
// Each stage is a small, independently-testable unit with its own DI
// dependencies. The pipeline runs them in order, respecting the `skipped`
// short-circuit: once a stage sets `skipped=true`, subsequent stages are
// skipped and the pipeline resolves the caller's promise.
//
// Keep this interface tiny on purpose. The intent is that each concrete
// stage can evolve (retries, caching, provider routing) behind its own
// class without touching the orchestrator.

import type { AvatarService } from '@qqbot/avatar';
import type { Live2DInput, Live2DResult } from './types';

export interface Live2DContext {
  /** Input passed to `Live2DPipeline.enqueue`. Immutable from stages. */
  readonly input: Live2DInput;

  /**
   * Avatar handle. Populated by GateStage on the happy path — subsequent
   * stages may assume it's non-null because the pipeline halts on `skipped`.
   * Stages should still guard with `if (!ctx.avatar) return;` to keep
   * typechecks noise-free.
   */
  avatar: AvatarService | null;

  /** Formatted action-map for prompt injection. Populated by PromptAssemblyStage. */
  availableActions?: string;
  /** Rendered system prompt. Populated by PromptAssemblyStage. */
  systemPrompt?: string;
  /** LLM provider name chosen for this input. Populated by LLMStage. */
  providerName?: string;
  /** Raw LLM reply — tags still embedded. Populated by LLMStage. */
  replyText?: string;
  /** Spoken text (tags stripped). Populated by SpeakStage. */
  spoken?: string;
  /** Count of Live2D tags actually enqueued onto the compiler. */
  tagCount?: number;

  /** Terminal: when true, remaining stages are skipped. */
  skipped: boolean;
  /** Machine-readable reason — surfaced through the result for caller branching. */
  skipReason?: string;
}

/**
 * A single pipeline step. Stages receive the shared context, mutate fields
 * they own, and set `ctx.skipped=true` to halt the remainder. They must
 * not throw for recoverable failures — log + skipReason instead — so one
 * misbehaving dependency doesn't abort the whole pipeline.
 */
export interface Live2DStage {
  /** Unique identifier; used for logging + future `insertBefore`/`after` hooks. */
  readonly name: string;
  execute(ctx: Live2DContext): Promise<void>;
}

/** Build an initial context from an input. Exported so tests can construct one. */
export function createContext(input: Live2DInput): Live2DContext {
  return {
    input,
    avatar: null,
    skipped: false,
  };
}

/** Collapse a finished context into the caller-facing result. */
export function contextToResult(ctx: Live2DContext): Live2DResult {
  return {
    replyText: ctx.replyText ?? '',
    spoken: ctx.spoken ?? '',
    tagCount: ctx.tagCount ?? 0,
    skipped: ctx.skipped,
    skipReason: ctx.skipReason,
  };
}
