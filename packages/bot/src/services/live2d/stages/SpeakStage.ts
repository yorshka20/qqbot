// SpeakStage — strip Live2D tags from the reply and dispatch the resulting
// plain text to the avatar's SpeechService (TTS → lip-sync envelope →
// preview audio broadcast).
//
// Responsibility split:
//   - `stripLive2DTags`: removes `[LIVE2D: ...]` markup so the TTS voice
//     isn't reading out bracket soup.
//   - `avatar.speak`: fire-and-forget; SpeechService handles provider
//     selection, RMS envelope computation, and ephemeral layer registration.
//
// Failures here are non-fatal — the avatar animations already played in
// TagAnimationStage, so the caller still gets a useful result if speech
// is misbehaving (e.g. provider 429).
//
// Future enhancements (natural fit here):
//   - Per-source TTS provider override (batch uses a cheaper voice)
//   - SSML wrapping for emphasis / pauses
//   - Text post-processing (number normalization, emoji scrubbing)
//   - Skip TTS in quiet hours while still driving animations

import { stripLive2DTags } from '@qqbot/avatar';
import { injectable } from 'tsyringe';
import { logger } from '@/utils/logger';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

@injectable()
export class SpeakStage implements Live2DStage {
  readonly name = 'speak';

  async execute(ctx: Live2DContext): Promise<void> {
    if (!ctx.avatar || !ctx.replyText) return;

    ctx.spoken = stripLive2DTags(ctx.replyText).trim();
    if (ctx.spoken.length === 0) return;

    try {
      ctx.avatar.speak(ctx.spoken);
    } catch (err) {
      logger.warn('[Live2D/speak] dispatch failed (non-fatal):', err);
    }
  }
}
