// ZhihuDigestService — generates digests from feed items and pushes to QQ groups

import type { LLMService } from '@/ai/services/LLMService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { ZhihuFeedItemRow } from './types';
import type { ZhihuFeedService } from './ZhihuFeedService';

export interface ZhihuDigestServiceConfig {
  digestProvider?: string;
  digestHoursBack?: number;
  preferredProtocol?: string;
}

export class ZhihuDigestService {
  private digestProvider: string;
  private digestHoursBack: number;
  private preferredProtocol: string;

  constructor(
    private feedService: ZhihuFeedService,
    private llmService: LLMService,
    private messageAPI: MessageAPI,
    config?: ZhihuDigestServiceConfig,
  ) {
    this.digestProvider = config?.digestProvider ?? 'deepseek';
    this.digestHoursBack = config?.digestHoursBack ?? 12;
    this.preferredProtocol = config?.preferredProtocol ?? 'milky';
    logger.info('[ZhihuDigestService] Initialized');
  }

  // ──────────────────────────────────────────────────
  // Main digest flow
  // ──────────────────────────────────────────────────

  /** Generate and push a digest to a QQ group. */
  async generateAndPushDigest(groupId: string, hoursBack?: number): Promise<void> {
    const hours = hoursBack ?? this.digestHoursBack;
    const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;

    const items = this.feedService.getUndigestedSince(sinceTs);
    if (items.length === 0) {
      logger.info(`[ZhihuDigestService] No undigested items in the last ${hours}h, skipping`);
      return;
    }

    // Content is already fetched during poll — no need to enrich here

    // Generate digest text
    const digestText = await this.generateDigestText(items, hours);
    if (!digestText) {
      logger.warn('[ZhihuDigestService] Failed to generate digest text');
      return;
    }

    // Send to group
    await this.sendToGroup(groupId, digestText);

    // Mark items as digested
    const itemIds = items.map((i) => i.id);
    this.feedService.markDigested(itemIds);
    logger.info(`[ZhihuDigestService] Digest pushed to group ${groupId}, ${itemIds.length} items marked`);
  }

  /** Generate digest text without pushing (for preview). */
  async generateDigestPreview(hoursBack?: number): Promise<string> {
    const hours = hoursBack ?? this.digestHoursBack;
    const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
    const items = this.feedService.getItemsSince(sinceTs);

    if (items.length === 0) {
      return `过去 ${hours} 小时没有知乎动态。`;
    }

    return this.generateDigestText(items, hours);
  }

  // ──────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────

  private async generateDigestText(items: ZhihuFeedItemRow[], hoursBack: number): Promise<string> {
    const systemPrompt = `你是一个知乎动态摘要助手。根据提供的知乎关注动态列表，生成一份简洁的中文摘要。

要求：
1. 按内容类型分组：新回答/文章 > 高赞内容 > 其他动态
2. 每条内容一行：标题 + 作者 + 互动数据 + 一句话概括
3. 高赞（>100赞）的内容优先排列
4. 总结不超过 800 字
5. 不要虚构任何内容，仅基于提供的数据`;

    const itemLines = items.map((item) => {
      const verbLabel = this.getVerbLabel(item.verb);
      // Try to get richer content from content table
      const contentRow = this.feedService.getContent(item.targetType, item.targetId);
      const excerpt = contentRow?.content
        ? contentRow.content.slice(0, 400)
        : item.excerpt
          ? item.excerpt.slice(0, 200)
          : '';
      return `- [${verbLabel}] ${item.title} — ${item.authorName}\n  赞同: ${item.voteupCount} | 评论: ${item.commentCount}\n  摘要: ${excerpt}\n  链接: ${item.url}`;
    });

    const userPrompt = `以下是过去 ${hoursBack} 小时的知乎关注动态（共 ${items.length} 条）：

${itemLines.join('\n\n')}

请生成摘要。`;

    try {
      const response = await this.llmService.generateMessages(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.3, maxTokens: 1500 },
        this.digestProvider,
      );
      return response.text ?? '';
    } catch (err) {
      logger.error('[ZhihuDigestService] LLM digest generation failed:', err);
      // Fallback: return a simple text summary
      return this.generateSimpleDigest(items, hoursBack);
    }
  }

  private generateSimpleDigest(items: ZhihuFeedItemRow[], hoursBack: number): string {
    const lines = [`📰 知乎动态摘要（过去 ${hoursBack} 小时，共 ${items.length} 条）`, ''];

    // Group by verb
    const byVerb = new Map<string, ZhihuFeedItemRow[]>();
    for (const item of items) {
      const existing = byVerb.get(item.verb) ?? [];
      existing.push(item);
      byVerb.set(item.verb, existing);
    }

    for (const [verb, verbItems] of byVerb) {
      const label = this.getVerbLabel(verb);
      lines.push(`## ${label}（${verbItems.length} 条）`);
      // Sort by votes, take top 5
      const top = verbItems.sort((a, b) => b.voteupCount - a.voteupCount).slice(0, 5);
      for (const item of top) {
        lines.push(`- ${item.title} — ${item.authorName} (👍${item.voteupCount})`);
        lines.push(`  ${item.url}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async sendToGroup(groupId: string, digest: string): Promise<void> {
    const groupIdNum = Number(groupId);
    if (Number.isNaN(groupIdNum)) {
      logger.warn(`[ZhihuDigestService] Invalid group ID: ${groupId}`);
      return;
    }

    const context: NormalizedMessageEvent = {
      id: '',
      type: 'message',
      timestamp: Date.now(),
      protocol: this.preferredProtocol as NormalizedMessageEvent['protocol'],
      userId: 0,
      groupId: groupIdNum,
      messageType: 'group',
      message: '',
      segments: [],
    };

    try {
      await this.messageAPI.sendFromContext(digest, context, 15_000);
      logger.info(`[ZhihuDigestService] Digest sent to group ${groupId}`);
    } catch (err) {
      logger.error(`[ZhihuDigestService] Failed to send digest to group ${groupId}:`, err);
    }
  }

  private getVerbLabel(verb: string): string {
    switch (verb) {
      case 'ANSWER_CREATE':
        return '新回答';
      case 'ARTICLE_CREATE':
        return '新文章';
      case 'ANSWER_VOTE_UP':
      case 'MEMBER_VOTEUP_ANSWER':
        return '赞同回答';
      case 'MEMBER_VOTEUP_ARTICLE':
        return '赞同文章';
      case 'MEMBER_ANSWER_QUESTION':
        return '回答问题';
      case 'MEMBER_FOLLOW_QUESTION':
      case 'QUESTION_FOLLOW':
        return '关注问题';
      case 'ZVIDEO_CREATE':
        return '新视频';
      default:
        return verb;
    }
  }
}
