// LLMStage — LLM round-trip for the Live2D path.
//
// Default: `llmService.generate` (one request/response, no API streaming) — see
// `avatar.llmStream` and `Live2DInput.meta.llmStream` to use `generateStream` instead.
// For streaming mode, downstream TTS can start on the first sentence while the
// model is still producing tokens. Each flushed sentence-sized chunk is:
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

import { mergeAvatarConfig, type ParsedTag, parseRichTags, stripLive2DTags } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { LLMService } from '@/ai/services/LLMService';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { dispatchTags } from '../dispatchParsedTag';
import type { AvatarMemoryExtractionCoordinator } from '@/integrations/avatar/AvatarMemoryExtractionCoordinator';
import type { AvatarSessionService } from '@/integrations/avatar/AvatarSessionService';
import type { Live2DContext, Live2DStage } from '../Live2DStage';
import { SentenceFlusher } from './SentenceFlusher';

const DEFAULT_PROVIDER = 'deepseek';
/**
 * High enough for `deepseek-reasoner` (and similar APIs): they spend output budget
 * on `reasoning_content` first; a tiny cap leaves `content` empty — no TTS, empty reply.
 */
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.8;

/** Reject instruction/meta leaks from the model (e.g. Gemini under load). */
function isUnusableLive2dReplyText(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) {
    return true;
  }
  if (/^Action tags\b/i.test(t)) {
    return true;
  }
  if (/^Here (is|are) the (action )?tags\b/i.test(t)) {
    return true;
  }
  return false;
}

function describeTag(t: ParsedTag): string {
  switch (t.kind) {
    case 'action':
      return `A:${t.emotion}/${t.action}@${t.intensity.toFixed(2)}`;
    case 'emotion':
      return `E:${t.emotion}@${t.intensity.toFixed(2)}`;
    case 'gaze':
      return `G:${t.target.type}`;
    case 'hold':
      return `H:${t.dur}`;
    case 'walk':
      return `W:${t.motion.type}`;
    case 'headLook':
      return `K:${t.target === null ? 'clear' : `${t.target.yaw ?? 0},${t.target.pitch ?? 0}`}`;
  }
}

@injectable()
export class LLMStage implements Live2DStage {
  readonly name = 'llm';

  constructor(
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.AVATAR_SESSION_SERVICE) private sessionService: AvatarSessionService,
    @inject(DITokens.AVATAR_MEMORY_EXTRACTION_COORDINATOR)
    private memoryExtractionCoordinator: AvatarMemoryExtractionCoordinator,
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

      let tagDescs = '';
      try {
        const tags = parseRichTags(chunk);
        if (ctx.avatar) {
          dispatchTags(tags, ctx, ctx.avatar);
        }
        ctx.tagCount = (ctx.tagCount ?? 0) + tags.length;
        if (tags.length > 0) {
          tagDescs = tags.map(describeTag).join(', ');
        }
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

      // Per-flush visibility: raw chunk, spoken-after-strip, tags enqueued.
      // Kept at info so operators can eyeball what the LLM actually emitted
      // without flipping to debug level (matches the prompt-logging style
      // used by LLMService).
      logger.info(
        `[Live2D/llm] flush | chunk=${JSON.stringify(chunk)} | spoken=${JSON.stringify(stripped)} | tags=[${tagDescs}]`,
      );
    });

    // Prefer the fully-assembled message list from PromptAssemblyStage (scene
    // system + history + final user block). Fall back to the minimal
    // `[system, user]` pair when a caller — e.g. a test — constructs a
    // context without running the assembler.
    const messages = ctx.messages ?? [
      { role: 'system' as const, content: ctx.systemPrompt },
      { role: 'user' as const, content: ctx.input.text },
    ];

    // Allow callers (e.g. Live2DIdleTrigger) to raise the temperature for
    // runs that would otherwise converge — same prompt + similar history
    // back-to-back produces deterministic echoes at the default.
    const metaTemp = ctx.input.meta?.temperature;
    const temperature = typeof metaTemp === 'number' && Number.isFinite(metaTemp) ? metaTemp : TEMPERATURE;

    const streamOpts = {
      maxTokens: MAX_TOKENS,
      temperature,
      messages,
      reasoningEffort: this.resolveReasoningEffort(),
    };

    try {
      if (this.useApiStreaming(ctx)) {
        await this.llmService.generateStream(
          ctx.input.text,
          (delta: string) => {
            ctx.replyText = (ctx.replyText ?? '') + delta;
            flusher.push(delta);
          },
          streamOpts,
          ctx.providerName,
        );
        flusher.end();
        ctx.streamingHandled = true;
      } else {
        const result = await this.llmService.generate(ctx.input.text, streamOpts, ctx.providerName);
        const full = result.text ?? '';
        const te = full.trim();
        if (te.length === 0) {
          ctx.skipped = true;
          ctx.skipReason = 'empty-reply';
          return;
        }
        if (isUnusableLive2dReplyText(te)) {
          logger.warn(
            `[Live2D/llm] rejected bad model output (not sending to TTS): ${JSON.stringify(te.slice(0, 200))}`,
          );
          ctx.skipped = true;
          ctx.skipReason = 'bad-llm-reply';
          return;
        }
        ctx.replyText = full;
        flusher.push(full);
        flusher.end();
        ctx.streamingHandled = true;
      }
    } catch (err) {
      logger.warn(`[Live2D/llm] llm failed (source=${ctx.input.source} provider=${ctx.providerName}):`, err);
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
    if (this.useApiStreaming(ctx) && isUnusableLive2dReplyText(trimmed)) {
      logger.warn(
        `[Live2D/llm] stream produced unusable text (TTS may have started); skipping history+QQ echo: ${JSON.stringify(trimmed.slice(0, 200))}`,
      );
      ctx.skipped = true;
      ctx.skipReason = 'bad-llm-reply';
      return;
    }

    // End-of-stream summary: the full raw reply (tags intact) so operators
    // can grep for a specific action (e.g. `shake_head`) and confirm what
    // the LLM actually emitted vs. what the avatar ended up rendering.
    logger.info(
      `[Live2D/llm] reply complete | source=${ctx.input.source} tags=${ctx.tagCount ?? 0} text=${JSON.stringify(trimmed)}`,
    );

    // Persist this turn into the rolling session history. Both sides
    // (user + assistant) always append — including for idle-trigger runs
    // where the "user" side is a synthetic stage-direction like
    // "(直播间暂时安静)". Keeping the alternation intact matters for two
    // reasons: (1) providers with strict user/assistant alternation stay
    // happy, (2) the LLM sees a normal dialogue rhythm instead of a
    // growing chain of back-to-back assistant turns that encourages
    // self-imitation and repetition.
    if (ctx.threadId) {
      const userId = ctx.input.sender?.uid ?? 'live2d';
      this.sessionService.appendUserMessage(ctx.threadId, userId, ctx.input.text);
      this.sessionService.appendAssistantMessage(ctx.threadId, trimmed);
      this.sessionService.scheduleCompression(ctx.threadId);
      // Debounced memory extraction. No-op when disabled in config, when
      // the source isn't in `avatar.memoryExtraction.allowedSources` (by
      // default only real Bilibili danmaku — `avatar-cmd` / `livemode-*`
      // are test/probe traffic), or when the thread has no groupId.
      // Never blocks the reply path (timer-based).
      this.memoryExtractionCoordinator.schedule(ctx.threadId, ctx.input.source);
    }
  }

  private resolveProvider(): string {
    const raw = this.config.getAvatarConfig();
    if (raw && typeof raw === 'object') {
      const p = (raw as Record<string, unknown>).llmProvider;
      if (typeof p === 'string' && p.trim().length > 0) {
        return p.trim();
      }
    }
    return this.config.getAIConfig()?.defaultProviders?.llm ?? DEFAULT_PROVIDER;
  }

  /** `meta.llmStream` overrides `avatar.llmStream`. */
  private useApiStreaming(ctx: Live2DContext): boolean {
    const meta = ctx.input.meta?.llmStream;
    if (typeof meta === 'boolean') {
      return meta;
    }
    return mergeAvatarConfig(this.config.getAvatarConfig() as Record<string, unknown> | undefined).llmStream ?? false;
  }

  /**
   * Reasoning effort for the avatar/Live2D LLM call. Default `'none'` — the
   * avatar path is pure live roleplay where any hidden `<think>` block is a
   * TTFT tax and tends to drag the model out of character on thinking-capable
   * providers (e.g. Groq qwen3-32b). Configurable via `avatar.llmReasoningEffort`.
   */
  private resolveReasoningEffort(): 'none' | 'minimal' | 'low' | 'medium' | 'high' {
    return mergeAvatarConfig(this.config.getAvatarConfig() as Record<string, unknown> | undefined).llmReasoningEffort;
  }
}
