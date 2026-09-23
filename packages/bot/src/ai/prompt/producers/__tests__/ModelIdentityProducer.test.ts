// The model named in the system prompt is the one serving this turn only —
// routing picks a provider per turn, so the wording has to rule out reading it
// as a constant fact or as the author of every assistant turn in history.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import type { PromptInjectionContext } from '@/conversation/promptInjection/types';
import { HookMetadataMap } from '@/hooks/metadata';
import { getRepoRoot } from '@/utils/repoRoot';
import { createModelIdentityProducer } from '../ModelIdentityProducer';

/** The constructor loads prompts/ off disk — same path production takes. */
function makeProducer() {
  return createModelIdentityProducer({ promptManager: new PromptManager(join(getRepoRoot(), 'prompts')) });
}

function makeCtx(providerName?: string, modelName?: string): PromptInjectionContext {
  const metadata = new HookMetadataMap();
  if (providerName) metadata.set('promptProviderName', providerName);
  if (modelName) metadata.set('promptModelName', modelName);
  return {
    source: 'qq-group',
    hookContext: { source: 'qq-group', metadata } as PromptInjectionContext['hookContext'],
  };
}

describe('createModelIdentityProducer', () => {
  it('names the model and provider serving this turn', async () => {
    const fragment = (await makeProducer().produce(makeCtx('anthropic', 'claude-opus-5')))?.fragment ?? '';
    expect(fragment).toContain('claude-opus-5');
    expect(fragment).toContain('anthropic');
    expect(fragment).not.toMatch(/\{\{|\}\}/);
  });

  it('falls back to the provider alone when no model is resolved', async () => {
    const fragment = (await makeProducer().produce(makeCtx('groq')))?.fragment ?? '';
    expect(fragment).toContain('groq');
    expect(fragment).not.toMatch(/\{\{|\}\}/);
  });

  it('states that the model is chosen per turn rather than fixed', async () => {
    const producer = makeProducer();
    for (const ctx of [makeCtx('deepseek', 'deepseek-flash'), makeCtx('deepseek')]) {
      const fragment = (await producer.produce(ctx))?.fragment ?? '';
      expect(fragment).toContain('本轮');
      expect(fragment).toContain('这不是固定的');
      expect(fragment).toContain('历史轮次可能出自另一个模型');
    }
  });

  it('returns nothing when provider selection has not run', async () => {
    expect(await makeProducer().produce(makeCtx())).toBeNull();
  });
});
