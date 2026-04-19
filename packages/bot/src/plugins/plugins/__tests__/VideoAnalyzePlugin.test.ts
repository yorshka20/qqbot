import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai/AIService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EventRouter } from '@/events/EventRouter';
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
    sendForwardMessage: async (
      target: { type: string; id: unknown },
      segments: Array<{ segments: Array<{ type: string; data: { text?: string } }>; senderName?: string }>,
      _protocol: string,
      _opts?: unknown,
    ) => {
      const text = segments?.[0]?.segments?.[0]?.data?.text ?? '[forward]';
      sentMessages.push({ target: `${target.type}:${target.id}`, message: text });
      return { message_seq: 1 };
    },
  } as unknown as MessageAPI;
  return { api, sentMessages };
}

function createMockConfig(): Config {
  return {
    getBotUserId: () => 12345,
  } as unknown as Config;
}

type MockAIServiceOpts = {
  /** Value returned by runSubAgent on success (string, as per SubAgent contract). */
  result?: string;
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
// Plugin bootstrap helper
// ---------------------------------------------------------------------------

async function initPlugin(
  overrides: { aiService?: AIService; messageAPI?: MessageAPI; eventRouter?: EventRouter; config?: Config } = {},
): Promise<VideoAnalyzePlugin> {
  const container = getContainer();
  const mockEventRouter = overrides.eventRouter ?? createMockEventRouter();
  const msgApi = overrides.messageAPI ?? createMockMessageAPI().api;
  const mockAIService = overrides.aiService ?? createMockAIService();
  const mockConfig = overrides.config ?? createMockConfig();

  container.registerInstance(DITokens.AI_SERVICE, mockAIService, { allowOverride: true });
  container.registerInstance(DITokens.MESSAGE_API, msgApi as any, { allowOverride: true });
  container.registerInstance(DITokens.EVENT_ROUTER, mockEventRouter, { allowOverride: true });
  container.registerInstance(DITokens.CONFIG, mockConfig, { allowOverride: true });

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

    it('returns null for non-video URLs', () => {
      expect(extractVideoUrl('https://google.com')).toBeNull();
      expect(extractVideoUrl('https://github.com/user/repo')).toBeNull();
      expect(extractVideoUrl('just a normal message')).toBeNull();
    });

    it('returns null for YouTube playlist URL (no watch?v=)', () => {
      expect(extractVideoUrl('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')).toBeNull();
    });

    it('returns null for incomplete video URL (no video ID)', () => {
      expect(extractVideoUrl('https://www.bilibili.com/video/')).toBeNull();
      expect(extractVideoUrl('https://www.youtube.com/watch?v=')).toBeNull();
    });

    it('normalizes bare-domain URLs by prepending https://', () => {
      expect(extractVideoUrl('bilibili.com/video/BV1GJ411x7h7')).toBe('https://bilibili.com/video/BV1GJ411x7h7');
      expect(extractVideoUrl('b23.tv/abc123')).toBe('https://b23.tv/abc123');
      expect(extractVideoUrl('youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ');
      expect(extractVideoUrl('youtu.be/dQw4w9WgXcQ')).toBe('https://youtu.be/dQw4w9WgXcQ');
    });

    it('matches bare BV number and constructs bilibili URL', () => {
      expect(extractVideoUrl('帮我看看 BV1GJ411x7h7 这个视频')).toBe('https://www.bilibili.com/video/BV1GJ411x7h7');
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

    const mockAIService = createMockAIService({
      result: 'analysis result',
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

    const firstTask = (plugin as any).handleVideoAnalyzeEvent(payload1);
    await (plugin as any).handleVideoAnalyzeEvent(payload2);
    await firstTask;

    expect(callOrder).toEqual(['first-run']);
  });

  it('lock is released after SubAgent completes successfully', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const mockAIService = createMockAIService({ result: 'result' });

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
    const mockAIService = createMockAIService({ result: '这是视频分析结果：主要内容是...' });

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
    const mockAIService = createMockAIService({ result: 'private result' });

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

  it('unregisters video.analyze event handler on disable', async () => {
    const { api: mockAPI } = createMockMessageAPI();
    const eventRouter = createMockEventRouter();
    const plugin = await initPlugin({ messageAPI: mockAPI as any, eventRouter });

    expect((plugin as any).videoAnalyzeHandler).not.toBeNull();
    const handlersBefore = (eventRouter as any)._getHandlers('video.analyze').size;

    await plugin.onDisable();

    expect((plugin as any).videoAnalyzeHandler).toBeNull();
    const handlersAfter = (eventRouter as any)._getHandlers('video.analyze').size;
    expect(handlersAfter).toBe(handlersBefore - 1);
  });
});
