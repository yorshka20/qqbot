import { createHash } from 'node:crypto';

import { randomUUID } from '@/utils/randomUUID';

export interface NormalEpisodeState {
  id: string;
  sessionId: string;
  startedAt: Date;
  /**
   * Context window start: initial history is [contextWindowStart, startedAt], max N entries. Kept so
   * context is stable for the whole episode; only an explicit cut (`moveContextFloor`) moves it.
   */
  contextWindowStart: Date;
  startMessageId: string;
  lastTriggerAt: Date;
  turnCount: number;
}

export interface NormalEpisodeDecisionInput {
  sessionId: string;
  messageId: string;
  now: Date;
  userMessage: string;
}

/**
 * In-memory episode state for normal mode.
 * Episode boundary is deterministic: reset command, timeout, or max turn count.
 */
export class NormalEpisodeService {
  private readonly RESET_KEYWORDS = ['新话题', '重置上下文', 'reset context', 'new topic'];
  private states = new Map<string, NormalEpisodeState>();
  /** Per session: no episode's context reaches back before this point. */
  private contextFloors = new Map<string, Date>();

  /** Default 10 min: initial context for new episode is [contextWindowStart, startedAt], max N entries. */
  private static readonly CONTEXT_WINDOW_MS = 10 * 60 * 1000;

  /** Episode initial context window: at most this many messages within the 10-min window (stable start for cache). */
  static readonly EPISODE_CONTEXT_WINDOW_SIZE = 10;

  constructor(
    private readonly idleTimeoutMs = 30 * 60 * 1000,
    private readonly maxTurnsPerEpisode = 24,
  ) {}

  resolveEpisode(input: NormalEpisodeDecisionInput): NormalEpisodeState {
    const existing = this.states.get(input.sessionId);
    const shouldReset = this.shouldResetEpisode(existing, input);
    if (!existing || shouldReset) {
      const next: NormalEpisodeState = {
        id: randomUUID(),
        sessionId: input.sessionId,
        startedAt: input.now,
        contextWindowStart: this.windowStartFor(input.sessionId, input.now),
        startMessageId: input.messageId,
        lastTriggerAt: input.now,
        turnCount: 1,
      };
      this.states.set(input.sessionId, next);
      return next;
    }

    existing.lastTriggerAt = input.now;
    existing.turnCount += 1;
    return existing;
  }

  getEpisode(sessionId: string): NormalEpisodeState | undefined {
    return this.states.get(sessionId);
  }

  /** The session's episode if the next message would continue it rather than start a new one. */
  getLiveEpisode(sessionId: string, now: Date): NormalEpisodeState | undefined {
    const existing = this.states.get(sessionId);
    return existing && !this.isSpent(existing, now) ? existing : undefined;
  }

  /**
   * Cut the session's context at `at`: the live episode's window restarts there, and episodes
   * opened later never look back past it — their usual lookback would otherwise pull the
   * discarded messages straight back in.
   */
  moveContextFloor(sessionId: string, at: Date): void {
    this.contextFloors.set(sessionId, at);
    const existing = this.states.get(sessionId);
    if (existing && existing.contextWindowStart < at) {
      existing.contextWindowStart = at;
    }
  }

  buildEpisodeKey(sessionId: string, episode: NormalEpisodeState): string {
    return `${sessionId}:episode:${episode.id}`;
  }

  private windowStartFor(sessionId: string, now: Date): Date {
    const lookback = new Date(now.getTime() - NormalEpisodeService.CONTEXT_WINDOW_MS);
    const floor = this.contextFloors.get(sessionId);
    return floor && floor > lookback ? floor : lookback;
  }

  private isSpent(existing: NormalEpisodeState, now: Date): boolean {
    return (
      now.getTime() - existing.lastTriggerAt.getTime() > this.idleTimeoutMs ||
      existing.turnCount >= this.maxTurnsPerEpisode
    );
  }

  private shouldResetEpisode(existing: NormalEpisodeState | undefined, input: NormalEpisodeDecisionInput): boolean {
    if (!existing) return true;
    if (this.isSpent(existing, input.now)) {
      return true;
    }
    const lower = input.userMessage.toLowerCase();
    if (this.RESET_KEYWORDS.some((k) => lower.includes(k))) {
      return true;
    }
    return false;
  }

  static hashMessages(serialized: string): string {
    return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  }
}
