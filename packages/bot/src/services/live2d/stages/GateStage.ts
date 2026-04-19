// GateStage — preconditions for running the Live2DPipeline at all.
//
// Resolves the AvatarService lazily (the subsystem is optional — the bot
// runs fine without it), then checks:
//   - `isActive()` — avatar is configured + started
//   - `hasConsumer()` — a VTS driver or preview WebSocket is attached;
//     without a consumer, the animation compiler is paused and TTS is
//     muted, so spending an LLM round-trip would be wasted.
//
// Short-circuits with a specific `skipReason` for each failure mode so the
// caller can distinguish "disabled" from "no one watching".
//
// Future enhancement targets (not yet implemented):
//   - per-source rate limits (one danmaku burst shouldn't starve /avatar)
//   - quiet hours / mute window

import type { AvatarService } from '@qqbot/avatar';
import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { Live2DContext, Live2DStage } from '../Live2DStage';

@injectable()
export class GateStage implements Live2DStage {
  readonly name = 'gate';

  async execute(ctx: Live2DContext): Promise<void> {
    const avatar = this.resolveAvatar();
    ctx.avatar = avatar;
    if (!avatar?.isActive()) {
      ctx.skipped = true;
      ctx.skipReason = 'avatar-inactive';
      return;
    }
    if (!avatar.hasConsumer()) {
      ctx.skipped = true;
      ctx.skipReason = 'no-consumer';
    }
  }

  private resolveAvatar(): AvatarService | null {
    const container = getContainer();
    if (!container.isRegistered(DITokens.AVATAR_SERVICE)) return null;
    return container.resolve<AvatarService>(DITokens.AVATAR_SERVICE);
  }
}
