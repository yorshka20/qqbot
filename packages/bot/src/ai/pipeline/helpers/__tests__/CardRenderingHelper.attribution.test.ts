import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import type { HookManager } from '@/hooks/HookManager';
import type { CardRenderingService } from '@/services/card';
import { CardRenderingHelper } from '../CardRenderingHelper';

const SERVED = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const LONG_MARKDOWN = `# 标题\n\n${'这是一段用于触发卡片渲染的测试正文。'.repeat(20)}`;

function makeHelper() {
  const cardRenderingService = {
    renderCard: vi.fn().mockResolvedValue('b64'),
    renderCardData: vi.fn().mockResolvedValue('b64'),
  };
  const helper = new CardRenderingHelper(
    cardRenderingService as unknown as CardRenderingService,
    { execute: vi.fn() } as unknown as HookManager,
  );
  return { helper, cardRenderingService };
}

describe('CardRenderingHelper attribution', () => {
  it('renders a markdown reply with the target that served it', async () => {
    const { helper, cardRenderingService } = makeHelper();

    const result = await helper.handleCardReplyWithoutContext(LONG_MARKDOWN, 'session-1', SERVED);

    expect(result).not.toBeNull();
    expect(cardRenderingService.renderCardData).toHaveBeenCalledWith(expect.anything(), SERVED);
  });

  it('renders card JSON with the target that served it', async () => {
    const { helper, cardRenderingService } = makeHelper();
    const deck = JSON.stringify([{ type: 'paragraph', content: '内容'.repeat(100) }]);

    await helper.handleCardReplyWithoutContext(deck, 'session-1', SERVED);

    expect(cardRenderingService.renderCard).toHaveBeenCalledWith(expect.any(String), SERVED);
  });
});
