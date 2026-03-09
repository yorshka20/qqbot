import { describe, expect, it } from 'bun:test';
import { NormalEpisodeService } from '@/conversation/history/NormalEpisodeService';

describe('NormalEpisodeService', () => {
  it('keeps episode within timeout and rotates after timeout', () => {
    const svc = new NormalEpisodeService(1000, 24);
    const first = svc.resolveEpisode({
      sessionId: 'group:1',
      messageId: 'm1',
      now: new Date('2026-01-01T00:00:00.000Z'),
      userMessage: 'hello',
    });
    const second = svc.resolveEpisode({
      sessionId: 'group:1',
      messageId: 'm2',
      now: new Date('2026-01-01T00:00:00.500Z'),
      userMessage: 'hello 2',
    });
    const third = svc.resolveEpisode({
      sessionId: 'group:1',
      messageId: 'm3',
      now: new Date('2026-01-01T00:00:02.100Z'),
      userMessage: 'hello 3',
    });

    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
  });
});
