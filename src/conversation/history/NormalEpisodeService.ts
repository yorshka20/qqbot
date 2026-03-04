import { createHash, randomUUID } from 'node:crypto';

export interface NormalEpisodeState {
  id: string;
  sessionId: string;
  startedAt: Date;
  /** Context window start: initial history is [contextWindowStart, startedAt], max N entries. Kept so context is stable for the whole episode. */
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

  /** Default 5 min: initial context for new episode is [contextWindowStart, startedAt], max N entries. */
  private static readonly CONTEXT_WINDOW_MS = 5 * 60 * 1000;

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
        contextWindowStart: new Date(input.now.getTime() - NormalEpisodeService.CONTEXT_WINDOW_MS),
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

  buildEpisodeKey(sessionId: string, episode: NormalEpisodeState): string {
    return `${sessionId}:episode:${episode.id}`;
  }

  private shouldResetEpisode(
    existing: NormalEpisodeState | undefined,
    input: NormalEpisodeDecisionInput,
  ): boolean {
    if (!existing) return true;
    if (input.now.getTime() - existing.lastTriggerAt.getTime() > this.idleTimeoutMs) {
      return true;
    }
    if (existing.turnCount >= this.maxTurnsPerEpisode) {
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

