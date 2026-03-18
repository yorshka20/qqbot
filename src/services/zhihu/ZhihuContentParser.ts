// ZhihuContentParser — parses heterogeneous feed items into unified ZhihuContentItem

import { logger } from '@/utils/logger';
import type { ZhihuContentItem, ZhihuFeedItem } from './types';

export interface ZhihuContentParserConfig {
  verbFilter?: string[];
}

export class ZhihuContentParser {
  private verbFilter: Set<string> | null;

  constructor(config?: ZhihuContentParserConfig) {
    this.verbFilter = config?.verbFilter ? new Set(config.verbFilter) : null;
  }

  /** Parse a feed item (may be single or grouped) into content items. */
  parse(feedItem: ZhihuFeedItem): ZhihuContentItem[] {
    try {
      // Grouped feed (e.g. "3人赞同了该回答")
      if (feedItem.list && feedItem.list.length > 0) {
        return this.parseGroupFeed(feedItem);
      }
      // Single feed
      const item = this.parseSingleFeed(feedItem);
      if (!item) return [];
      return [item];
    } catch (err) {
      logger.warn(`[ZhihuContentParser] Failed to parse feed item ${feedItem.id}:`, err);
      return [];
    }
  }

  /** Parse multiple feed items. */
  parseAll(feedItems: ZhihuFeedItem[]): ZhihuContentItem[] {
    const results: ZhihuContentItem[] = [];
    for (const item of feedItems) {
      results.push(...this.parse(item));
    }
    return results;
  }

  // ──────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────

  private parseSingleFeed(item: ZhihuFeedItem): ZhihuContentItem | null {
    if (!item.target) return null;

    const verb = item.verb;
    if (this.verbFilter && !this.verbFilter.has(verb)) return null;

    const target = item.target;
    const targetType = target.type ?? 'unknown';
    const targetId = target.id ?? 0;

    return {
      id: `${verb}:${targetType}:${targetId}`,
      feedId: item.id,
      verb,
      targetType,
      targetId,
      title: this.extractTitle(target),
      excerpt: this.stripHtml(target.excerpt ?? target.content ?? '').slice(0, 500),
      url: this.extractUrl(target),
      authorName: target.author?.name ?? '',
      authorUrlToken: target.author?.url_token ?? '',
      authorAvatarUrl: target.author?.avatar_url,
      voteupCount: target.voteup_count ?? 0,
      commentCount: target.comment_count ?? 0,
      actorNames: item.actors?.map((a) => a.name) ?? [],
      createdTime: item.created_time,
      fetchedAt: new Date().toISOString(),
    };
  }

  private parseGroupFeed(item: ZhihuFeedItem): ZhihuContentItem[] {
    const results: ZhihuContentItem[] = [];
    if (!item.list) return results;

    for (const subItem of item.list) {
      const parsed = this.parseSingleFeed(subItem);
      if (parsed) {
        // Inherit actor names from parent group
        if (item.actors?.length) {
          parsed.actorNames = item.actors.map((a) => a.name);
        }
        results.push(parsed);
      }
    }
    return results;
  }

  private extractTitle(target: ZhihuFeedItem['target']): string {
    // Article / zvideo: title is on target directly
    if (target.title) return target.title;
    // Answer: title is on question
    if (target.question?.title) return target.question.title;
    return '(无标题)';
  }

  private extractUrl(target: ZhihuFeedItem['target']): string {
    const type = target.type;
    const id = target.id;

    switch (type) {
      case 'answer':
        if (target.question) {
          return `https://www.zhihu.com/question/${target.question.id}/answer/${id}`;
        }
        return `https://www.zhihu.com/answer/${id}`;
      case 'article':
        return `https://zhuanlan.zhihu.com/p/${id}`;
      case 'question':
        return `https://www.zhihu.com/question/${id}`;
      case 'zvideo':
        return `https://www.zhihu.com/zvideo/${id}`;
      default:
        return `https://www.zhihu.com`;
    }
  }

  /** Strip HTML tags and decode common entities. */
  private stripHtml(html: unknown): string {
    if (!html || typeof html !== 'string') return '';
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
