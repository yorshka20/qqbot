// Live2DPipeline — orchestrator for the shared avatar-reaction path.
//
// This file is deliberately thin. The real work happens in stages under
// `./stages/` (gate → prompt-assembly → llm → tag-animation → speak).
// The pipeline's only concerns are:
//
//   1. Queue admission — a serial (concurrency=1) queue. We intentionally
//      do NOT drop entries: input dedup happens upstream (DanmakuBuffer
//      window-merges identical text; private-chat/livemode routes also
//      aggregate before enqueue), so by the time anything reaches this
//      queue it deserves to be processed. A soft warn threshold logs when
//      the backlog grows abnormally so a wedged stream doesn't go unnoticed.
//
//   2. Stage execution — run the ordered stage list; halt on `ctx.skipped`;
//      collapse the final context into a Live2DResult for the caller.
//
//   3. Pose lifecycle — `setActivity({pose:'thinking'})` before the LLM
//      round-trip, and `{pose:'neutral'}` in finally so failures don't
//      leave the avatar stuck in a transitional pose. This isn't a stage
//      because it must run regardless of skip state.
//
// Two callers share this path today:
//   - AvatarCommandHandler (/avatar <text>) — one-shot, returns the reply
//     so the command posts it back to QQ as a plain text segment.
//   - Bilibili danmaku bridge — batched aggregated danmaku flushed every
//     ~3 seconds; caller discards the reply text (avatar-only effect).
//
// Customizing stages: pass a custom stage array to `setStages()`, or
// inject a differently-constructed pipeline. The defaults live in
// `defaultStageOrder` below and are resolved via DI.

import { inject, injectable, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';
import { contextToResult, createContext, type Live2DStage } from './Live2DStage';
import { GateStage } from './stages/GateStage';
import { LLMStage } from './stages/LLMStage';
import { PromptAssemblyStage } from './stages/PromptAssemblyStage';
import { SpeakStage } from './stages/SpeakStage';
import { TagAnimationStage } from './stages/TagAnimationStage';
import type { Live2DInput, Live2DResult } from '@/integrations/avatar/types';

// Re-export types so existing call sites (`import { Live2DInput } from '…/Live2DPipeline'`)
// keep working after the types moved into `./types`.
export type { Live2DInput, Live2DResult, Live2DSource } from '@/integrations/avatar/types';

/**
 * Soft threshold: when the backlog crosses this, emit a warn so a wedged
 * stream doesn't silently grow the queue. Not a hard cap — we never drop.
 */
const BACKLOG_WARN_THRESHOLD = 16;

interface QueueEntry {
  input: Live2DInput;
  resolve: (r: Live2DResult) => void;
  reject: (e: Error) => void;
}

@injectable()
@singleton()
export class Live2DPipeline {
  /**
   * Default stage order. The order matters — each stage assumes the prior
   * ones populated their context slots. To customize, call `setStages()`
   * with your own ordered array.
   */
  private stages: Live2DStage[];

  private queue: QueueEntry[] = [];
  private running = false;

  constructor(
    @inject(GateStage) gate: GateStage,
    @inject(PromptAssemblyStage) promptAssembly: PromptAssemblyStage,
    @inject(LLMStage) llm: LLMStage,
    @inject(TagAnimationStage) tagAnimation: TagAnimationStage,
    @inject(SpeakStage) speak: SpeakStage,
  ) {
    this.stages = [gate, promptAssembly, llm, tagAnimation, speak];
  }

  /**
   * Replace the pipeline's stage list wholesale. Useful for tests and for
   * future extension points (prefix an enhancer, swap LLM for a mock, etc.).
   * The caller owns ordering — the pipeline doesn't re-sort.
   */
  setStages(stages: Live2DStage[]): void {
    this.stages = stages;
  }

  /** Read-only view of the current stage list, by name. */
  listStages(): string[] {
    return this.stages.map((s) => s.name);
  }

  /**
   * Enqueue an input for pipeline processing. Returns a promise that
   * resolves with the result (including `skipped=true` when dropped).
   * Callers that don't need the reply (bilibili bridge) can ignore it.
   */
  enqueue(input: Live2DInput): Promise<Live2DResult> {
    return new Promise<Live2DResult>((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      // Soft backlog warn — surface wedged streams without dropping work.
      // Threshold is only checked on transitions so one long run doesn't
      // spam the log on every enqueue.
      if (this.queue.length === BACKLOG_WARN_THRESHOLD) {
        logger.warn(
          `[Live2DPipeline] backlog reached ${BACKLOG_WARN_THRESHOLD} entries; pipeline may be wedged (running=${this.running})`,
        );
      }
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        try {
          const result = await this.runStages(entry.input);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Run the stage list against a fresh context, wrapping the body in a
   * pose-lifecycle guard. Each stage's work is logged on failure so the
   * pipeline's overall behavior stays observable even as stages grow.
   */
  private async runStages(input: Live2DInput): Promise<Live2DResult> {
    const ctx = createContext(input);

    for (const stage of this.stages) {
      // Gate runs first and populates `ctx.avatar`; once we have a live
      // avatar handle, enter the thinking pose before subsequent stages
      // (prompt assembly is cheap but LLM is the user-visible latency).
      //
      // Once LLMStage has started streaming, it transitions to `neutral`
      // on first flush — don't overwrite that back to `thinking` on the
      // remaining iterations.
      if (stage.name !== 'gate' && ctx.avatar && !ctx.skipped && !ctx.streamingHandled) {
        ctx.avatar.setActivity({ pose: 'thinking' });
      }

      if (ctx.skipped) break;

      try {
        await stage.execute(ctx);
      } catch (err) {
        // Stages are expected to set skipReason rather than throw. Catching
        // here is a safety net — a bug in one stage shouldn't crash the
        // queue worker.
        logger.error(`[Live2DPipeline] stage "${stage.name}" threw (treating as skipped):`, err);
        ctx.skipped = true;
        ctx.skipReason = ctx.skipReason ?? 'llm-failed';
        break;
      }
    }

    // Always return to neutral when we had an avatar to touch, even on
    // skip / failure. Without this, a failed LLM call would leave the
    // avatar stuck in the thinking pose until the next pipeline run.
    if (ctx.avatar) {
      try {
        ctx.avatar.setActivity({ pose: 'neutral' });
      } catch (err) {
        logger.warn('[Live2DPipeline] neutral pose restore failed (non-fatal):', err);
      }
    }

    return contextToResult(ctx);
  }
}
