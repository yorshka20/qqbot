/**
 * Unit tests for CardFormatToolExecutor (send_card tool).
 */

import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeSegments(): MessageSegment[] {
  return [{ type: 'text', data: { text: '' } } as MessageSegment];
}

function makeCardHelper(overrides: Partial<CardRenderingHelper> = {}): CardRenderingHelper {
  return {
    renderParsedCards: vi.fn().mockResolvedValue({
      segments: makeSegments(),
      textForHistory: '[]',
    }),
    setCardReplyOnContext: vi.fn(),
    ...overrides,
  } as unknown as CardRenderingHelper;
}

function makeHookContext(): HookContext {
  const metadata = new HookMetadataMap();
  return { metadata } as unknown as HookContext;
}

function makeContext(hookContext?: HookContext): ToolExecutionContext {
  return {
    userId: 1,
    messageType: 'private',
    hookContext,
  };
}

const validCards = [{ type: 'paragraph', content: 'Hello world with more than 150 chars of structural content here.' }];

const defaultCall: ToolCall = {
  type: 'send_card',
  executor: 'send_card',
  parameters: { cards: validCards },
};

async function makeExecutorWithHelper(cardHelper: CardRenderingHelper) {
  const { CardFormatToolExecutor } = await import('../CardFormatToolExecutor');
  return new CardFormatToolExecutor(cardHelper);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CardFormatToolExecutor (send_card)', () => {
  describe('tool metadata', () => {
    it('has name send_card', async () => {
      const executor = await makeExecutorWithHelper(makeCardHelper());
      expect(executor.name).toBe('send_card');
    });
  });

  describe('parameter validation', () => {
    it('returns error when cards is not an array', async () => {
      const cardHelper = makeCardHelper();
      const executor = await makeExecutorWithHelper(cardHelper);
      const result = await executor.execute({ ...defaultCall, parameters: { cards: 'not-array' } }, makeContext());
      expect(result.success).toBe(false);
      expect(result.reply).toContain('非空数组');
    });

    it('returns error when cards is empty array', async () => {
      const cardHelper = makeCardHelper();
      const executor = await makeExecutorWithHelper(cardHelper);
      const result = await executor.execute({ ...defaultCall, parameters: { cards: [] } }, makeContext());
      expect(result.success).toBe(false);
      expect(result.reply).toContain('非空数组');
    });

    it('returns error when cards array contains invalid card type', async () => {
      const cardHelper = makeCardHelper();
      const executor = await makeExecutorWithHelper(cardHelper);
      const result = await executor.execute(
        { ...defaultCall, parameters: { cards: [{ type: 'invalid_type_xyz', content: 'text' }] } },
        makeContext(),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('success path', () => {
    it('renders cards and sets cardSent=true on hookContext metadata', async () => {
      const hookContext = makeHookContext();
      hookContext.metadata.set('activeTarget', { provider: 'deepseek', model: 'deepseek-chat' });
      const cardHelper = makeCardHelper();
      const executor = await makeExecutorWithHelper(cardHelper);

      const result = await executor.execute(defaultCall, makeContext(hookContext));

      expect(result.success).toBe(true);
      expect(hookContext.metadata.get('cardSent')).toBe(true);
      expect(cardHelper.renderParsedCards).toHaveBeenCalledTimes(1);
      expect(cardHelper.setCardReplyOnContext).toHaveBeenCalledTimes(1);
    });

    it('passes the active target to the card footer as one value', async () => {
      const hookContext = makeHookContext();
      hookContext.metadata.set('activeTarget', { provider: 'gemini', model: 'gemini-3.5-flash' });
      const cardHelper = makeCardHelper();
      const executor = await makeExecutorWithHelper(cardHelper);

      await executor.execute(defaultCall, makeContext(hookContext));

      expect(cardHelper.renderParsedCards).toHaveBeenCalledWith(expect.anything(), {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
      });
    });

    it('fails without an active target rather than guessing a model', async () => {
      for (const hookContext of [makeHookContext(), undefined]) {
        const cardHelper = makeCardHelper();
        const executor = await makeExecutorWithHelper(cardHelper);

        const result = await executor.execute(defaultCall, makeContext(hookContext));

        expect(result.success).toBe(false);
        expect(cardHelper.renderParsedCards).not.toHaveBeenCalled();
      }
    });
  });

  describe('rendering failure', () => {
    it('sets cardSendFailedReason and returns failure when renderParsedCards throws', async () => {
      const hookContext = makeHookContext();
      hookContext.metadata.set('activeTarget', { provider: 'deepseek', model: 'deepseek-chat' });
      const cardHelper = makeCardHelper({
        renderParsedCards: vi.fn().mockRejectedValue(new Error('puppeteer crashed')),
      });
      const executor = await makeExecutorWithHelper(cardHelper);

      const result = await executor.execute(defaultCall, makeContext(hookContext));

      expect(result.success).toBe(false);
      expect(hookContext.metadata.get('cardSendFailedReason')).toBe('puppeteer crashed');
      expect(hookContext.metadata.get('cardSent')).toBeUndefined();
    });
  });
});
