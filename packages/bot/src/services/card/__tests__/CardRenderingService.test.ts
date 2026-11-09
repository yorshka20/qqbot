import 'reflect-metadata';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { AIManager } from '@qqbot/llm';
import { CardAppearanceService } from '../CardAppearanceService';
import { CardRenderer } from '../CardRenderer';
import { CardRenderingService } from '../CardRenderingService';
import type { CardData } from '../cardTypes';

const DECK: CardData[] = [{ type: 'paragraph', content: '测试内容' }];

/** The provider's static config names a different model than the owner's default target. */
function managerWithDefault(defaultTarget: { provider: string; model?: string } | null): AIManager {
  const provider = {
    name: 'anthropic',
    getCapabilities: () => ['llm'],
    getConfig: () => ({ model: 'claude-opus-5-5' }),
    getDefaultModel: () => 'claude-opus-5-5',
  };
  return {
    getDefaultLLM: () => defaultTarget,
    getProviderForCapability: () => provider,
  } as unknown as AIManager;
}

function serviceFor(manager: AIManager) {
  const render = spyOn(CardRenderer.getInstance(), 'render').mockResolvedValue(Buffer.from('png'));
  const appearance = { resolve: () => 'light' } as unknown as CardAppearanceService;
  return { service: new CardRenderingService(manager, appearance), render };
}

describe('CardRenderingService attribution', () => {
  afterEach(() => {
    spyOn(CardRenderer.getInstance(), 'render').mockRestore();
  });

  it('renders the footer model of the default target, not the provider config model', async () => {
    const { service, render } = serviceFor(
      managerWithDefault({ provider: 'anthropic', model: 'claude-sonnet-5-5' }),
    );

    await service.renderCardData(DECK, service.defaultAttribution());

    expect(render.mock.calls[0][1].attribution).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });

  it('uses the provider default model when the default target names none', () => {
    const { service } = serviceFor(managerWithDefault({ provider: 'anthropic' }));

    expect(service.defaultAttribution()).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('refuses to attribute a card when no default LLM is configured', () => {
    const { service } = serviceFor(managerWithDefault(null));

    expect(() => service.defaultAttribution()).toThrow('No default LLM');
  });

  it('passes the attribution it is given through renderCard untouched', async () => {
    const { service, render } = serviceFor(managerWithDefault({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));

    await service.renderCard(JSON.stringify(DECK), { provider: 'deepseek', model: 'deepseek-chat' });

    expect(render.mock.calls[0][1].attribution).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
