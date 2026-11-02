import { describe, expect, test } from 'bun:test';
import type { AgentExecutor, ExecutorModel } from '../executors';
import { AgentRunOptionsError, checkRunOptions, resolveRunOptions } from '../runOptions';

const MODELS: ExecutorModel[] = [
  { id: 'model-a', efforts: ['low', 'medium', 'high'] },
  { id: 'model-b', efforts: ['low'] },
];

function fakeExecutor(overrides: Partial<AgentExecutor> = {}): AgentExecutor & { listed: number } {
  const executor = {
    name: 'codex' as const,
    displayName: 'Fake',
    coAuthorTrailer: '',
    defaultModel: 'model-a',
    defaultEffort: undefined,
    listed: 0,
    async listModels() {
      executor.listed++;
      return MODELS;
    },
    async buildInvocation() {
      throw new Error('unused');
    },
    finalMessage: (stdout: string) => stdout,
    ...overrides,
  };
  return executor;
}

describe('checkRunOptions', () => {
  test('a typo in the model is refused and the valid models are listed', () => {
    expect(() => checkRunOptions('codex', MODELS, 'model-x', { model: 'model-x' })).toThrow(
      new AgentRunOptionsError('未知模型 "model-x"。codex 可用模型：model-a, model-b'),
    );
  });

  test('an effort the model does not support is refused with its supported efforts', () => {
    expect(() => checkRunOptions('codex', MODELS, 'model-b', { model: 'model-b', effort: 'high' })).toThrow(
      '模型 model-b 不支持强度 "high"。可用强度：low',
    );
  });

  test('an effort alone is checked against the default model', () => {
    expect(() => checkRunOptions('codex', MODELS, 'model-a', { effort: 'medium' })).not.toThrow();
    expect(() => checkRunOptions('codex', MODELS, 'model-a', { effort: 'ultra' })).toThrow(AgentRunOptionsError);
  });
});

describe('resolveRunOptions', () => {
  test('no options uses the defaults without reading the catalog', async () => {
    const executor = fakeExecutor({ defaultEffort: 'medium' });
    expect(await resolveRunOptions(executor, {})).toEqual({ model: 'model-a', effort: 'medium' });
    expect(executor.listed).toBe(0);
  });

  test('explicit options are validated and returned', async () => {
    const executor = fakeExecutor();
    expect(await resolveRunOptions(executor, { model: 'model-b', effort: 'low' })).toEqual({
      model: 'model-b',
      effort: 'low',
    });
    expect(executor.listed).toBe(1);
  });

  test('an invalid option rejects', async () => {
    await expect(resolveRunOptions(fakeExecutor(), { model: 'model-' })).rejects.toBeInstanceOf(AgentRunOptionsError);
  });
});
