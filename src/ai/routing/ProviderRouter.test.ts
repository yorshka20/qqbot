import { describe, expect, it } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import { ProviderRouter } from './ProviderRouter';

function createMockAIManager(availableProviders: string[]): AIManager {
  return {
    getProviderForCapability: (_capability: string, providerName: string) => {
      if (availableProviders.includes(providerName)) {
        return { isAvailable: () => true, name: providerName } as never;
      }
      return null;
    },
  } as unknown as AIManager;
}

describe('ProviderRouter', () => {
  it('routes colon prefix to provider and strips message', () => {
    const aiManager = createMockAIManager(['anthropic', 'deepseek', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    const r1 = router.route('claude: 你好');
    expect(r1.providerName).toBe('anthropic');
    expect(r1.isExplicitPrefix).toBe(true);
    expect(r1.strippedMessage).toBe('你好');

    const r2 = router.route('deepseek: 写一段代码');
    expect(r2.providerName).toBe('deepseek');
    expect(r2.strippedMessage).toBe('写一段代码');

    const reply1 = router.routeReplyInput('豆包: 今天天气怎么样');
    expect(reply1.providerName).toBe('doubao');
    expect(reply1.userMessage).toBe('今天天气怎么样');
    expect(reply1.usedExplicitPrefix).toBe(true);
  });

  it('routes space-separated prefix to provider and strips message', () => {
    const aiManager = createMockAIManager(['anthropic', 'deepseek', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    const r1 = router.route('claude 你好');
    expect(r1.providerName).toBe('anthropic');
    expect(r1.isExplicitPrefix).toBe(true);
    expect(r1.strippedMessage).toBe('你好');

    const r2 = router.route('deepseek 写一段代码');
    expect(r2.providerName).toBe('deepseek');
    expect(r2.strippedMessage).toBe('写一段代码');

    const reply1 = router.routeReplyInput('claude 今天天气怎么样');
    expect(reply1.providerName).toBe('anthropic');
    expect(reply1.userMessage).toBe('今天天气怎么样');
    expect(reply1.usedExplicitPrefix).toBe(true);
  });

  it('routes prefix with comma or colon (EN/CN) and strips message', () => {
    const aiManager = createMockAIManager(['anthropic', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    expect(router.route('claude, xxx').providerName).toBe('anthropic');
    expect(router.route('claude, xxx').strippedMessage).toBe('xxx');

    expect(router.route('claude，yyy').providerName).toBe('anthropic');
    expect(router.route('claude，yyy').strippedMessage).toBe('yyy');

    expect(router.route('claude: zzz').providerName).toBe('anthropic');
    expect(router.route('claude: zzz').strippedMessage).toBe('zzz');

    expect(router.route('claude：今天').providerName).toBe('anthropic');
    expect(router.route('claude：今天').strippedMessage).toBe('今天');

    expect(router.route('豆包，你好').providerName).toBe('doubao');
    expect(router.route('豆包，你好').strippedMessage).toBe('你好');
  });

  it('returns no_match when no prefix present', () => {
    const aiManager = createMockAIManager(['anthropic']);
    const router = new ProviderRouter(aiManager);

    const r = router.route('just a normal message');
    expect(r.providerName).toBeNull();
    expect(r.isExplicitPrefix).toBe(false);
    expect(r.strippedMessage).toBe('just a normal message');

    const reply = router.routeReplyInput('just a normal message');
    expect(reply.providerName).toBeUndefined();
    expect(reply.userMessage).toBe('just a normal message');
    expect(reply.usedExplicitPrefix).toBe(false);
  });

  it('returns no match when provider is not available', () => {
    const aiManager = createMockAIManager(['deepseek']);
    const router = new ProviderRouter(aiManager);

    const r = router.route('claude 你好');
    expect(r.providerName).toBeNull();
    expect(r.isExplicitPrefix).toBe(false);
  });

  it('getProviderTriggerPrefixes returns alias keys', () => {
    const prefixes = ProviderRouter.getProviderTriggerPrefixes();
    expect(prefixes).toContain('claude');
    expect(prefixes).toContain('deepseek');
    expect(prefixes).toContain('doubao');
    expect(prefixes).toContain('gpt');
    expect(prefixes).toContain('豆包');
  });
});
