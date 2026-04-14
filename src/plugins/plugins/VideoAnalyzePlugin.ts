// Video Analyze Plugin - auto-intercept video URLs and analyze them via SubAgent

import type { EventEmitter } from 'node:events';
import type { SubAgentType } from '@/agent/types';
import type { AIService } from '@/ai/AIService';
import type { ProcessStageInterceptor, ProcessStageInterceptorRegistry } from '@/conversation/ProcessStageInterceptor';
import type { ProtocolName } from '@/core/config/types/protocol';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EventHandler, NormalizedEvent } from '@/events/types';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { logger } from '@/utils/logger';

/** SubAgent type for video analysis (matches the preset key registered by the video_analyzer tool). */
const VIDEO_AGENT_TYPE = 'video_analyzer';

/** Prompt sent to the LLM describing the analysis task (used as task.description). */
const TASK_DESCRIPTION = 'Analyze the given video URL and provide a comprehensive summary, key points, and insights.';

/** Lock TTL in ms before auto-release (safety valve). */
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Video URL patterns for supported platforms.
 * Matches: Bilibili (long video), b23.tv short link, YouTube, youtu.be short link.
 * All patterns require https?:// prefix — bare-domain URLs are not matched.
 * Does NOT match generic "watch" pages without video IDs or non-video URLs.
 */
const VIDEO_URL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Bilibili long video: bilibili.com/video/BVxxxx or bilibili.com/video/AVxxxx
  { pattern: /https?:\/\/(www\.)?bilibili\.com\/video\/[a-zA-Z0-9]+/, label: 'bilibili' },
  // Bilibili short link: b23.tv/xxxxx
  { pattern: /https?:\/\/b23\.tv\/[a-zA-Z0-9]+/, label: 'b23' },
  // YouTube watch: youtube.com/watch?v=xxxx
  { pattern: /https?:\/\/(www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/, label: 'youtube' },
  // YouTube short link: youtu.be/xxxx
  { pattern: /https?:\/\/youtu\.be\/[a-zA-Z0-9_-]+/, label: 'youtube' },
];

/** Extracts the first video URL from a message string, or null if none found. */
export function extractVideoUrl(message: string): string | null {
  for (const { pattern } of VIDEO_URL_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

/**
 * Extracts all video URLs from a message string.
 * Returns unique URLs in order of appearance.
 */
export function extractAllVideoUrls(message: string): string[] {
  const urls: string[] = [];
  for (const { pattern } of VIDEO_URL_PATTERNS) {
    const matches = message.matchAll(new RegExp(pattern, 'g'));
    for (const match of matches) {
      if (!urls.includes(match[0])) {
        urls.push(match[0]);
      }
    }
  }
  return urls;
}

/** Payload emitted via the video.analyze event. */
export interface VideoAnalyzePayload {
  /** The detected video URL. */
  url: string;
  /** User who sent the message. */
  userId: number | string;
  /** Group where the message was sent (absent for private chats). */
  groupId?: number | string;
  /** 'private' | 'group'. */
  messageType: 'private' | 'group';
  /** Protocol name (milky, onebot11, satori). */
  protocol: string;
  /** Optional message ID for reference. */
  messageId?: string;
}

/**
 * Active task entry stored in the concurrency lock map.
 */
interface ActiveTask {
  url: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

@RegisterPlugin({
  name: 'video-analyze',
  version: '1.0.0',
  description: 'Auto-detect video URLs in chat and analyze them via SubAgent',
})
export class VideoAnalyzePlugin extends PluginBase {
  private aiService!: AIService;
  private processStageInterceptorRegistry!: ProcessStageInterceptorRegistry;
  private videoInterceptor: ProcessStageInterceptor | null = null;

  /** Stored reference to the video.analyze event handler for proper unregistration. */
  private videoAnalyzeHandler: ((payload: VideoAnalyzePayload) => Promise<void>) | null = null;

  /** Concurrency locks: key = groupId for groups, key = userId for private chats. */
  private readonly groupLocks = new Map<string, ActiveTask>();
  private readonly userLocks = new Map<string, ActiveTask>();

  async onInit(): Promise<void> {
    const container = getContainer();
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
    this.processStageInterceptorRegistry = container.resolve<ProcessStageInterceptorRegistry>(
      DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY,
    );

    if (!this.aiService || !this.processStageInterceptorRegistry) {
      throw new Error('[VideoAnalyzePlugin] Required dependencies not found');
    }

    logger.info('[VideoAnalyzePlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    logger.info('[VideoAnalyzePlugin] Enabling video analyze plugin');

    // --- Register process-stage interceptor ---
    this.videoInterceptor = {
      shouldIntercept: async (ctx: HookContext): Promise<boolean> => {
        // Skip if already handled by another process-stage interceptor (e.g. NSFW)
        if (ctx.reply != null) {
          return false;
        }
        // Skip bot's own messages
        const botSelfId = ctx.metadata.get('botSelfId');
        const messageUserId = ctx.message?.userId?.toString();
        if (botSelfId && messageUserId === botSelfId) {
          return false;
        }
        // Skip command messages (already handled by command system)
        if (ctx.command) {
          return false;
        }
        // Detect video URL in message text
        const messageText = ctx.message?.message ?? '';
        return extractVideoUrl(messageText) !== null;
      },

      handle: async (ctx: HookContext): Promise<void> => {
        const messageText = ctx.message?.message ?? '';
        const url = extractVideoUrl(messageText);
        if (!url) {
          return;
        }

        const { userId, groupId, messageType, protocol } = ctx.message;

        // --- Set immediate friendly reply ---
        const segments = new MessageBuilder().text('正在分析视频，请稍候...').build();
        ctx.reply = {
          source: 'plugin',
          segments,
        };

        // --- Emit background event (fire-and-forget via setImmediate) ---
        const payload: VideoAnalyzePayload = {
          url,
          userId,
          groupId,
          messageType: messageType ?? 'private',
          protocol: protocol ?? 'milky',
          messageId: ctx.message?.id ?? ctx.message?.messageId?.toString(),
        };

        // Emit asynchronously so handle() returns immediately without blocking the pipeline
        setImmediate(() => {
          this.emitVideoAnalyzeEvent(payload);
        });
      },
    };

    this.processStageInterceptorRegistry.register(this.videoInterceptor);

    // --- Register video.analyze event handler with stored reference for later unregistration ---
    this.videoAnalyzeHandler = async (payload: VideoAnalyzePayload) => {
      await this.handleVideoAnalyzeEvent(payload);
    };
    // Custom event payload is VideoAnalyzePayload; EventRouter types handlers as NormalizedEvent.
    this.events.onEvent('video.analyze', this.videoAnalyzeHandler as unknown as EventHandler<NormalizedEvent>);

    logger.info('[VideoAnalyzePlugin] Registered process-stage interceptor and video.analyze event handler');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[VideoAnalyzePlugin] Disabling video analyze plugin');

    if (this.videoInterceptor) {
      this.processStageInterceptorRegistry.unregister(this.videoInterceptor);
      this.videoInterceptor = null;
    }

    // Unregister event handler using the stored reference
    if (this.videoAnalyzeHandler) {
      this.events.offEvent('video.analyze', this.videoAnalyzeHandler as unknown as EventHandler<NormalizedEvent>);
      this.videoAnalyzeHandler = null;
    }

    // Clear all active locks and their TTL timers
    for (const task of this.groupLocks.values()) {
      clearTimeout(task.timer);
    }
    this.groupLocks.clear();
    for (const task of this.userLocks.values()) {
      clearTimeout(task.timer);
    }
    this.userLocks.clear();

    logger.info('[VideoAnalyzePlugin] Unregistered interceptor and cleared locks');
  }

  /**
   * Emit the video.analyze event via EventRouter so all registered handlers receive it.
   * EventRouter's typed `emit` omits custom names; use the underlying EventEmitter.
   */
  private emitVideoAnalyzeEvent(payload: VideoAnalyzePayload): void {
    try {
      (this.events as unknown as EventEmitter).emit('video.analyze', payload);
    } catch (err) {
      logger.error('[VideoAnalyzePlugin] Failed to emit video.analyze event', err as Error);
    }
  }

  /**
   * Handle the video.analyze event: concurrency check → runSubAgent → send result.
   * Uses AIService.runSubAgent() which internally does spawn + execute + wait,
   * ensuring the subagent actually runs (vs. bare spawn which only creates the session).
   */
  private async handleVideoAnalyzeEvent(payload: VideoAnalyzePayload): Promise<void> {
    const { url, userId, groupId, messageType, protocol } = payload;

    // --- Concurrency lock ---
    const locks = messageType === 'group' ? this.groupLocks : this.userLocks;
    const sessionKey = groupId != null ? String(groupId) : String(userId);

    if (locks.has(sessionKey)) {
      logger.info(
        `[VideoAnalyzePlugin] Skipping video.analyze — already running | sessionKey=${sessionKey} | url=${url}`,
      );
      return;
    }

    // Acquire lock with TTL safety valve to prevent permanent lock on crash/hang
    const timer = setTimeout(() => {
      logger.warn(`[VideoAnalyzePlugin] Lock auto-released (TTL) | sessionKey=${sessionKey}`);
      locks.delete(sessionKey);
    }, LOCK_TTL_MS);

    locks.set(sessionKey, { url, startedAt: Date.now(), timer });

    logger.info(`[VideoAnalyzePlugin] Starting video analysis | sessionKey=${sessionKey} | url=${url}`);

    try {
      // runSubAgent = spawn + execute + wait (all three steps, correct subagent lifecycle)
      const result = (await this.aiService.runSubAgent(VIDEO_AGENT_TYPE as SubAgentType, {
        description: TASK_DESCRIPTION,
        input: {
          url,
          userId,
          groupId,
          messageType,
          protocol,
          customPrompt: '请分析这个视频，提供内容摘要、关键看点、以及你认为有价值的见解。回复需要简洁有条理。',
        },
        parentContext: {
          userId,
          groupId,
          messageType,
          protocol,
          messageId: payload.messageId,
        },
      })) as { text?: string; error?: string } | null;

      // Send the result (or fallback text) back to the original session
      const replyText = result?.text ?? result?.error ?? '视频分析完成，但未返回有效结果。';
      await this.sendResultMessage(replyText, payload);

      logger.info(`[VideoAnalyzePlugin] Video analysis completed | sessionKey=${sessionKey} | url=${url}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[VideoAnalyzePlugin] Video analysis failed | sessionKey=${sessionKey} | error=${errorMessage}`);

      // Send a user-friendly Chinese error message
      await this.sendResultMessage('抱歉，视频分析过程中发生了错误，请稍后重试。', payload);
    } finally {
      // Release the concurrency lock regardless of success or failure
      const task = locks.get(sessionKey);
      if (task) {
        clearTimeout(task.timer);
        locks.delete(sessionKey);
        logger.debug(`[VideoAnalyzePlugin] Lock released | sessionKey=${sessionKey}`);
      }
    }
  }

  /**
   * Send the analysis result (or error text) back to the original chat session.
   */
  private async sendResultMessage(text: string, payload: VideoAnalyzePayload): Promise<void> {
    const { userId, groupId, messageType, protocol } = payload;

    try {
      const messageAPI = getContainer().resolve<import('@/api/methods/MessageAPI').MessageAPI>(DITokens.MESSAGE_API);

      if (messageType === 'group' && groupId != null) {
        await messageAPI.sendGroupMessage(groupId, text, protocol as ProtocolName);
      } else {
        await messageAPI.sendPrivateMessage(userId, text, protocol as ProtocolName);
      }
    } catch (err) {
      logger.error('[VideoAnalyzePlugin] Failed to send result message', err as Error);
    }
  }
}

// --- Export types for testing ---
export type { VideoAnalyzePlugin as VideoAnalyzePluginClass };
