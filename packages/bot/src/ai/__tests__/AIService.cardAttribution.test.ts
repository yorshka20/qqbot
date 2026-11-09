import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import type { CardRenderingService } from '@/services/card/CardRenderingService';
import { AIService } from '../AIService';
import type { ReplyPipelineOrchestrator } from '../pipeline/ReplyPipelineOrchestrator';

const SERVED = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

describe('AIService card attribution', () => {
  it('hands the serving target to the card pipeline', async () => {
    const handleCardReply = vi.fn().mockResolvedValue(null);
    const service = new AIService(
      { handleCardReply } as unknown as ReplyPipelineOrchestrator,
      {} as never,
      {} as never,
      {} as never,
      {} as unknown as CardRenderingService,
    );

    await service.processReplyMaybeCard('正文', 'session-1', SERVED);

    expect(handleCardReply).toHaveBeenCalledWith('正文', 'session-1', { attribution: SERVED });
  });

  it('attributes a code-built card to the default LLM target', async () => {
    const renderCardData = vi.fn().mockResolvedValue('b64');
    const service = new AIService({} as never, {} as never, {} as never, {} as never, {
      defaultAttribution: () => SERVED,
      renderCardData,
    } as unknown as CardRenderingService);

    await service.renderCardDataToSegments({ type: 'paragraph', content: '帮助' });

    expect(renderCardData).toHaveBeenCalledWith([{ type: 'paragraph', content: '帮助' }], SERVED);
  });
});
