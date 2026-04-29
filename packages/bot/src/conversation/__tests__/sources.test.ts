import { describe, expect, it, mock } from 'bun:test';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { SOURCE_VALUES, deriveSourceFromEvent } from '../sources';

function makeEvent(protocol: string, messageType: 'private' | 'group'): NormalizedMessageEvent {
  return {
    id: 'test',
    type: 'message',
    timestamp: Date.now(),
    protocol: protocol as NormalizedMessageEvent['protocol'],
    userId: 1,
    messageType,
    message: '',
    segments: [],
  };
}

describe('deriveSourceFromEvent', () => {
  it('discord + private → discord', () => {
    expect(deriveSourceFromEvent(makeEvent('discord', 'private'))).toBe('discord');
  });

  it('discord + group → discord', () => {
    expect(deriveSourceFromEvent(makeEvent('discord', 'group'))).toBe('discord');
  });

  it('milky + private → qq-private', () => {
    expect(deriveSourceFromEvent(makeEvent('milky', 'private'))).toBe('qq-private');
  });

  it('milky + group → qq-group', () => {
    expect(deriveSourceFromEvent(makeEvent('milky', 'group'))).toBe('qq-group');
  });

  it('onebot11 + private → qq-private', () => {
    expect(deriveSourceFromEvent(makeEvent('onebot11', 'private'))).toBe('qq-private');
  });

  it('onebot11 + group → qq-group', () => {
    expect(deriveSourceFromEvent(makeEvent('onebot11', 'group'))).toBe('qq-group');
  });

  it('satori + private → qq-private', () => {
    expect(deriveSourceFromEvent(makeEvent('satori', 'private'))).toBe('qq-private');
  });

  it('satori + group → qq-group', () => {
    expect(deriveSourceFromEvent(makeEvent('satori', 'group'))).toBe('qq-group');
  });

  it('unknown protocol → qq-private and warns', () => {
    const warnSpy = mock(() => undefined);
    const originalWarn = logger.warn.bind(logger);
    logger.warn = warnSpy;
    try {
      const event = {
        id: 'test',
        type: 'message',
        timestamp: Date.now(),
        protocol: 'unknown' as NormalizedMessageEvent['protocol'],
        userId: 1,
        // Cast to satisfy type — simulate future unknown messageType
        messageType: 'other' as 'private' | 'group',
        message: '',
        segments: [],
      };
      const result = deriveSourceFromEvent(event as NormalizedMessageEvent);
      expect(result).toBe('qq-private');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      logger.warn = originalWarn;
    }
  });
});

describe('SOURCE_VALUES', () => {
  it('has 7 entries', () => {
    expect(SOURCE_VALUES.length).toBe(7);
  });
});
