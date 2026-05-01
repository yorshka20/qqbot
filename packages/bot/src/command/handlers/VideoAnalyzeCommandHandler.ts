// /video command — analyze a video by URL, quoted message, or inline video file.
//
// Trigger methods:
//   1. /video <url>            — analyze video at the given URL
//   2. /video (reply to msg)   — extract video URL or video file from the quoted message
//   3. /video <prompt> (reply) — custom analysis prompt + video from quoted message
//
// The command spawns a video_analyzer SubAgent in the background and sends the
// result back to the originating chat when done.

import { inject, injectable } from 'tsyringe';
import type { AIService } from '@/ai';
import { getReplyMessageIdFromMessage } from '@/ai/utils/imageUtils';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { extractVideoUrl } from '@/plugins/plugins/VideoAnalyzePlugin';
import { extractUrlsFromLightAppPayload } from '@/protocol/milky/utils/lightAppParser';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** SubAgent type key matching prompts/subagent/video_analyzer preset. */
const VIDEO_AGENT_TYPE = 'video_analyzer';
const TASK_DESCRIPTION = '分析给定的视频 URL，提供完整的内容摘要和关键看点。使用中文回答。';

@Command({
  name: 'video',
  description: '分析视频内容：支持 URL、引用视频消息、或引用包含视频链接的消息',
  usage: '/video [url] [--prompt=<自定义分析要求>]  或  引用视频消息后发送 /video',
  aliases: ['分析视频', '视频分析'],
  permissions: ['user'],
})
@injectable()
export class VideoAnalyzeCommandHandler implements CommandHandler {
  name = 'video';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // --- Step 1: Resolve video source (URL or file) ---
    const resolved = await this.resolveVideoSource(args, context);
    if (!resolved.url) {
      return {
        success: false,
        error:
          '未找到可分析的视频。请使用以下方式：\n' +
          '  /video <视频链接>\n' +
          '  引用含视频链接的消息后发送 /video\n' +
          '  引用视频文件消息后发送 /video',
      };
    }

    const { url, customPrompt } = resolved;

    // --- Step 2: Fire-and-forget SubAgent analysis ---
    const parentContext = {
      userId: context.userId,
      groupId: context.groupId,
      messageType: context.messageType,
      protocol: context.metadata.protocol,
    };

    const prompt =
      customPrompt || '请分析这个视频，提供内容摘要、关键看点、以及你认为有价值的见解。回复需要简洁有条理。';

    this.aiService
      .runSubAgent(VIDEO_AGENT_TYPE as any, {
        description: TASK_DESCRIPTION,
        input: { url, customPrompt: prompt },
        parentContext,
      })
      .then(async (result) => {
        const replyText = result.trim() || '视频分析完成，但未返回有效结果。';
        await this.sendAnalysisResult(replyText, context);
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[VideoAnalyzeCommand] SubAgent failed: ${msg}`);
        await this.messageAPI.sendFromContext('视频分析失败，请稍后重试。', context);
      });

    // --- Step 3: Return immediate acknowledgement ---
    return {
      success: true,
      segments: [{ type: 'text', data: { text: `正在分析视频，请稍候...\n🔗 ${url}` } }],
    };
  }

  /**
   * Deliver the analysis result as forward message (合并转发) when possible,
   * otherwise fall back to plain text.
   */
  private async sendAnalysisResult(text: string, context: CommandContext): Promise<void> {
    const protocol = context.metadata.protocol;
    const botSelfId = this.config.getBotUserId();
    const segments = new MessageBuilder().text(text).build();

    const useForward = context.messageType === 'group' && protocol === 'milky' && botSelfId > 0;

    if (useForward) {
      await this.messageAPI.sendForwardFromContext([{ segments, senderName: 'Bot' }], context, 60_000, {
        botUserId: botSelfId,
      });
    } else {
      await this.messageAPI.sendFromContext(segments, context, 60_000);
    }
  }

  /**
   * Resolve the video URL from command args, quoted message, or inline video segment.
   * Returns { url, customPrompt } where customPrompt is any non-URL text in args.
   *
   * Extraction priority:
   *   1. Platform-specific pattern match from args text (bilibili, youtube, b23.tv, bare BV)
   *   2. Generic https?:// URL from args text
   *   3. Quoted/reply message: video segments → text URL extraction
   *   4. Current message video segments
   */
  private async resolveVideoSource(
    args: string[],
    context: CommandContext,
  ): Promise<{ url: string | null; customPrompt: string | null }> {
    const argsText = args.join(' ');

    // 1. Try platform-specific video URL extraction from combined args text
    const platformUrl = extractVideoUrl(argsText);
    if (platformUrl) {
      return this.splitUrlAndPrompt(argsText, platformUrl);
    }

    // 2. Try generic URL extraction (any https?:// URL) from combined args text
    const genericUrl = argsText.match(/https?:\/\/[^\s<>"')\]]+/)?.[0];
    if (genericUrl) {
      return this.splitUrlAndPrompt(argsText, genericUrl);
    }

    // 3. Check quoted/reply message for video content
    const originalMessage = context.originalMessage;
    if (originalMessage) {
      const resolvedFromReply = await this.resolveFromReplyMessage(originalMessage);
      if (resolvedFromReply) {
        return { url: resolvedFromReply, customPrompt: argsText.trim() || null };
      }

      // 4. Check current message segments for inline video file
      const videoUrl = await this.extractVideoFromSegments(originalMessage.segments, originalMessage);
      if (videoUrl) {
        return { url: videoUrl, customPrompt: argsText.trim() || null };
      }
    }

    return { url: null, customPrompt: null };
  }

  /** Remove the extracted URL from the args text and return { url, customPrompt }. */
  private splitUrlAndPrompt(argsText: string, url: string): { url: string; customPrompt: string | null } {
    // Find and remove the raw matched text from the original args (before normalization may have changed it)
    // We search for common URL-like substrings to remove
    let remaining = argsText;
    // Try removing the exact URL first
    if (remaining.includes(url)) {
      remaining = remaining.replace(url, '');
    } else {
      // URL may have been normalized (e.g., bare BV → full URL), remove original pattern
      // Remove any https?:// URL
      remaining = remaining.replace(/https?:\/\/[^\s<>"')\]]+/, '');
      // Remove bare BV number
      remaining = remaining.replace(/\bBV[a-zA-Z0-9]{10,}\b/, '');
      // Remove bare domain patterns
      remaining = remaining.replace(
        /(?:www\.)?(?:bilibili\.com\/video\/[^\s]+|b23\.tv\/[^\s]+|youtube\.com\/(?:watch\?[^\s]+|shorts\/[^\s]+)|youtu\.be\/[^\s]+)/,
        '',
      );
    }
    const customPrompt = remaining.trim() || null;
    return { url, customPrompt };
  }

  /**
   * Try to extract video from a quoted (reply) message:
   * 1. Fetch the referenced message
   * 2. Check its segments for video file or video URL in text
   */
  private async resolveFromReplyMessage(currentMessage: NormalizedMessageEvent): Promise<string | null> {
    const replyMessageId = getReplyMessageIdFromMessage(currentMessage);
    if (replyMessageId === null) {
      return null;
    }

    try {
      const referencedMessage = await this.messageAPI.getMessageFromContext(
        replyMessageId,
        currentMessage,
        this.databaseManager,
      );

      // Check referenced message segments for video file
      const videoUrl = await this.extractVideoFromSegments(referencedMessage.segments, currentMessage);
      if (videoUrl) {
        return videoUrl;
      }

      // Check referenced message text for video URL
      const messageText = referencedMessage.message ?? '';
      const urlFromText = extractVideoUrl(messageText);
      if (urlFromText) {
        return urlFromText;
      }

      // Check raw segments for text containing URLs, and light_app segments for video URLs
      if (referencedMessage.segments) {
        for (const seg of referencedMessage.segments) {
          if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            const found = extractVideoUrl(seg.data.text as string);
            if (found) {
              return found;
            }
          }
          // Parse light_app (小程序) segment: extract jump link URLs, keep only video platform URLs
          if (seg.type === 'light_app' && seg.data) {
            const jsonPayload =
              (seg.data as Record<string, unknown>).json_payload ?? (seg.data as Record<string, unknown>).jsonPayload;
            if (typeof jsonPayload === 'string') {
              const jumpUrls = extractUrlsFromLightAppPayload(jsonPayload);
              for (const jumpUrl of jumpUrls) {
                const videoUrl = extractVideoUrl(jumpUrl);
                if (videoUrl) {
                  return videoUrl;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(
        `[VideoAnalyzeCommand] Failed to fetch reply message ${replyMessageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return null;
  }

  /**
   * Extract a downloadable video URL from message segments.
   * Handles video-type segments by resolving their resource URL.
   */
  private async extractVideoFromSegments(
    segments: NormalizedMessageEvent['segments'],
    contextMessage: NormalizedMessageEvent,
  ): Promise<string | null> {
    if (!segments?.length) {
      return null;
    }

    for (const segment of segments) {
      if (segment.type !== 'video' || !segment.data) {
        continue;
      }

      const data = segment.data as Record<string, unknown>;

      // Try direct URL first
      const directUrl = (data.temp_url ?? data.uri ?? data.url) as string | undefined;
      if (directUrl && (directUrl.startsWith('http://') || directUrl.startsWith('https://'))) {
        return directUrl;
      }

      // Resolve via resource_id (Milky protocol)
      const resourceId = (data.resource_id ?? data.file_id) as string | undefined;
      if (resourceId) {
        try {
          const resolved = await this.messageAPI.getResourceTempUrl(resourceId, contextMessage);
          if (resolved) {
            return resolved;
          }
        } catch (err) {
          logger.debug(
            `[VideoAnalyzeCommand] getResourceTempUrl failed for video segment: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return null;
  }
}
