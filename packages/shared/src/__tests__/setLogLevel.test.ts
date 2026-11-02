import { afterEach, expect, test } from 'bun:test';
import { type LogLevel, logger, setLogContextSource, setLogLevel } from '../logger';

const initialLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

afterEach(() => {
  setLogContextSource(null);
  setLogLevel(initialLevel);
});

test('setLogLevel changes what the exported logger writes', () => {
  // The suppress hook runs only for entries that pass the level filter, so it records what
  // would have been written; returning true keeps the test output clean.
  const written: string[] = [];
  setLogContextSource({
    current: () => null,
    suppress: (_target, _level, message) => {
      written.push(message);
      return true;
    },
  });

  setLogLevel('info');
  logger.debug('below-level');
  logger.info('at-level');
  expect(written).toEqual(['at-level']);

  setLogLevel('debug');
  logger.debug('now-enabled');
  expect(written).toEqual(['at-level', 'now-enabled']);

  setLogLevel('error');
  logger.warn('now-suppressed');
  expect(written).toEqual(['at-level', 'now-enabled']);
});
