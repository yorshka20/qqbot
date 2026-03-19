// WechatEventBridge - publishes WeChat messages as internal system events
// Allows Agenda onEvent rules to subscribe to WeChat message types

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { AgendaSystemEvent } from '@/agenda/types';
import { logger } from '@/utils/logger';
import type { WeChatMessageRow, WeChatOAArticleRow } from '../WeChatDatabase';

/**
 * WeChat event types published to InternalEventBus
 */
export type WechatEventType =
  | 'wechat:message' // Generic message event (all types)
  | 'wechat:text' // Text message
  | 'wechat:link_shared' // Article/link shared
  | 'wechat:image' // Image message
  | 'wechat:file' // File message
  | 'wechat:oa_article'; // Official account article push

/**
 * Normalized WeChat message data for events
 */
export interface WechatMessageEventData {
  id: string;
  conversationId: string;
  isGroup: boolean;
  sender: string;
  msgType: string; // 'text' | 'image' | 'article' | 'file' | 'other'
  content?: string; // Text content or JSON string
  title?: string; // For links/articles
  url?: string; // For links/articles
  summary?: string; // For links/articles
  receivedAt: string;
}

/**
 * WechatEventBridge
 *
 * Publishes WeChat messages as internal system events, enabling Agenda
 * onEvent rules to react to WeChat content (e.g., link sharing, keywords).
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 微信链接转发
 * - 触发: `onEvent wechat:link_shared`
 * - 群: `123456789`
 * ```
 */
export class WechatEventBridge {
  constructor(private eventBus: InternalEventBus) {
    logger.info('[WechatEventBridge] Initialized');
  }

  /**
   * Publish a text message event
   */
  publishTextMessage(row: WeChatMessageRow): void {
    const eventData = this.toEventData(row, 'text');

    // Parse text content from JSON
    try {
      const parsed = JSON.parse(row.content);
      eventData.content = parsed.text || row.content;
    } catch {
      eventData.content = row.content;
    }

    this.publish('wechat:text', eventData);
    this.publish('wechat:message', eventData);
  }

  /**
   * Publish an article/link shared event
   */
  publishArticleMessage(row: WeChatMessageRow): void {
    const eventData = this.toEventData(row, 'article');

    // Parse article metadata from JSON
    try {
      const parsed = JSON.parse(row.content);
      eventData.title = parsed.title;
      eventData.url = parsed.url;
      eventData.summary = parsed.description || parsed.digest;
      eventData.content = parsed.title || '';
    } catch {
      eventData.content = row.content;
    }

    this.publish('wechat:link_shared', eventData);
    this.publish('wechat:message', eventData);
  }

  /**
   * Publish an image message event
   */
  publishImageMessage(row: WeChatMessageRow): void {
    const eventData = this.toEventData(row, 'image');

    // Parse image metadata from JSON
    try {
      const parsed = JSON.parse(row.content);
      eventData.content = parsed.filePath || '[图片]';
    } catch {
      eventData.content = '[图片]';
    }

    this.publish('wechat:image', eventData);
    this.publish('wechat:message', eventData);
  }

  /**
   * Publish a file message event
   */
  publishFileMessage(row: WeChatMessageRow): void {
    const eventData = this.toEventData(row, 'file');

    // Parse file metadata from JSON
    try {
      const parsed = JSON.parse(row.content);
      eventData.title = parsed.title || parsed.fileName;
      eventData.content = parsed.title || parsed.fileName || '[文件]';
    } catch {
      eventData.content = '[文件]';
    }

    this.publish('wechat:file', eventData);
    this.publish('wechat:message', eventData);
  }

  /**
   * Publish an official account article event
   */
  publishOAArticle(article: WeChatOAArticleRow): void {
    const eventData: WechatMessageEventData = {
      id: article.msgId,
      conversationId: article.accountId,
      isGroup: false,
      sender: article.accountNick || article.source,
      msgType: 'oa_article',
      title: article.title,
      url: article.url,
      summary: article.summary,
      content: article.title,
      receivedAt: article.receivedAt,
    };

    this.publish('wechat:oa_article', eventData);
    this.publish('wechat:message', eventData);
  }

  /**
   * Convert a WeChatMessageRow to event data
   */
  private toEventData(row: WeChatMessageRow, msgType: string): WechatMessageEventData {
    return {
      id: row.newMsgId,
      conversationId: row.conversationId,
      isGroup: row.isGroup === 1,
      sender: row.sender,
      msgType,
      receivedAt: row.receivedAt,
    };
  }

  /**
   * Publish an event to InternalEventBus
   */
  private publish(type: WechatEventType, data: WechatMessageEventData): void {
    const event: AgendaSystemEvent = {
      type,
      // WeChat events don't have QQ groupId/userId
      groupId: '',
      userId: '',
      botSelfId: '',
      data: data as unknown as Record<string, unknown>,
    };

    logger.debug(`[WechatEventBridge] Publishing ${type} | conv=${data.conversationId} sender=${data.sender}`);
    this.eventBus.publish(event);
  }
}
