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
      view: 'log' as const,
    };
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  test('a stage that does not exist is no filter at all', () => {
    expect(parseRoute('#/runs?stage=nope').stage).toBeNull();
  });

  test('a view that does not exist is no view at all', () => {
    expect(parseRoute('#/runs/a?view=nope').view).toBeNull();
    expect(parseRoute('#/runs/a').view).toBeNull();
    expect(parseRoute('#/runs/a?view=chat').view).toBe('chat');
  });
});
