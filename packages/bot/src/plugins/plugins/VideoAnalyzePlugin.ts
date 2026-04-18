// Video Analyze Plugin - handle video.analyze events via SubAgent
//
// This plugin provides the async video analysis backend:
//   - Listens for 'video.analyze' events (emitted by other modules)
//   - Runs a video_analyzer SubAgent and sends the result back to the originating chat
//   - Maintains per-group/user concurrency locks
//
// Video analysis is triggered explicitly via:
//   - /video command (VideoAnalyzeCommandHandler)
//   - LLM tool call (analyze_video tool with visibility: ['reply', 'subagent'])

import type { SubAgentType } from '@/agent/types';
import type { AIService } from '@/ai/AIService';
import type { Config } from '@/core/config';
import type { ProtocolName } from '@/core/config/types/protocol';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EventHandler, NormalizedEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { logger } from '@/utils/logger';

/** SubAgent type for video analysis (matches the preset key registered by the video_analyzer tool). */
const VIDEO_AGENT_TYPE = 'video_analyzer';

/** Prompt sent to the LLM describing the analysis task (used as task.description). */
const TASK_DESCRIPTION = '分析给定的视频 URL，提供完整的内容摘要和关键看点。使用中文回答。';

/** Lock TTL in ms before auto-release (safety valve). */
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Video URL patterns for supported platforms.
 * Matches: Bilibili (long video), b23.tv short link, YouTube, youtu.be short link.
 * Patterns with protocol prefix are tried first, then bare-domain patterns.
 */
const VIDEO_URL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // --- With protocol ---
  // Bilibili long video: bilibili.com/video/BVxxxx or bilibili.com/video/AVxxxx
  { pattern: /https?:\/\/(www\.)?bilibili\.com\/video\/[a-zA-Z0-9]+[a-zA-Z0-9?&=_-]*/, label: 'bilibili' },
  // Bilibili short link: b23.tv/xxxxx
  { pattern: /https?:\/\/b23\.tv\/[a-zA-Z0-9]+/, label: 'b23' },
  // YouTube watch: youtube.com/watch?v=xxxx (require v= with at least 1 char ID, capture extra params)
  { pattern: /https?:\/\/(www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+[a-zA-Z0-9&=_%.-]*/, label: 'youtube' },
  // YouTube shorts: youtube.com/shorts/xxxx
  { pattern: /https?:\/\/(www\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]+/, label: 'youtube' },
  // YouTube short link: youtu.be/xxxx
  { pattern: /https?:\/\/youtu\.be\/[a-zA-Z0-9_-]+/, label: 'youtube' },
  // --- Bare domain (no protocol) ---
  { pattern: /(?:www\.)?bilibili\.com\/video\/[a-zA-Z0-9]+[a-zA-Z0-9?&=_-]*/, label: 'bilibili-bare' },
  { pattern: /b23\.tv\/[a-zA-Z0-9]+/, label: 'b23-bare' },
  { pattern: /(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+[a-zA-Z0-9&=_%.-]*/, label: 'youtube-bare' },
  { pattern: /(?:www\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]+/, label: 'youtube-bare' },
  { pattern: /youtu\.be\/[a-zA-Z0-9_-]+/, label: 'youtube-bare' },
  // --- Bare BV number (Bilibili) ---
  { pattern: /\bBV[a-zA-Z0-9]{10,}\b/, label: 'bilibili-bv' },
];

/**
 * Extracts the first video URL from a message string, or null if none found.
 * Bare-domain matches and BV numbers are normalized to full URLs with https:// prefix.
 */
export function extractVideoUrl(message: string): string | null {
  for (const { pattern, label } of VIDEO_URL_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      return normalizeVideoUrl(match[0], label);
    }
  }
  return null;
}

/** Normalize extracted URL: add https:// for bare domains, construct bilibili URL for BV numbers. */
function normalizeVideoUrl(raw: string, label: string): string {
  if (label === 'bilibili-bv') {
    return `https://www.bilibili.com/video/${raw}`;
  }
  if (label.endsWith('-bare') && !/^https?:\/\//i.test(raw)) {
    return `https://${raw}`;
  }
  return raw;
}

/**
 * Extracts all video URLs from a message string.
 * Returns unique normalized URLs in order of appearance.
 */
export function extractAllVideoUrls(message: string): string[] {
  const urls: string[] = [];
  for (const { pattern, label } of VIDEO_URL_PATTERNS) {
    const matches = message.matchAll(new RegExp(pattern, 'g'));
    for (const match of matches) {
      const normalized = normalizeVideoUrl(match[0], label);
      if (!urls.includes(normalized)) {
        urls.push(normalized);
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
  description: 'Handle video.analyze events via SubAgent (triggered by /video command or other modules)',
})
export class VideoAnalyzePlugin extends PluginBase {
  private aiService!: AIService;

  /** Stored reference to the video.analyze event handler for proper unregistration. */
  private videoAnalyzeHandler: ((payload: VideoAnalyzePayload) => Promise<void>) | null = null;

  /** Concurrency locks: key = groupId for groups, key = userId for private chats. */
  private readonly groupLocks = new Map<string, ActiveTask>();
  private readonly userLocks = new Map<string, ActiveTask>();

  async onInit(): Promise<void> {
    const container = getContainer();
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);

    if (!this.aiService) {
      throw new Error('[VideoAnalyzePlugin] AIService not found');
    }

    logger.info('[VideoAnalyzePlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    // Register video.analyze event handler
    this.videoAnalyzeHandler = async (payload: VideoAnalyzePayload) => {
      await this.handleVideoAnalyzeEvent(payload);
    };
    this.events.onEvent('video.analyze', this.videoAnalyzeHandler as unknown as EventHandler<NormalizedEvent>);

    logger.info('[VideoAnalyzePlugin] Registered video.analyze event handler');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();

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

    logger.info('[VideoAnalyzePlugin] Disabled');
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
      const result = await this.aiService.runSubAgent(VIDEO_AGENT_TYPE as SubAgentType, {
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
      });

      const replyText = result.trim() || '视频分析完成，但未返回有效结果。';
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
   *
   * Delivery order (same as SubAgentTriggerHandler):
   *   1. Card rendering — long content → image
   *   2. Forward message — group with useForwardMsg enabled (Milky protocol)
   *   3. Plain text — fallback
   *
   * Short error messages bypass card/forward and are sent as plain text.
   */
  private async sendResultMessage(text: string, payload: VideoAnalyzePayload): Promise<void> {
    const { userId, groupId, messageType, protocol } = payload;

    try {
      const container = getContainer();
      const messageAPI = container.resolve<import('@/api/methods/MessageAPI').MessageAPI>(DITokens.MESSAGE_API);
      const config = container.resolve<Config>(DITokens.CONFIG);
      const botSelfId = config.getBotUserId();

      const segments = new MessageBuilder().text(text).build();

      // Forward message: group chats on Milky protocol
      const useForward = messageType === 'group' && groupId != null && protocol === 'milky' && botSelfId > 0;

      if (messageType === 'group' && groupId != null) {
        if (useForward) {
          await messageAPI.sendForwardMessage(
            { type: 'group', id: groupId },
            [{ segments, senderName: 'Bot' }],
            protocol as ProtocolName,
            { botUserId: botSelfId },
          );
        } else {
          await messageAPI.sendGroupMessage(groupId, segments, protocol as ProtocolName);
        }
      } else {
        await messageAPI.sendPrivateMessage(userId, segments, protocol as ProtocolName);
      }
    } catch (err) {
      logger.error('[VideoAnalyzePlugin] Failed to send result message', err as Error);
    }
  }
}

// --- Export types for testing ---
export type { VideoAnalyzePlugin as VideoAnalyzePluginClass };
