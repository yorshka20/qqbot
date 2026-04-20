// LLMStage — streaming round-trip.
//
// Uses `llmService.generateStream` so downstream TTS can start synthesizing
// the first sentence while the rest of the reply is still being generated.
// Each flushed sentence-sized chunk is:
//   - parsed for `[LIVE2D: ...]` tags → `avatar.enqueueTagAnimation(tag)`
//   - stripped and forwarded to `avatar.speak(text)` for TTS
//
// On the first flushed chunk we also transition the pose from `thinking`
// back to `neutral`, so the avatar's face matches the audio that's about
// to play. (The pipeline's finally block still sets neutral as a safety
// net for error paths.)
//
// After the stream completes, `ctx.replyText` holds the full accumulated
// text (tags in place) — same contract the non-streaming implementation
// honored, so callers that inspect `replyText` keep working.
//
// Downstream stages check `ctx.streamingHandled` and no-op to avoid
// re-speaking or re-animating the same content.

import { parseLive2DTags, stripLive2DTags } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { Live2DSessionService } from '../Live2DSessionService';
import type { Live2DContext, Live2DStage } from '../Live2DStage';
import { SentenceFlusher } from './SentenceFlusher';

const DEFAULT_PROVIDER = 'deepseek';
const MAX_TOKENS = 256;
const TEMPERATURE = 0.8;

@injectable()
export class LLMStage implements Live2DStage {
  readonly name = 'llm';

  constructor(
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.LIVE2D_SESSION_SERVICE) private sessionService: Live2DSessionService,
  ) {}

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.systemPrompt) {
      ctx.skipped = true;
      ctx.skipReason = 'prompt-render-failed';
      return;
    }

    ctx.providerName = this.resolveProvider();
    ctx.replyText = '';
    ctx.spoken = '';
    ctx.tagCount = 0;

    let firstFlushDone = false;
    const flusher = new SentenceFlusher((chunk) => {
      if (!firstFlushDone) {
        firstFlushDone = true;
        // First audible output — leave the thinking pose so the face matches
        // the audio that's about to play.
        try {
          ctx.avatar?.setActivity({ pose: 'neutral' });
        } catch (err) {
          logger.warn('[Live2D/llm] neutral pose transition failed (non-fatal):', err);
        }
      }

      try {
        const tags = parseLive2DTags(chunk);
        for (const tag of tags) {
          ctx.avatar?.enqueueTagAnimation(tag);
        }
        ctx.tagCount = (ctx.tagCount ?? 0) + tags.length;
      } catch (err) {
        logger.warn('[Live2D/llm] tag parse/enqueue failed (non-fatal):', err);
      }

      const stripped = stripLive2DTags(chunk).trim();
      if (stripped.length > 0 && ctx.avatar) {
        try {
          ctx.avatar.speak(stripped);
        } catch (err) {
          logger.warn('[Live2D/llm] speak dispatch failed (non-fatal):', err);
        }
        ctx.spoken = (ctx.spoken ?? '') + (ctx.spoken ? ' ' : '') + stripped;
      }
    });

    // Prefer the fully-assembled message list from PromptAssemblyStage (scene
    // system + history + final user block). Fall back to the minimal
    // `[system, user]` pair when a caller — e.g. a test — constructs a
    // context without running the assembler.
    const messages = ctx.messages ?? [
      { role: 'system' as const, content: ctx.systemPrompt },
      { role: 'user' as const, content: ctx.input.text },
    ];

    try {
      await this.llmService.generateStream(
        ctx.input.text,
        (delta: string) => {
          ctx.replyText = (ctx.replyText ?? '') + delta;
          flusher.push(delta);
        },
        {
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          messages,
        },
        ctx.providerName,
      );
      flusher.end();
      ctx.streamingHandled = true;
    } catch (err) {
      logger.warn(`[Live2D/llm] stream failed (source=${ctx.input.source} provider=${ctx.providerName}):`, err);
      ctx.skipped = true;
      ctx.skipReason = 'llm-failed';
      return;
    }

    const trimmed = (ctx.replyText ?? '').trim();
    ctx.replyText = trimmed;
    if (trimmed.length === 0) {
      ctx.skipped = true;
      ctx.skipReason = 'empty-reply';
      return;
    }

    // Persist this turn into the rolling session history. The session may
    // not exist when tests construct a bare context without the assembler —
    // guard on `ctx.threadId` so those tests keep passing.
    //
    // `meta.ephemeral === true` means this run was machine-initiated (e.g.
    // the idle-trigger proactive prompt) — we don't want the synthetic user
    // prompt OR the reply to anchor future context, since the real viewers
    // never saw them as dialogue turns. The avatar already spoke the reply
    // over TTS; that's the entire point.
    const ephemeral = ctx.input.meta?.ephemeral === true;
    if (ctx.threadId && !ephemeral) {
      const userId = ctx.input.sender?.uid ?? 'live2d';
      this.sessionService.appendUserMessage(ctx.threadId, userId, ctx.input.text);
      this.sessionService.appendAssistantMessage(ctx.threadId, trimmed);
      this.sessionService.scheduleCompression(ctx.threadId);
    }
  }

  private resolveProvider(): string {
    return this.config.getAIConfig()?.defaultProviders?.llm ?? DEFAULT_PROVIDER;
  }
}
