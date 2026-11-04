import { describe, expect, test } from 'bun:test';
import { parsePlanningMode, planningState } from './planning';

const running = { status: 'running' } as const;

describe('parsePlanningMode', () => {
  test('accepts the two modes', () => {
    expect(parsePlanningMode('auto')).toBe('auto');
    expect(parsePlanningMode('interactive')).toBe('interactive');
  });

  test('anything else falls back to interactive', () => {
    expect(parsePlanningMode(undefined)).toBe('interactive');
    expect(parsePlanningMode('bogus')).toBe('interactive');
  });
});

describe('planningState', () => {
  test('an executor has no planning state', () => {
    expect(planningState(running, { isPlanner: false, asks: 1, children: 0 })).toBeNull();
  });

  test('a completed planner is done', () => {
    expect(planningState({ status: 'completed' }, { isPlanner: true, asks: 0, children: 1 })).toBe('done');
  });

  test('queued and failed planners have no planning state', () => {
    expect(planningState({ status: 'pending' }, { isPlanner: true, asks: 0, children: 0 })).toBeNull();
    expect(planningState({ status: 'failed' }, { isPlanner: true, asks: 1, children: 0 })).toBeNull();
  });

  test('a running planner discussing with the owner is discussing', () => {
    expect(planningState(running, { isPlanner: true, asks: 1, children: 0 })).toBe('discussing');
  });

  test('once it spawns a child the plan is settled and it is executing', () => {
    expect(planningState(running, { isPlanner: true, asks: 1, children: 1 })).toBe('executing');
  });

  test('a running planner with no question is executing', () => {
    expect(planningState(running, { isPlanner: true, asks: 0, children: 0 })).toBe('executing');
  });
});
