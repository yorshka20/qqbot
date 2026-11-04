import { describe, expect, test } from 'bun:test';
import { NO_FILTERS, parseRoute, routeHref } from './route';

describe('route', () => {
  test('an unknown or empty hash lands on the inbox', () => {
    expect(parseRoute('').section).toBe('inbox');
    expect(parseRoute('#/nope').section).toBe('inbox');
  });

  test('a run id, a pin and filters survive the round trip', () => {
    const route = {
      ...NO_FILTERS,
      section: 'runs' as const,
      runId: 'a/b',
      pin: 'c',
      project: 'demo',
      stage: 'running' as const,
    };
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  test('a stage that does not exist is no filter at all', () => {
    expect(parseRoute('#/runs?stage=nope').stage).toBeNull();
  });
});
