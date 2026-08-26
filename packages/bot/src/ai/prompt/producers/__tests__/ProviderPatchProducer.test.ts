import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import type { PromptInjectionContext } from '@/conversation/promptInjection/types';
import { HookMetadataMap } from '@/hooks/metadata';
import type { PromptManager } from '../../PromptManager';
import { createProviderPatchProducer } from '../ProviderPatchProducer';

function makePromptManager(templates: Record<string, string>): PromptManager {
  return {
    getTemplate: (name: string) => (name in templates ? { name, content: templates[name] } : null),
    render: (name: string) => templates[name].trim(),
  } as unknown as PromptManager;
}

function makeCtx(providerName?: string): PromptInjectionContext {
  const metadata = new HookMetadataMap();
  if (providerName) metadata.set('promptProviderName', providerName);
  return {
    source: 'qq-group',
    hookContext: { source: 'qq-group', metadata } as PromptInjectionContext['hookContext'],
  };
}

describe('createProviderPatchProducer', () => {
  it('injects the patch template matching the resolved provider', async () => {
    const producer = createProviderPatchProducer({
      promptManager: makePromptManager({ 'providers.gemini.system': '不要迎合用户。\n' }),
    });
    const injection = await producer.produce(makeCtx('gemini'));
    expect(injection?.fragment).toBe('不要迎合用户。');
    expect(producer.layer).toBe('baseline');
  });

  it('returns null for a provider with no patch file', async () => {
    const producer = createProviderPatchProducer({
      promptManager: makePromptManager({ 'providers.gemini.system': '不要迎合用户。' }),
    });
    expect(await producer.produce(makeCtx('anthropic'))).toBeNull();
  });

  it('returns null when the provider is unresolved', async () => {
    const render = mock(() => '');
    const producer = createProviderPatchProducer({
      promptManager: { getTemplate: () => null, render } as unknown as PromptManager,
    });
    expect(await producer.produce(makeCtx())).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });
});
