import { describe, expect, test } from 'bun:test';
import type { ClusterWorkerTemplate } from '@qqbot/api-types';
import { groupTemplates, providerTag } from './templates';

const template = (name: string, type: string, role?: 'planner' | 'executor'): ClusterWorkerTemplate => ({
  name,
  type,
  role,
  command: type,
  maxConcurrent: 1,
  capabilities: [],
  costTier: 'medium',
});

describe('groupTemplates', () => {
  test('splits planners from executors and orders each by name', () => {
    const groups = groupTemplates([
      template('opus-plan', 'claude-cli', 'planner'),
      template('sonnet', 'claude-cli', 'executor'),
      template('codex', 'codex-cli'),
      template('dsh-plan', 'deepseek-cli', 'planner'),
    ]);
    expect(groups.planners.map((t) => t.name)).toEqual(['dsh-plan', 'opus-plan']);
    expect(groups.executors.map((t) => t.name)).toEqual(['codex', 'sonnet']);
  });
});

describe('providerTag', () => {
  test('drops the cli suffix and keeps anything else as it is', () => {
    expect(providerTag('claude-cli')).toBe('claude');
    expect(providerTag('deepseek-cli')).toBe('deepseek');
    expect(providerTag('custom')).toBe('custom');
  });
});
