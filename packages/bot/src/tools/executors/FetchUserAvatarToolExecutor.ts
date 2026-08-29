// Fetch user avatar tool executor — downloads a QQ user's avatar PNG and
// returns it as a base64 ContentPart so the LLM can view it via vision.
//
// QQ exposes avatars at a stable URL (`https://q1.qlogo.cn/g?b=qq&nk=<uid>&s=<size>`);
// no auth, no rate-limit-relevant headers. The same endpoint is used by
// the GroupReportPlugin for daily-report rendering — keeping a separate
// helper here (rather than refactoring GroupReport's) avoids tangling
// concerns: this tool needs a raw fetch + vision-block return, while
// GroupReport pre-batches a Map of data URIs for HTML embedding.

import { inject, injectable } from 'tsyringe';
import type { ContentPart } from '@/ai/types';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { resolveConversationScope } from './conversationScope';
import { resolveSender, SENDER_PARAM_DESCRIPTIONS } from './senderResolution';

/** Larger than GroupReport's 140px — model needs enough detail to "see" the avatar. */
const AVATAR_SIZE = 640;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

@Tool({
  name: 'fetch_user_avatar',
  description: '获取指定 QQ 用户的头像图片，返回给你进行视觉分析。仅适用于 QQ 平台用户。',
  executor: 'fetch_user_avatar',
  visibility: {
    reply: { sources: ['qq-private', 'qq-group'] },
    subagent: true,
  },
  parameters: {
    user_id: {
      type: 'string',
      required: false,
      description: SENDER_PARAM_DESCRIPTIONS.userId,
    },
    nickname: {
      type: 'string',
      required: false,
      description: SENDER_PARAM_DESCRIPTIONS.nickname,
    },
  },
  examples: ['{"user_id":"10001"}', '{"nickname":"某某"}'],
  triggerKeywords: ['头像', 'avatar', '看头像'],
  whenToUse:
    '当用户要求查看某个 QQ 用户的头像内容时调用。只有名字没有 QQ 号也能用，填 nickname 即可。注意：该工具仅获取头像图片本身，不附带用户其它信息。',
})
@injectable()
export class FetchUserAvatarToolExecutor extends BaseToolExecutor {
  name = 'fetch_user_avatar';

  constructor(
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const userId = await this.resolveTarget(call, context);
    if (typeof userId !== 'string') {
      return userId;
    }
    if (!/^\d+$/.test(userId)) {
      return this.error(`无效的 QQ 号: ${userId}（应为纯数字）`, `Invalid QQ uid: ${userId}`);
    }

    const url = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=${AVATAR_SIZE}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return this.error(
          `头像获取失败（HTTP ${response.status}）`,
          `Avatar fetch failed: HTTP ${response.status} for uid=${userId}`,
        );
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        return this.error('头像数据为空', `Empty avatar payload for uid=${userId}`);
      }
      if (buffer.byteLength > MAX_BYTES) {
        return this.error(
          `头像文件过大 (${buffer.byteLength} bytes)`,
          `Avatar payload exceeds ${MAX_BYTES} bytes for uid=${userId}`,
        );
      }

      const mime = response.headers.get('content-type') || 'image/jpeg';
      const base64 = Buffer.from(buffer).toString('base64');
      const dataUrl = `data:${mime};base64,${base64}`;

      logger.info(
        `[FetchUserAvatarToolExecutor] Fetched avatar | uid=${userId} mime=${mime} size=${buffer.byteLength}`,
      );

      const contentParts: ContentPart[] = [{ type: 'image_url', image_url: { url: dataUrl } }];
      return {
        success: true,
        reply: `已获取 QQ ${userId} 的头像`,
        data: {
          userId,
          mimeType: mime,
          sizeBytes: buffer.byteLength,
        },
        contentParts,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const reason = isAbort ? '请求超时' : errMsg;
      logger.warn(`[FetchUserAvatarToolExecutor] Avatar fetch failed | uid=${userId} reason=${reason}`);
      return this.error(`头像获取失败：${reason}`, `Avatar fetch failed for uid=${userId}: ${errMsg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The QQ id to fetch, or the ToolResult explaining why we could not settle on one. */
  private async resolveTarget(call: ToolCall, context: ToolExecutionContext): Promise<string | ToolResult> {
    const scope = resolveConversationScope(context);
    const params = { userId: call.parameters?.user_id, nickname: call.parameters?.nickname };

    if (!scope) {
      const raw = params.userId;
      const direct = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
      return direct || this.error('请提供 user_id（目标用户的 QQ 号）', 'Missing required parameter: user_id');
    }

    const resolution = await resolveSender(this.conversationHistoryService, scope, params);
    switch (resolution.kind) {
      case 'resolved':
        return resolution.userId;
      case 'not_found':
      case 'ambiguous':
        return this.success(resolution.message, { nickname: resolution.nickname });
      default:
        return this.error(
          '请提供 user_id（QQ 号）或 nickname（昵称）其中之一',
          'Missing required parameter: user_id or nickname',
        );
    }
  }
}
