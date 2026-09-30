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
  it('routes colon prefix to provider', () => {
    const aiManager = createMockAIManager(['anthropic', 'deepseek', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    const r1 = router.route('claude: 你好');
    expect(r1.providerName).toBe('anthropic');
    expect(r1.hasExplicitProvider).toBe(true);

    const r2 = router.route('deepseek: 写一段代码');
    expect(r2.providerName).toBe('deepseek');

    expect(router.route('豆包: 今天天气怎么样').providerName).toBe('doubao');
  });

  it('routes space-separated prefix to provider', () => {
    const aiManager = createMockAIManager(['anthropic', 'deepseek', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    const r1 = router.route('claude 你好');
    expect(r1.providerName).toBe('anthropic');
    expect(r1.hasExplicitProvider).toBe(true);

    const r2 = router.route('deepseek 写一段代码');
    expect(r2.providerName).toBe('deepseek');
  });

  it('routes prefix with comma or colon (EN/CN)', () => {
    const aiManager = createMockAIManager(['anthropic', 'doubao', 'openai']);
    const router = new ProviderRouter(aiManager);

    expect(router.route('claude, xxx').providerName).toBe('anthropic');
    expect(router.route('claude，yyy').providerName).toBe('anthropic');
    expect(router.route('claude: zzz').providerName).toBe('anthropic');
    expect(router.route('claude：今天').providerName).toBe('anthropic');
    expect(router.route('豆包，你好').providerName).toBe('doubao');
    expect(router.route('claude是什么').providerName).toBeNull();
  });

  it('returns no_match when no prefix present', () => {
    const aiManager = createMockAIManager(['anthropic']);
    const router = new ProviderRouter(aiManager);

    const r = router.route('just a normal message');
    expect(r.providerName).toBeNull();
    expect(r.hasExplicitProvider).toBe(false);
  });

  it('returns no match when provider is not available', () => {
    const aiManager = createMockAIManager(['deepseek']);
    const router = new ProviderRouter(aiManager);

    const r = router.route('claude 你好');
    expect(r.providerName).toBeNull();
    expect(r.hasExplicitProvider).toBe(false);
  });

  it('skips leading segment placeholders before matching prefix (reaction-triggered reply)', () => {
    const aiManager = createMockAIManager(['anthropic', 'openai', 'gemini']);
    const router = new ProviderRouter(aiManager);

    // Reaction trigger on a [Reply:xxx]-prefixed message — main bug from 2026-04-14.
    const r1 = router.route('[Reply:93769]claude，你来分析一下这个问题');
    expect(r1.providerName).toBe('anthropic');
    expect(r1.hasExplicitProvider).toBe(true);

    // Multiple placeholders.
    const r2 = router.route('[Reply:1][Image:abc] gpt: 这是什么');
    expect(r2.providerName).toBe('openai');
    expect(r2.hasExplicitProvider).toBe(true);

    // Placeholders with surrounding whitespace.
    const r3 = router.route('  [Reply:42]  gemini 翻译一下');
    expect(r3.providerName).toBe('gemini');
    expect(r3.hasExplicitProvider).toBe(true);

    // Placeholders only, no prefix after → no match.
    const r4 = router.route('[Reply:1] just normal text');
    expect(r4.providerName).toBeNull();
    expect(r4.hasExplicitProvider).toBe(false);
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

describe('ProviderRouter nickname routing', () => {
  const allProviders = ['anthropic', 'gemini', 'deepseek', 'openai', 'doubao'];

  it('routes a leading nickname', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('橙色高手 帮我写段代码');
    expect(r.providerName).toBe('anthropic');
    expect(r.triggerKind).toBe('nickname');
    expect(r.hasExplicitProvider).toBe(true);
  });

  it('matches a nickname in the middle of the message', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('这个问题 紫色高手 你怎么看');
    expect(r.providerName).toBe('gemini');
    expect(r.triggerKind).toBe('nickname');
  });

  it('matches a nickname at the end of the message', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('帮我看看这个 蓝色高手');
    expect(r.providerName).toBe('deepseek');
    expect(r.triggerKind).toBe('nickname');
  });

  it('prefers the longer color nickname over the bare default nickname', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('橙色高手你好');
    expect(r.providerName).toBe('anthropic');
    expect(r.hasExplicitProvider).toBe(true);
  });

  it('routes the bare nickname to the configured default provider', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('高手，来看看');
    expect(r.providerName).toBeNull();
    expect(r.hasExplicitProvider).toBe(false);
    expect(r.triggerKind).toBe('nickname');
  });

  it('matches a message that is only the nickname', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('青色高手');
    expect(r.providerName).toBe('doubao');
    expect(r.triggerKind).toBe('nickname');
  });

  it('prefers a nickname over an explicit prefix', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('claude: 绿色高手怎么样');
    expect(r.providerName).toBe('openai');
    expect(r.triggerKind).toBe('nickname');
  });

  it('skips leading segment placeholders before matching a nickname', () => {
    const router = new ProviderRouter(createMockAIManager(allProviders));

    const r = router.route('[Reply:93769]橙色高手 分析一下');
    expect(r.providerName).toBe('anthropic');
    expect(r.triggerKind).toBe('nickname');
  });

  it('does not trigger when the nickname provider is unavailable', () => {
    const router = new ProviderRouter(createMockAIManager(['deepseek']));

    const r = router.route('橙色高手 你好');
    expect(r.providerName).toBeNull();
    expect(r.triggerKind).toBeNull();
    expect(r.hasExplicitProvider).toBe(false);
  });

  it('getNicknameAliasMap exposes the nickname table', () => {
    const map = ProviderRouter.getNicknameAliasMap();
    expect(map.高手).toBeNull();
    expect(map.绿色高手).toBe('openai');
    expect(map.青色高手).toBe('doubao');
    expect(map.橙色高手).toBe('anthropic');
    expect(map.紫色高手).toBe('gemini');
    expect(map.蓝色高手).toBe('deepseek');
  });
});
