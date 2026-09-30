// Trigger words reach the LLM verbatim, so the scene has to tell it that every
// nickname in the router's table is a way of calling it.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PromptManager } from '@/ai/prompt/PromptManager';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import type { PromptInjectionContext } from '@/conversation/promptInjection/types';
import { HookMetadataMap } from '@/hooks/metadata';
import { getRepoRoot } from '@/utils/repoRoot';
import { createSceneProducer } from '../SceneProducer';

const WAKE_WORD = '测试唤醒词';

const nicknames = Object.entries(ProviderRouter.getNicknameAliasMap());
const providerNicknames = nicknames.filter(([, provider]) => provider !== null);
const defaultNicknames = nicknames.filter(([, provider]) => provider === null).map(([nickname]) => nickname);

async function renderScene(source: 'qq-group' | 'qq-private', wakeWords: string[]): Promise<string> {
  const producer = createSceneProducer({
    promptManager: new PromptManager(join(getRepoRoot(), 'prompts')),
    wakeWords,
  });
  const ctx: PromptInjectionContext = {
    source,
    hookContext: { source, metadata: new HookMetadataMap() } as PromptInjectionContext['hookContext'],
  };
  return (await producer.produce(ctx))?.fragment ?? '';
}

describe('createSceneProducer', () => {
  it.each(['qq-group', 'qq-private'] as const)('%s scene names every color nickname and the provider it picks', async (source) => {
    const fragment = await renderScene(source, [WAKE_WORD]);
    expect(providerNicknames.length).toBeGreaterThan(0);
    for (const [nickname, provider] of providerNicknames) {
      expect(fragment).toContain(`「${nickname}」→${provider}`);
    }
    expect(fragment).not.toMatch(/\{\{|\}\}/);
  });

  it('lists the default nickname among the group wake words without repeating a configured one', async () => {
    expect(defaultNicknames.length).toBeGreaterThan(0);
    const fragment = await renderScene('qq-group', [WAKE_WORD, ...defaultNicknames]);
    const wakeWordList = [WAKE_WORD, ...defaultNicknames].map((w) => `「${w}」`).join('、');
    expect(fragment).toContain(`唤醒词${wakeWordList}称呼你`);
  });
});
