// AvatarIdleTrigger — keeps the livemode conversation alive when viewers
// go quiet by enqueuing a "no danmaku right now" run through the main
// MessagePipeline. The run is NOT treated as a separate flow: it goes
// through the same prompt template and appends to the same session
// history as real-danmaku runs, so the LLM's next reply stays contextual.
//
// Anti-repetition strategy is layered:
//   - Rotate the synthetic kickoff text so the user-side surface varies
//     even when the underlying signal ("nobody's talking") is constant.
//   - Bump temperature for these runs (prompt + history converge across
//     back-to-back idle moments, so 0.8 produces deterministic echoes).
//   - Cap consecutive idle fires — if the chat is truly dead, the avatar
//     stops talking to itself after a couple tries. The cap resets when
//     real user input arrives (markActivity).
//
// `markActivity(userId)` is called from bootstrap's flush handler on
// every real buffer flush, so viewer-generated input both resets the
// idle clock and the consecutive-fire counter.

import { inject, injectable, singleton } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { MessagePipeline } from '@/conversation/MessagePipeline';
import type { MessageProcessingContext } from '@/conversation/types';
import { makeSyntheticEvent } from '@/conversation/synthetic';
import { logger } from '@/utils/logger';
import type { LivemodeState } from './LivemodeState';

const CHECK_INTERVAL_MS = 15_000;
const IDLE_THRESHOLD_MS = 90_000;
/**
 * Higher-than-default temperature for idle fires. The prompt + recent
 * history look near-identical across back-to-back idle moments, so the
 * standard 0.8 tends to produce deterministic echoes. 1.1 adds enough
 * spread to nudge the model into different directions without losing
 * coherence.
 */
const IDLE_TEMPERATURE = 1.1;
/**
 * Pool of neutral stage-direction kickoff strings. The prompt template
 * handles the "how to behave when no one's talking" framing; these
 * strings only vary the literal tokens the LLM sees on the user side,
 * breaking the exact-match prompt that drives repeat outputs.
 */
const IDLE_KICKOFFS = [
  '(直播间暂时安静，没有新弹幕)',
  '(一段时间过去了，观众没说话)',
  '(弹幕区静悄悄的)',
  '(暂时冷场)',
  '(观众看着你，但没人发言)',
];
/**
 * Cap how many times idle fires without any real user input. Real
 * streamers don't talk to dead chat forever; after this many tries we
 * stay silent until viewers come back.
 */
const MAX_CONSECUTIVE_IDLE_FIRES = 2;

@injectable()
@singleton()
export class AvatarIdleTrigger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityByUser = new Map<string, number>();
  private consecutiveIdleByUser = new Map<string, number>();
  /** Round-robin cursor per user into IDLE_KICKOFFS. */
  private kickoffCursorByUser = new Map<string, number>();

  constructor(
    @inject(DITokens.LIVEMODE_STATE) private state: LivemodeState,
    @inject(DITokens.MESSAGE_PIPELINE) private messagePipeline: MessagePipeline,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    logger.info(
      `[AvatarIdleTrigger] started (checkInterval=${CHECK_INTERVAL_MS}ms threshold=${IDLE_THRESHOLD_MS}ms maxConsecutive=${MAX_CONSECUTIVE_IDLE_FIRES})`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastActivityByUser.clear();
    this.consecutiveIdleByUser.clear();
    this.kickoffCursorByUser.clear();
  }

  /**
   * Real viewer activity: resets both the idle clock and the
   * consecutive-fire counter so the avatar can speak proactively again
   * once silence returns.
   */
  markActivity(userId: string | number): void {
    const key = String(userId);
    this.lastActivityByUser.set(key, Date.now());
    this.consecutiveIdleByUser.set(key, 0);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const userId of this.state.getEnabledUserIds()) {
      if (!this.state.isProactive(userId)) continue;
      const last = this.lastActivityByUser.get(userId) ?? this.state.getEnabledAt(userId) ?? now;
      if (now - last < IDLE_THRESHOLD_MS) continue;

      const consecutive = this.consecutiveIdleByUser.get(userId) ?? 0;
      if (consecutive >= MAX_CONSECUTIVE_IDLE_FIRES) {
        // Dead chat — stay silent until markActivity() resets the counter.
        continue;
      }

      // Reset clock BEFORE enqueueing so a slow LLM round doesn't cause
      // overlapping idle fires on the next tick.
      this.lastActivityByUser.set(userId, now);
      this.consecutiveIdleByUser.set(userId, consecutive + 1);

      const kickoff = this.nextKickoff(userId);
      // TODO([4/5]→follow-up): IDLE_TEMPERATURE / scope metadata used to flow via
      // pipeline input meta — restore via MessageProcessingContext extension if needed.
      const event = makeSyntheticEvent({
        source: 'idle-trigger',
        userId: String(userId),
        groupId: null,
        text: kickoff,
        messageType: 'private',
        protocol: 'milky',
      });
      const procContext: MessageProcessingContext = {
        message: event,
        sessionId: `idle-${userId}`,
        sessionType: 'user',
        botSelfId: '',
        source: 'idle-trigger',
      };
      try {
        await this.messagePipeline.process(event, procContext, 'idle-trigger');
      } catch (err) {
        logger.warn(`[AvatarIdleTrigger] enqueue failed | userId=${userId}:`, err);
      }
    }
  }

  private nextKickoff(userId: string): string {
    const cursor = this.kickoffCursorByUser.get(userId) ?? 0;
    this.kickoffCursorByUser.set(userId, (cursor + 1) % IDLE_KICKOFFS.length);
    return IDLE_KICKOFFS[cursor];
  }
}
