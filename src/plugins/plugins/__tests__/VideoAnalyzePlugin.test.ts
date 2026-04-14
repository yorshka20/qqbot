import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai/AIService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProcessStageInterceptorRegistry } from '@/conversation/ProcessStageInterceptor';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EventRouter } from '@/events/EventRouter';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import {
  extractAllVideoUrls,
  extractVideoUrl,
  type VideoAnalyzePayload,
  VideoAnalyzePlugin,
} from '../VideoAnalyzePlugin';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface SentMessage {
  target: string;
  message: string;
}

function createMockMessageAPI(): { api: MessageAPI; sentMessages: SentMessage[] } {
  const sentMessages: SentMessage[] = [];
  const api = {
    sendGroupMessage: async (groupId: unknown, message: string) => {
      sentMessages.push({ target: `group:${groupId}`, message });
      return { message_seq: 1 };
    },
    sendPrivateMessage: async (userId: unknown, message: string) => {
      sentMessages.push({ target: `user:${userId}`, message });
      return { message_seq: 1 };
    },
  } as unknown as MessageAPI;
  return { api, sentMessages };
}

type MockAIServiceOpts = {
  /** Value returned by runSubAgent on success. */
  result?: unknown;
  /** If set, runSubAgent will throw this error. */
  throws?: Error;
  /** Optional callback invoked at the start of each runSubAgent call (before result/throw). */
  onRun?: () => void;
};

function createMockAIService(opts: MockAIServiceOpts = {}): AIService {
  return {
    runSubAgent: async () => {
      opts.onRun?.();
      if (opts.throws) {
        throw opts.throws;
      }
      return opts.result;
    },
  } as unknown as AIService;
}

function createMockEventRouter(): EventRouter {
  const events: Map<string, Set<Function>> = new Map();
  const emitter = {
    onEvent(eventType: string, handler: Function) {
      if (!events.has(eventType)) {
        events.set(eventType, new Set());
      }
      (events.get(eventType) as Set<Function>).add(handler);
    },
    offEvent(eventType: string, handler: Function) {
      events.get(eventType)?.delete(handler);
    },
    emit(eventType: string, payload: unknown) {
      const handlers = events.get(eventType);
      if (handlers) {
        for (const h of handlers) {
          (h as (payload: unknown) => void)(payload);
        }
      }
    },
    _getHandlers(eventType: string): Set<Function> {
      return events.get(eventType) ?? new Set();
    },
  };
  return emitter as unknown as EventRouter;
}

// ---------------------------------------------------------------------------
// HookContext factory
// ---------------------------------------------------------------------------

function makeHookContext(opts: {
  messageText?: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  command?: boolean;
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
}): HookContext {
  const {
    messageText = 'hello world',
    messageType = 'group',
    userId = 456,
    groupId = 1,
    botSelfId = '123',
    command = false,
  } = opts;

  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);

  return {
    command: command ? ({ name: 'test' } as any) : undefined,
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId,
      groupId,
      messageType,
      message: messageText,
      segments: [],
    },
    context: {
      userMessage: messageText,
      history: [],
      userId,
      groupId,
      messageType,
      metadata: new Map(),
    },
    metadata,
  } as HookContext;
}

// ---------------------------------------------------------------------------
// Plugin bootstrap helper
// ---------------------------------------------------------------------------

async function initPlugin(
  overrides: { aiService?: AIService; messageAPI?: MessageAPI; eventRouter?: EventRouter } = {},
): Promise<VideoAnalyzePlugin> {
  const container = getContainer();
  const mockEventRouter = overrides.eventRouter ?? createMockEventRouter();
  const msgApi = overrides.messageAPI ?? createMockMessageAPI().api;
  const mockAIService = overrides.aiService ?? createMockAIService();

  const interceptors: any[] = [];
  const mockRegistry = {
    interceptors,
    register(i: any) {
      interceptors.push(i);
    },
    unregister(i: any) {
      const idx = interceptors.indexOf(i);
      if (idx !== -1) interceptors.splice(idx, 1);
    },
    getInterceptors() {
      return interceptors;
    },
  } as unknown as ProcessStageInterceptorRegistry;

  container.registerInstance(DITokens.AI_SERVICE, mockAIService, { allowOverride: true });
  container.registerInstance(DITokens.MESSAGE_API, msgApi as any, { allowOverride: true });
  container.registerInstance(DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY, mockRegistry, { allowOverride: true });
  container.registerInstance(DITokens.EVENT_ROUTER, mockEventRouter, { allowOverride: true });

  const plugin = new VideoAnalyzePlugin({ name: 'video-analyze', version: '1.0.0', description: '' });
  plugin.loadConfig({ api: {} as any, events: mockEventRouter }, { name: 'video-analyze', enabled: true });
  await plugin.onInit?.();
  await plugin.onEnable();

  return plugin;
}

// ---------------------------------------------------------------------------
// URL extraction tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzePlugin URL extraction', () => {
  describe('extractVideoUrl', () => {
    it('matches Bilibili long video URL with BV ID', () => {
      const url = extractVideoUrl('来看看这个视频 https://www.bilibili.com/video/BV1GJ411x7h7 很有意思');
      expect(url).toBe('https://www.bilibili.com/video/BV1GJ411x7h7');
    });

    it('matches Bilibili video without www prefix (with https)', () => {
      const url = extractVideoUrl('https://bilibili.com/video/BV1GJ411x7h7');
      expect(url).toBe('https://bilibili.com/video/BV1GJ411x7h7');
    });

    it('matches b23.tv short link with https', () => {
      const url = extractVideoUrl('https://b23.tv/abc123xyz');
      expect(url).toBe('https://b23.tv/abc123xyz');
    });

    it('matches YouTube watch URL', () => {
      const url = extractVideoUrl('油管视频 https://www.youtube.com/watch?v=dQw4w9WgXcQ 太棒了');
      expect(url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('matches youtu.be short link', () => {
      const url = extractVideoUrl('https://youtu.be/dQw4w9WgXcQ');
      expect(url).toBe('https://youtu.be/dQw4w9WgXcQ');
    });

    it('matches youtu.be with https prefix', () => {
      const url = extractVideoUrl('https://youtu.be/dQw4w9WgXcQ');
      expect(url).toBe('https://youtu.be/dQw4w9WgXcQ');
    });

    it('returns null for non-video URLs', () => {
      expect(extractVideoUrl('https://google.com')).toBeNull();
      expect(extractVideoUrl('https://github.com/user/repo')).toBeNull();
      expect(extractVideoUrl('https://twitter.com/user/status/123')).toBeNull();
      expect(extractVideoUrl('just a normal message')).toBeNull();
    });

    it('returns null for YouTube playlist URL (no watch?v=)', () => {
      expect(extractVideoUrl('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')).toBeNull();
    });

    it('returns null for YouTube channel URL', () => {
      expect(extractVideoUrl('https://www.youtube.com/@channel')).toBeNull();
    });

    it('returns null for incomplete video URL (no video ID)', () => {
      expect(extractVideoUrl('https://www.bilibili.com/video/')).toBeNull();
      expect(extractVideoUrl('https://www.youtube.com/watch?v=')).toBeNull();
    });

    it('returns null for bare-domain URLs without protocol', () => {
      // All patterns require https?:// — bare domains must not match
      expect(extractVideoUrl('bilibili.com/video/BV1GJ411x7h7')).toBeNull();
      expect(extractVideoUrl('b23.tv/abc123')).toBeNull();
      expect(extractVideoUrl('youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
      expect(extractVideoUrl('youtu.be/dQw4w9WgXcQ')).toBeNull();
    });

    it('returns the first match when multiple video URLs are present', () => {
      const url = extractVideoUrl('两个视频 https://www.bilibili.com/video/BV1xx 和 https://youtu.be/abc123');
      expect(url).toBe('https://www.bilibili.com/video/BV1xx');
    });
  });

  describe('extractAllVideoUrls', () => {
    it('extracts multiple unique video URLs', () => {
      const urls = extractAllVideoUrls(
        'https://www.bilibili.com/video/BV1GJ411x7h7 and https://youtu.be/abc123 and https://www.youtube.com/watch?v=xyz',
      );
      expect(urls).toContain('https://www.bilibili.com/video/BV1GJ411x7h7');
      expect(urls).toContain('https://youtu.be/abc123');
      expect(urls).toContain('https://www.youtube.com/watch?v=xyz');
    });

    it('deduplicates repeated URLs', () => {
      const urls = extractAllVideoUrls('https://youtu.be/abc123 and again https://youtu.be/abc123');
      expect(urls.filter((u: string) => u === 'https://youtu.be/abc123')).toHaveLength(1);
    });

    it('returns empty array for no matches', () => {
      expect(extractAllVideoUrls('just text')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Interceptor behavior tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzePlugin interceptor', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('shouldIntercept returns true when message contains Bilibili video URL', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: '看这个视频 https://www.bilibili.com/video/BV1GJ411x7h7' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(true);
  });

  it('shouldIntercept returns true when message contains YouTube URL', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: '油管视频 https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(true);
  });

  it('shouldIntercept returns true when message contains b23.tv short link with https', async () => {
    const plugin = await initPlugin();
    // b23.tv requires https:// prefix — bare domain is not a valid video URL
    const ctx = makeHookContext({ messageText: 'b站视频 https://b23.tv/abc123' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(true);
  });

  it('shouldIntercept returns false for b23.tv without protocol prefix', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: 'b站视频 b23.tv/abc123' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('shouldIntercept returns false for YouTube shorts URL (not in our patterns)', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: 'youtube.com/shorts/dQw4w9WgXcQ is not matched' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('shouldIntercept returns false when no video URL in message', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: 'just a normal text message' });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('shouldIntercept returns false when message is a command', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({
      messageText: 'https://youtu.be/dQw4w9WgXcQ',
      command: true,
    });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('shouldIntercept returns false for bot own messages', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({
      messageText: 'https://youtu.be/dQw4w9WgXcQ',
      userId: 123,
      botSelfId: '123',
    });
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('shouldIntercept returns false when context.reply is already set', async () => {
    const plugin = await initPlugin();
    const ctx = makeHookContext({ messageText: 'https://youtu.be/dQw4w9WgXcQ' });
    ctx.reply = { source: 'plugin', segments: [] };
    const interceptor = (plugin as any).videoInterceptor;
    expect(await interceptor.shouldIntercept(ctx)).toBe(false);
  });

  it('handle sets immediate reply text', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const plugin = await initPlugin({ messageAPI: mockAPI as any, eventRouter });

    const ctx = makeHookContext({ messageText: '看这个 https://youtu.be/dQw4w9WgXcQ' });
    const interceptor = (plugin as any).videoInterceptor;
    await interceptor.handle(ctx);

    expect(ctx.reply).toBeDefined();
    expect(ctx.reply?.source).toBe('plugin');
    const textSeg = (ctx.reply?.segments as any[])?.find((s) => s.type === 'text');
    expect(textSeg?.data?.text).toContain('正在分析视频');
  });

  it('handle emits video.analyze event', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const plugin = await initPlugin({ messageAPI: mockAPI as any, eventRouter });

    const ctx = makeHookContext({ messageText: '看这个 https://www.bilibili.com/video/BV1GJ411x7h7' });
    const interceptor = (plugin as any).videoInterceptor;

    let receivedPayload: VideoAnalyzePayload | null = null;
    (eventRouter as any).onEvent('video.analyze', (p: VideoAnalyzePayload) => {
      receivedPayload = p;
    });

    // handle() emits via setImmediate, so we need to wait a tick
    await interceptor.handle(ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedPayload).not.toBeNull();
    const payload = receivedPayload as unknown as VideoAnalyzePayload;
    expect(payload.url).toBe('https://www.bilibili.com/video/BV1GJ411x7h7');
    expect(payload.userId).toBe(456);
    expect(payload.groupId).toBe(1);
    expect(payload.messageType).toBe('group');
  });
});

// ---------------------------------------------------------------------------
// Concurrency lock tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzePlugin concurrency lock', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('second video.analyze event is skipped when same group is already processing', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const callOrder: string[] = [];

    // onRun fires at the start of each runSubAgent call — used to track how many subagents ran
    const mockAIService = createMockAIService({
      result: { text: 'analysis result' },
      onRun: () => callOrder.push('first-run'),
    });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload1: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc123',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      protocol: 'milky',
    };

    const payload2: VideoAnalyzePayload = {
      url: 'https://youtu.be/xyz789',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      protocol: 'milky',
    };

    // Start first task without awaiting — lock is set synchronously before first await inside handleVideoAnalyzeEvent
    const firstTask = (plugin as any).handleVideoAnalyzeEvent(payload1);
    // Immediately trigger second — lock should already be held by the first task
    await (plugin as any).handleVideoAnalyzeEvent(payload2);

    // First task should still complete normally
    await firstTask;

    // Only one subagent should have run (the first one; second was skipped due to lock)
    expect(callOrder).toEqual(['first-run']);
  });

  it('lock is released after SubAgent completes successfully', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ result: { text: 'result' } });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc',
      userId: 789,
      groupId: 100,
      messageType: 'group',
      protocol: 'milky',
    };

    await (plugin as any).handleVideoAnalyzeEvent(payload);

    // Lock must be released after success
    expect((plugin as any).groupLocks.has('100')).toBe(false);
  });

  it('lock is released after SubAgent fails', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ throws: new Error('subagent error') });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc',
      userId: 789,
      groupId: 100,
      messageType: 'group',
      protocol: 'milky',
    };

    await (plugin as any).handleVideoAnalyzeEvent(payload);

    // Lock must be released even after error
    expect((plugin as any).groupLocks.has('100')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Result message tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzePlugin result messaging', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('sends analysis result to group when messageType is group', async () => {
    const { api: mockAPI, sentMessages } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ result: { text: '这是视频分析结果：主要内容是...' } });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      protocol: 'milky',
    };

    await (plugin as any).handleVideoAnalyzeEvent(payload);

    expect(sentMessages.some((m) => m.target === 'group:1')).toBe(true);
    const msg = sentMessages.find((m) => m.target === 'group:1');
    expect(msg?.message).toContain('这是视频分析结果');
  });

  it('sends analysis result to private chat when messageType is private', async () => {
    const { api: mockAPI, sentMessages } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ result: { text: 'private result' } });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc',
      userId: 999,
      groupId: undefined,
      messageType: 'private',
      protocol: 'milky',
    };

    await (plugin as any).handleVideoAnalyzeEvent(payload);

    expect(sentMessages.some((m) => m.target === 'user:999')).toBe(true);
  });

  it('sends friendly error message when SubAgent throws', async () => {
    const { api: mockAPI, sentMessages } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ throws: new Error('network error') });

    const plugin = await initPlugin({
      messageAPI: mockAPI as any,
      eventRouter,
      aiService: mockAIService,
    });

    const payload: VideoAnalyzePayload = {
      url: 'https://youtu.be/abc',
      userId: 456,
      groupId: 1,
      messageType: 'group',
      protocol: 'milky',
    };

    await (plugin as any).handleVideoAnalyzeEvent(payload);

    expect(sentMessages.some((m) => m.target === 'group:1' && m.message.includes('抱歉'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onDisable cleanup tests
// ---------------------------------------------------------------------------

describe('VideoAnalyzePlugin onDisable', () => {
  afterEach(() => {
    getContainer().clear();
  });

  it('unregisters interceptor on disable', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const plugin = await initPlugin({ messageAPI: mockAPI as any, eventRouter });

    const registry = getContainer().resolve<ProcessStageInterceptorRegistry>(
      DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY,
    );
    const initialCount = registry.getInterceptors().length;

    await plugin.onDisable();

    expect(registry.getInterceptors().length).toBe(initialCount - 1);
  });

  it('unregisters video.analyze event handler on disable', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const plugin = await initPlugin({ messageAPI: mockAPI as any, eventRouter });

    // Handler should be registered after onEnable
    expect((plugin as any).videoAnalyzeHandler).not.toBeNull();
    const handlersBefore = (eventRouter as any)._getHandlers('video.analyze').size;

    await plugin.onDisable();

    // Handler reference should be cleared and the router entry removed
    expect((plugin as any).videoAnalyzeHandler).toBeNull();
    const handlersAfter = (eventRouter as any)._getHandlers('video.analyze').size;
    expect(handlersAfter).toBe(handlersBefore - 1);
  });
});
