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
import type { APIClient } from '@/api/APIClient';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { NormalizedMessageEvent } from '@/events/types';
import { extractVideoUrl } from '@/plugins/plugins/VideoAnalyzePlugin';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** SubAgent type key matching prompts/subagent/video_analyzer preset. */
const VIDEO_AGENT_TYPE = 'video_analyzer';
const TASK_DESCRIPTION = 'Analyze the given video URL and provide a comprehensive summary.';

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

  private messageAPI: MessageAPI;

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
  ) {
    this.messageAPI = new MessageAPI(apiClient);
  }

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

    const prompt = customPrompt || '请分析这个视频，提供内容摘要、关键看点、以及你认为有价值的见解。回复需要简洁有条理。';

    this.aiService
      .runSubAgent(VIDEO_AGENT_TYPE as any, {
        description: TASK_DESCRIPTION,
        input: { url, customPrompt: prompt },
        parentContext,
      })
      .then(async (result) => {
        // runSubAgent returns a plain string (from SubAgentExecutor.parseResult), not { text, error }
        const r = result as string | { text?: string; error?: string } | null;
        const replyText =
          typeof r === 'string' && r.trim().length > 0
            ? r
            : (r as { text?: string; error?: string } | null)?.text ??
              (r as { text?: string; error?: string } | null)?.error ??
              '视频分析完成，但未返回有效结果。';
        await this.messageAPI.sendFromContext(replyText, context);
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
   * Resolve the video URL from command args, quoted message, or inline video segment.
   * Returns { url, customPrompt } where customPrompt is any non-URL text in args.
   */
  private async resolveVideoSource(
    args: string[],
    context: CommandContext,
  ): Promise<{ url: string | null; customPrompt: string | null }> {
    // 1. Check args for a direct URL
    const urlArg = args.find((a) => /^https?:\/\//.test(a));
    if (urlArg) {
      const nonUrlArgs = args.filter((a) => a !== urlArg).join(' ').trim();
      return { url: urlArg, customPrompt: nonUrlArgs || null };
    }

    // 2. Check for a video URL pattern in the full args text (e.g. bilibili.com/video/BVxxx without https)
    const argsText = args.join(' ');
    const urlFromArgs = extractVideoUrl(argsText);
    if (urlFromArgs) {
      const nonUrlArgs = argsText.replace(urlFromArgs, '').trim();
      return { url: urlFromArgs, customPrompt: nonUrlArgs || null };
    }

    // 3. Check quoted/reply message for video content
    const originalMessage = context.originalMessage;
    if (originalMessage) {
      const resolvedFromReply = await this.resolveFromReplyMessage(originalMessage);
      if (resolvedFromReply) {
        const customPrompt = argsText.trim() || null;
        return { url: resolvedFromReply, customPrompt };
      }

      // 4. Check current message segments for inline video file
      const videoUrl = await this.extractVideoFromSegments(originalMessage.segments, originalMessage);
      if (videoUrl) {
        const customPrompt = argsText.trim() || null;
        return { url: videoUrl, customPrompt };
      }
    }

    return { url: null, customPrompt: null };
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

      // Also check raw segments for text containing URLs
      if (referencedMessage.segments) {
        for (const seg of referencedMessage.segments) {
          if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            const found = extractVideoUrl(seg.data.text as string);
            if (found) {
              return found;
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
