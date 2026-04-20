// Live2DIdleTrigger — fires a synthetic "there's no danmaku right now"
// prompt at the LLM when a livemode user's buffer has been quiet for a
// while, so the avatar occasionally opens its own mouth instead of only
// replying to inbound text.
//
// Scope: livemode only (for now). Bilibili-live could adopt the same
// pattern later — the trigger would just need to watch that user/room's
// activity too.
//
// Inputs:
//   - `markActivity(userId)` — bootstrap's flush handler calls this on
//     every buffer flush so the clock resets per user.
//   - `start()` / `stop()` — interval timer lifecycle. Called from
//     bootstrap.
//
// Output: on each tick, iterate the currently-enabled proactive users;
// for any user idle for >= `IDLE_THRESHOLD_MS`, enqueue a pipeline run
// with `meta.ephemeral=true` so the synthetic prompt is NOT appended to
// session history (its reply still gets spoken over TTS — the avatar
// "initiates" without polluting the rolling context).
//
// After firing, we update the user's activity clock to "now" so the next
// idle window starts fresh instead of firing back-to-back on every tick.

import { inject, injectable, singleton } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { Live2DPipeline } from './Live2DPipeline';
import type { LivemodeState } from './LivemodeState';

const CHECK_INTERVAL_MS = 15_000;
const IDLE_THRESHOLD_MS = 90_000;
const IDLE_PROMPT_TEXT = '(暂无新弹幕) 请基于最近对话主动聊点轻松的话题，不要重复已经说过的内容，保持直播氛围。';

@injectable()
@singleton()
export class Live2DIdleTrigger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityByUser = new Map<string, number>();

  constructor(
    @inject(DITokens.LIVEMODE_STATE) private state: LivemodeState,
    @inject(DITokens.LIVE2D_PIPELINE) private pipeline: Live2DPipeline,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    logger.info(`[Live2DIdleTrigger] started (checkInterval=${CHECK_INTERVAL_MS}ms threshold=${IDLE_THRESHOLD_MS}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastActivityByUser.clear();
  }

  /** Called by the livemode flush handler — resets the idle clock for this user. */
  markActivity(userId: string | number): void {
    this.lastActivityByUser.set(String(userId), Date.now());
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const userId of this.state.getEnabledUserIds()) {
      if (!this.state.isProactive(userId)) continue;
      const last = this.lastActivityByUser.get(userId) ?? this.state.getEnabledAt(userId) ?? now;
      if (now - last < IDLE_THRESHOLD_MS) continue;

      // Reset clock BEFORE enqueueing so a slow LLM round doesn't cause
      // overlapping idle fires on the next tick.
      this.lastActivityByUser.set(userId, now);

      try {
        await this.pipeline.enqueue({
          text: IDLE_PROMPT_TEXT,
          source: 'livemode-private-batch',
          sender: { uid: userId },
          meta: { scope: userId, idle: true, ephemeral: true },
        });
      } catch (err) {
        logger.warn(`[Live2DIdleTrigger] enqueue failed | userId=${userId}:`, err);
      }
    }
  }
}
