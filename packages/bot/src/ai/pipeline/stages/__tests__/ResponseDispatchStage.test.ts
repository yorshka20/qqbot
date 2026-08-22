/**
 * Unit tests for ResponseDispatchStage (Path 1 / Path 1.5 / Path 2 / Path 3).
 */

import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { CardRenderingHelper } from '@/ai/pipeline/helpers/CardRenderingHelper';
import type { HookManager } from '@/hooks/HookManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { ResponseDispatchStage } from '../ResponseDispatchStage';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSegments(): MessageSegment[] {
  return [{ type: 'text', data: { text: '' } } as MessageSegment];
}

function makeCardHelper(overrides: Partial<CardRenderingHelper> = {}): CardRenderingHelper {
  return {
    shouldUseCardReply: vi.fn().mockReturnValue(false),
    looksLikeMarkdown: vi.fn().mockReturnValue(false),
    renderMarkdownDirect: vi.fn().mockResolvedValue(null),
    setCardReplyOnContext: vi.fn(),
    looksLikeCardJson: vi.fn().mockReturnValue(false),
    extractReadableTextFromCardJson: vi.fn().mockReturnValue('readable'),
    ...overrides,
  } as unknown as CardRenderingHelper;
}

function makeHookManager(): HookManager {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as HookManager;
}

function makeHookContext(metadataOverrides: Record<string, unknown> = {}): HookContext {
  const metadata = new HookMetadataMap();
  for (const [k, v] of Object.entries(metadataOverrides)) {
    metadata.set(k as keyof import('@/hooks/metadata').HookContextMetadata, v as never);
  }
  return {
    metadata,
    reply: { source: 'ai', segments: [] },
  } as unknown as HookContext;
}

function makePipelineContext(
  responseText: string,
  hookContext: HookContext,
  taskResultImages: string[] = [],
): ReplyPipelineContext {
  const ctx = new ReplyPipelineContext(hookContext, new Map());
  ctx.responseText = responseText;
  ctx.sessionId = 'session-1';
  ctx.actualProvider = 'deepseek';
  ctx.taskResultImages = taskResultImages;
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResponseDispatchStage', () => {
  describe('Path 1: cardSent=true', () => {
    it('ships the queued card, appends trailing text as follow-up, fires onAIGenerationComplete', async () => {
      const hookContext = makeHookContext({ cardSent: true });
      const cardHelper = makeCardHelper();
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('some text', hookContext);

      await stage.execute(ctx);

      expect(cardHelper.renderMarkdownDirect).not.toHaveBeenCalled();
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      // Delivery contract: final text after send_card is appended, never dropped.
      const texts = hookContext.reply?.segments.filter((s) => s.type === 'text') ?? [];
      expect(texts.length).toBe(1);
      expect((texts[0] as { data: { text: string } }).data.text).toBe('some text');
    });

    it('ships the card alone when there is no trailing text', async () => {
      const hookContext = makeHookContext({ cardSent: true });
      const cardHelper = makeCardHelper();
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('', hookContext);

      await stage.execute(ctx);

      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      expect(hookContext.reply?.segments.length ?? 0).toBe(0);
    });
  });

  describe('Path 0: end_turn with no trailing text', () => {
    it('queues no reply and fires onAIGenerationComplete', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper();
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('', hookContext);
      ctx.endTurnRequested = true;

      await stage.execute(ctx);

      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      expect(hookContext.reply?.segments.length ?? 0).toBe(0);
      expect(cardHelper.renderMarkdownDirect).not.toHaveBeenCalled();
    });

    it('end_turn with trailing text still ships the text (Path 3)', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper();
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('closing words', hookContext);
      ctx.endTurnRequested = true;

      await stage.execute(ctx);

      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      const texts = hookContext.reply?.segments.filter((s) => s.type === 'text') ?? [];
      expect(texts.length).toBe(1);
      expect((texts[0] as { data: { text: string } }).data.text).toBe('closing words');
    });
  });

  describe('Path 1.5: cardSendFailedReason set — falls through to Path 2', () => {
    it('attempts markdown render when text looks like markdown after send_card failure', async () => {
      const hookContext = makeHookContext({ cardSendFailedReason: 'puppeteer crashed' });
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(true),
        looksLikeMarkdown: vi.fn().mockReturnValue(true),
        renderMarkdownDirect: vi.fn().mockResolvedValue({
          segments: makeSegments(),
          textForHistory: 'a'.repeat(200),
        }),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('a'.repeat(200), hookContext);

      await stage.execute(ctx);

      expect(cardHelper.renderMarkdownDirect).toHaveBeenCalledTimes(1);
    });
  });

  describe('Path 2a: long + markdown → markdown card', () => {
    it('calls renderMarkdownDirect and setCardReplyOnContext on success', async () => {
      const hookContext = makeHookContext();
      const cardSegments = makeSegments();
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(true),
        looksLikeMarkdown: vi.fn().mockReturnValue(true),
        renderMarkdownDirect: vi.fn().mockResolvedValue({
          segments: cardSegments,
          textForHistory: 'original',
        }),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('# heading\n'.repeat(20), hookContext);

      await stage.execute(ctx);

      expect(cardHelper.setCardReplyOnContext).toHaveBeenCalledWith(hookContext, cardSegments, 'original');
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
    });

    it('falls through to Path 2b/3 when renderMarkdownDirect returns null', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(true),
        looksLikeMarkdown: vi.fn().mockReturnValue(true),
        renderMarkdownDirect: vi.fn().mockResolvedValue(null),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext(`# heading\n${'a'.repeat(200)}`, hookContext);

      await stage.execute(ctx);

      // Path 3 fires onAIGenerationComplete; no card was set
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      expect(cardHelper.setCardReplyOnContext).not.toHaveBeenCalled();
      // Path 2b forces forward when card path fails
      expect(hookContext.metadata.get('explicitSendAsForward')).toBe(true);
    });
  });

  describe('Path 2b: long + plain prose → explicitSendAsForward', () => {
    it('sets explicitSendAsForward=true and falls through to Path 3 (no markdown render call)', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(true),
        looksLikeMarkdown: vi.fn().mockReturnValue(false),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const ctx = makePipelineContext('a'.repeat(200), hookContext);

      await stage.execute(ctx);

      expect(cardHelper.renderMarkdownDirect).not.toHaveBeenCalled();
      expect(cardHelper.setCardReplyOnContext).not.toHaveBeenCalled();
      expect(hookContext.metadata.get('explicitSendAsForward')).toBe(true);
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
    });
  });

  describe('Path 3: plain prose', () => {
    it('replaces reply with ctx.responseText (original prose), not JSON', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(false),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const originalProse = 'This is the original LLM prose response.';
      const ctx = makePipelineContext(originalProse, hookContext);

      await stage.execute(ctx);

      // hookContext.reply should contain the original prose via replaceReply
      // We can't easily inspect replaceReply internals, but we confirm
      // setCardReplyOnContext was NOT called and hookManager was fired.
      expect(cardHelper.setCardReplyOnContext).not.toHaveBeenCalled();
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
      expect(cardHelper.extractReadableTextFromCardJson).not.toHaveBeenCalled();
    });

    it('degrades raw card-deck JSON to readable markdown (safety net)', async () => {
      const hookContext = makeHookContext();
      const cardHelper = makeCardHelper({
        shouldUseCardReply: vi.fn().mockReturnValue(false),
        extractReadableTextFromCardJson: vi.fn().mockReturnValue('## Title\n\n• item one'),
      });
      const hookManager = makeHookManager();
      const stage = new ResponseDispatchStage(cardHelper, hookManager);
      const rawDeckJson = '[{"type":"highlight","title":"Title","summary":"item one"}]';
      const ctx = makePipelineContext(rawDeckJson, hookContext);

      await stage.execute(ctx);

      expect(cardHelper.extractReadableTextFromCardJson).toHaveBeenCalledWith(rawDeckJson);
      expect(hookManager.execute).toHaveBeenCalledWith('onAIGenerationComplete', hookContext);
    });
  });
});
