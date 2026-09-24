import { expect, test } from 'bun:test';
import { logger } from './logger';

const marker = 'nofile-log-marker-7f3a';

test('bun test does not open the shared log files', () => {
  expect(process.env.NO_FILE_LOG).toBe('1');
  logger.error(marker);
});
