// WeChat Ingest Service — HTTP webhook server + message processing pipeline

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import type {
  MessageCategory,
  ParsedWeChatMessage,
  ResolvedWeChatIngestConfig,
  WeChatRealtimeRule,
  WeChatWebhookMessage,
} from './types';
import type { WeChatDatabase } from './WeChatDatabase';
import { WeChatMessageBuffer } from './WeChatMessageBuffer';

// ────────────────────────────────────────────────────────────────────────────
// Helpers: classification + parsing
// ────────────────────────────────────────────────────────────────────────────

function classifyMessage(msg: WeChatWebhookMessage): MessageCategory {
  switch (msg.MsgType) {
    case 1:
      return 'text';
    case 3:
      return 'image';
    case 49:
      return msg.Content.includes('mp.weixin.qq.com') ? 'article' : 'file';
    case 51:
    case 10000:
    case 10002:
      return 'system';
    default:
      return 'other';
  }
}

function parseGroupMessage(content: string, fromUser: string): { sender: string; text: string; isGroup: boolean } {
  const isGroup = fromUser.endsWith('@chatroom');
  if (isGroup) {
    const firstNewline = content.indexOf('\n');
    if (firstNewline > 0 && content[firstNewline - 1] === ':') {
      return {
        sender: content.substring(0, firstNewline - 1),
        text: content.substring(firstNewline + 1),
        isGroup: true,
      };
    }
    return { sender: fromUser, text: content, isGroup: true };
  }
  return { sender: fromUser, text: content, isGroup: false };
}

function conversationId(fromUser: string): string {
  return fromUser.endsWith('@chatroom') ? fromUser.replace('@chatroom', '') : fromUser;
}

function ragCollection(convId: string, isGroup: boolean): string {
  return isGroup ? `wechat_group_${convId}_history` : `wechat_private_${convId}_history`;
}

// ────────────────────────────────────────────────────────────────────────────
// XML helpers + official-account article parsing
// ────────────────────────────────────────────────────────────────────────────

/** Extract text from a CDATA or plain-text XML tag, e.g. <title><![CDATA[foo]]></title> */
function xmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([^\\]]*)\\]\\]>|([^<]*))</${tag}>`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

/** Extract an attribute value from an XML tag string; decodes &amp; entities. */
function xmlAttr(xml: string, attr: string): string {
  const re = new RegExp(`\\b${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? '').replace(/&amp;/g, '&');
}

export interface ImgInfo {
  /** Best available download URL (HD > regular > thumb) */
  url: string;
  md5: string;
  width: number;
  height: number;
  /** Estimated file size in bytes */
  fileSize: number;
}

/** Parse image metadata from a MsgType=3 rawContent XML. */
export function extractImgInfo(rawContent: string): ImgInfo | null {
  // Match <img ...attributes... /> or <img ...attributes... >
  const m = rawContent.match(/<img\s([^>]+?)(?:\/?>)/is);
  if (!m) return null;
  const attrs = m[0];

  // Prefer HD > regular > thumbnail URL
  const url =
    xmlAttr(attrs, 'tphdurl') ||
    xmlAttr(attrs, 'tpurl') ||
    xmlAttr(attrs, 'tpthumburl');
  if (!url) return null;

  const width =
    Number(xmlAttr(attrs, 'tphdwidth')) ||
    Number(xmlAttr(attrs, 'tpwidth')) ||
    Number(xmlAttr(attrs, 'cdnthumbwidth')) ||
    0;
  const height =
    Number(xmlAttr(attrs, 'tphdheight')) ||
    Number(xmlAttr(attrs, 'tpheight')) ||
    Number(xmlAttr(attrs, 'cdnthumbheight')) ||
    0;
  const fileSize =
    Number(xmlAttr(attrs, 'tphdlength')) ||
    Number(xmlAttr(attrs, 'tplength')) ||
    Number(xmlAttr(attrs, 'length')) ||
    0;

  return { url, md5: xmlAttr(attrs, 'md5'), width, height, fileSize };
}

export interface OfficialAccountItem {
  title: string;
  url: string;
  summary: string;
  cover: string;
  pubTime: number;
  source: string; // account name from <sources><source><name>
}

/**
 * Parse all <item> elements from a 公众号 push XML payload (<mmreader><category>).
 * Returns empty array if this is not a multi-article push.
 */
export function parseOfficialAccountItems(xml: string): OfficialAccountItem[] {
  const items: OfficialAccountItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const chunk = match[1] ?? '';
    const title = xmlTag(chunk, 'title');
    if (!title) continue; // skip empty placeholder items
    const url = xmlTag(chunk, 'url');
    const summary = xmlTag(chunk, 'summary');
    const cover = xmlTag(chunk, 'cover') || xmlTag(chunk, 'cover_235_1');
    const pubTime = Number(xmlTag(chunk, 'pub_time')) || 0;
    // <sources><source><name><![CDATA[accountName]]></name></source></sources>
    const srcMatch = chunk.match(/<sources>[\s\S]*?<name>(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*))<\/name>/i);
    const source = (srcMatch?.[1] ?? srcMatch?.[2] ?? '').trim();
    items.push({ title, url, summary, cover, pubTime, source });
  }
  return items;
}

// ────────────────────────────────────────────────────────────────────────────
// XML → structured JSON for the `content` column (chat messages only)
// ────────────────────────────────────────────────────────────────────────────

function parseContentAsJson(xml: string, category: MessageCategory, msgType: number): string {
  switch (category) {
    case 'article':
      // Shared article in group/private chat (not an OA push)
      return JSON.stringify({
        title: xmlTag(xml, 'title'),
        url: xmlTag(xml, 'url'),
        description: xmlTag(xml, 'des'),
        digest: xmlTag(xml, 'digest'),
        source: xmlTag(xml, 'sourcedisplayname') || xmlTag(xml, 'appname'),
      });
    case 'file': {
      // 视频号 (Finder/Channels): <finderFeed> section present
      const finderStart = xml.indexOf('<finderFeed>');
      if (finderStart >= 0) {
        const finderEnd = xml.indexOf('</finderFeed>');
        const finderXml = xml.substring(finderStart, finderEnd >= 0 ? finderEnd + 13 : xml.length);
        // Extract first <media> for thumbnail/cover/duration
        const mediaStart = finderXml.indexOf('<media>');
        const mediaEnd = finderXml.indexOf('</media>');
        const mediaXml = mediaStart >= 0 && mediaEnd > mediaStart
          ? finderXml.substring(mediaStart, mediaEnd + 8)
          : '';
        return JSON.stringify({
          type: 'finder_video',
          nickname: xmlTag(finderXml, 'nickname'),
          desc: xmlTag(finderXml, 'desc'),
          username: xmlTag(finderXml, 'username'),
          avatar: xmlTag(finderXml, 'avatar'),
          // videoUrl is a short-lived WeChat CDN URL — useful for tracing, not for playback
          videoUrl: xmlTag(mediaXml || finderXml, 'url'),
          coverUrl: xmlTag(mediaXml || finderXml, 'coverUrl'),
          duration: Number(xmlTag(mediaXml || finderXml, 'videoPlayDuration')) || 0,
        });
      }
      // Standard file attachment
      return JSON.stringify({
        title: xmlTag(xml, 'title'),
        description: xmlTag(xml, 'des'),
        fileName: xmlTag(xml, 'filename') || xmlTag(xml, 'title'),
        fileSize: xmlTag(xml, 'totallen'),
      });
    }
    case 'image':
      return JSON.stringify({ type: 'image' });
    default:
      return JSON.stringify({
        msgType,
        preview: xml
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .substring(0, 200),
      });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Article full-text fetch (best-effort, WeChat mobile UA)
// ────────────────────────────────────────────────────────────────────────────

const JS_CONTENT_RE = /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i;

async function fetchArticleText(url: string, title: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      logger.warn(`[WeChatIngestService] Article fetch HTTP ${resp.status} for ${url}`);
      return title;
    }
    const html = await resp.text();
    const bodyMatch = html.match(JS_CONTENT_RE);
    const rawText = bodyMatch?.[1] ?? '';
    const text = rawText
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length > 100) {
      logger.info(`[WeChatIngestService] Article fetched: "${title}" — ${text.length} chars`);
      return text;
    }
    // Likely a verification/login page — fall back to summary
    logger.warn(`[WeChatIngestService] Article fetch returned thin content (${text.length} chars), using summary`);
    return title;
  } catch (err) {
    logger.warn(`[WeChatIngestService] Article fetch error for ${url}:`, err);
    return title;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Notification callback
// ────────────────────────────────────────────────────────────────────────────

export type NotifyCallback = (text: string, rules: WeChatRealtimeRule[]) => Promise<void>;

// ────────────────────────────────────────────────────────────────────────────
// WeChatIngestService
// ────────────────────────────────────────────────────────────────────────────

export class WeChatIngestService {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private buffer: WeChatMessageBuffer;
  private readonly config: ResolvedWeChatIngestConfig;
  private readonly retrieval: RetrievalService;
  private readonly db: WeChatDatabase | null;
  private readonly notify: NotifyCallback | null;
  private totalReceived = 0;

  constructor(opts: {
    config: ResolvedWeChatIngestConfig;
    retrieval: RetrievalService;
    db?: WeChatDatabase;
    notify?: NotifyCallback;
  }) {
    this.config = opts.config;
    this.retrieval = opts.retrieval;
    this.db = opts.db ?? null;
    this.notify = opts.notify ?? null;

    this.buffer = new WeChatMessageBuffer({
      idleMinutes: this.config.rag.bufferIdleMinutes,
      maxMessages: this.config.rag.bufferMaxMessages,
      onFlush: this.upsertBatch.bind(this),
    });

    logger.info(
      `[WeChatIngestService] Created | RAG=${this.retrieval.isRAGEnabled()} | DB=${this.db != null} ` +
        `| bufferIdle=${this.config.rag.bufferIdleMinutes}min | bufferMax=${this.config.rag.bufferMaxMessages}msgs`,
    );
  }

  // ──────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────

  start(): void {
    const { listenPort, listenPath } = this.config;
    const self = this;

    this.server = Bun.serve({
      port: listenPort,
      hostname: '0.0.0.0',
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        logger.info(
          `[WeChatIngestService] HTTP ${req.method} ${url.pathname} from ${req.headers.get('x-forwarded-for') ?? 'unknown'}`,
        );
        if (req.method === 'POST' && url.pathname === listenPath) {
          return self.handleCallback(req);
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    logger.info(
      `[WeChatIngestService] Webhook server listening on 0.0.0.0:${listenPort}${listenPath} | RAG=${this.retrieval.isRAGEnabled()} | DB=${this.db != null}`,
    );
  }

  async stop(): Promise<void> {
    logger.info(`[WeChatIngestService] Stopping (total received: ${this.totalReceived})...`);
    await this.buffer.flushAll();
    this.buffer.destroy();
    this.server?.stop(true);
    this.server = null;
    logger.info('[WeChatIngestService] Stopped');
  }

  // ──────────────────────────────────────────────────
  // Webhook handler
  // ──────────────────────────────────────────────────

  private async handleCallback(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      logger.warn('[WeChatIngestService] Webhook: failed to parse JSON body');
      return new Response('Bad Request', { status: 400 });
    }

    const msg = body as WeChatWebhookMessage;

    if (!msg?.MsgType || !msg?.FromUserName) {
      logger.warn('[WeChatIngestService] Webhook: missing MsgType or FromUserName', body);
      return new Response('OK', { status: 200 });
    }

    const category = classifyMessage(msg);
    this.totalReceived++;

    if (category === 'system') {
      logger.info(
        `[WeChatIngestService] [#${this.totalReceived}] system/skip | MsgType=${msg.MsgType} from=${msg.FromUserName}`,
      );
      return new Response('OK', { status: 200 });
    }

    logger.info(
      `[WeChatIngestService] [#${this.totalReceived}] Received | MsgType=${msg.MsgType} category=${category} ` +
        `from=${msg.FromUserName} NewMsgId=${msg.NewMsgId}`,
    );

    this.processMessage(msg, category).catch((err) => logger.error('[WeChatIngestService] processMessage error:', err));

    return new Response('OK', { status: 200 });
  }

  // ──────────────────────────────────────────────────
  // Message routing
  // ──────────────────────────────────────────────────

  private async processMessage(msg: WeChatWebhookMessage, category: MessageCategory): Promise<void> {
    // Official account push: FromUserName is gh_xxx (not a chatroom, not a user wxid)
    const isOAPush = msg.FromUserName.startsWith('gh_');

    switch (category) {
      case 'text':
        await this.handleTextMessage(msg);
        break;
      case 'article':
        if (isOAPush) {
          await this.handleOAPushMessage(msg);
        } else {
          await this.handleChatArticleMessage(msg);
        }
        break;
      case 'image':
        if (!isOAPush) {
          await this.handleImageMessage(msg);
        }
        break;
      case 'file':
      case 'other':
        if (!isOAPush) {
          this.persistChatToDb(msg, category);
          logger.debug(`[WeChatIngestService] No RAG for MsgType=${msg.MsgType} (${category}) — saved to DB only`);
        }
        break;
    }
  }

  // ──────────────────────────────────────────────────
  // Image download handler
  // ──────────────────────────────────────────────────

  private async handleImageMessage(msg: WeChatWebhookMessage): Promise<void> {
    const { sender, isGroup } = parseGroupMessage(msg.Content, msg.FromUserName);
    const convId = conversationId(msg.FromUserName);
    const imgInfo = extractImgInfo(msg.Content);

    // Persist to DB immediately with known metadata (filePath null until download completes)
    const initialContent = JSON.stringify({
      type: 'image',
      md5: imgInfo?.md5 ?? '',
      width: imgInfo?.width ?? 0,
      height: imgInfo?.height ?? 0,
      fileSize: imgInfo?.fileSize ?? 0,
      filePath: null,
    });
    this.persistToDb(msg, 'image', sender, initialContent, isGroup, convId);

    if (!imgInfo?.url) {
      logger.warn(`[WeChatIngestService] Image: no download URL found | newMsgId=${msg.NewMsgId}`);
      return;
    }

    // Use md5 as filename for deduplication; fallback to newMsgId
    const filename = imgInfo.md5 ? `${imgInfo.md5}.jpg` : `${msg.NewMsgId}.jpg`;
    const savePath = resolve(`output/wechat/${convId}`);
    const filePath = `output/wechat/${convId}/${filename}`;

    // Skip download if already saved (same image forwarded multiple times)
    if (existsSync(resolve(filePath))) {
      logger.info(`[WeChatIngestService] Image already exists, skipping download: ${filePath}`);
      if (this.db) {
        this.db.updateContentByMsgId(String(msg.NewMsgId), JSON.stringify({
          type: 'image',
          md5: imgInfo.md5,
          width: imgInfo.width,
          height: imgInfo.height,
          fileSize: imgInfo.fileSize,
          filePath,
        }));
      }
      return;
    }

    logger.info(`[WeChatIngestService] Downloading image | newMsgId=${msg.NewMsgId} → ${filePath}`);
    try {
      await ResourceDownloader.downloadToBase64(imgInfo.url, {
        savePath,
        filename,
        timeout: 30_000,
        maxSize: 20 * 1024 * 1024,
      });

      logger.info(`[WeChatIngestService] Image saved: ${filePath}`);
      if (this.db) {
        this.db.updateContentByMsgId(String(msg.NewMsgId), JSON.stringify({
          type: 'image',
          md5: imgInfo.md5,
          width: imgInfo.width,
          height: imgInfo.height,
          fileSize: imgInfo.fileSize,
          filePath,
        }));
      }
    } catch (err) {
      logger.error(`[WeChatIngestService] Image download failed | newMsgId=${msg.NewMsgId}:`, err);
    }
  }

  // ──────────────────────────────────────────────────
  // Chat message handlers
  // ──────────────────────────────────────────────────

  private async handleTextMessage(msg: WeChatWebhookMessage): Promise<void> {
    const { sender, text, isGroup } = parseGroupMessage(msg.Content, msg.FromUserName);
    const convId = conversationId(msg.FromUserName);

    logger.info(
      `[WeChatIngestService] Text | conv=${convId} isGroup=${isGroup} sender=${sender} ` +
        `text="${text.substring(0, 60).replace(/\n/g, '↵')}"`,
    );

    this.persistToDb(msg, 'text', sender, JSON.stringify({ text }), isGroup, convId);

    const parsed: ParsedWeChatMessage = {
      id: String(msg.NewMsgId),
      conversationId: convId,
      isGroup,
      sender,
      text,
      timestamp: msg.CreateTime,
      msgType: msg.MsgType,
      category: 'text',
    };

    if (this.config.realtime.enabled && this.notify && this.config.realtime.rules.length > 0) {
      this.notify(text, this.config.realtime.rules).catch((err) =>
        logger.error('[WeChatIngestService] notify error:', err),
      );
    }

    if (this.retrieval.isRAGEnabled()) {
      this.buffer.push(parsed);
      logger.info(`[WeChatIngestService] Buffered text for RAG | conv=${convId}`);
    } else {
      logger.debug('[WeChatIngestService] RAG disabled — text saved to DB only');
    }
  }

  // ──────────────────────────────────────────────────
  // Article shared in group/private chat
  // ──────────────────────────────────────────────────

  private async handleChatArticleMessage(msg: WeChatWebhookMessage): Promise<void> {
    const { sender, isGroup } = parseGroupMessage(msg.Content, msg.FromUserName);
    const convId = conversationId(msg.FromUserName);
    const sourceType = isGroup ? 'group_chat' : 'private_chat';

    // Always persist raw to wechat_messages
    this.persistToDb(
      msg,
      'article',
      sender,
      parseContentAsJson(msg.Content, 'article', msg.MsgType),
      isGroup,
      convId,
    );

    // Extract article metadata from XML
    const title = xmlTag(msg.Content, 'title');
    const url = xmlTag(msg.Content, 'url');
    const summary = xmlTag(msg.Content, 'des') || xmlTag(msg.Content, 'digest');
    const cover = xmlTag(msg.Content, 'thumburl');
    const accountId = xmlTag(msg.Content, 'appid') || '';
    const accountNick = xmlTag(msg.Content, 'sourcedisplayname') || xmlTag(msg.Content, 'appname') || '';
    const source = accountNick;
    const receivedAt = new Date().toISOString();
    const msgId = String(msg.NewMsgId);

    logger.info(
      `[WeChatIngestService] Chat article | ${sourceType} conv=${convId} sender=${sender} title="${title}"`,
    );

    // Store metadata to wechat_oa_articles
    if (this.db && title) {
      this.db.insertOAArticle({
        msgId,
        accountId,
        accountNick,
        title,
        url,
        summary,
        cover,
        source,
        pubTime: msg.CreateTime,
        receivedAt,
        sourceType,
        fromConversationId: convId,
        fromSender: sender,
      });
    }

    // Fetch full text and upsert to RAG
    if (this.retrieval.isRAGEnabled() && title) {
      this.upsertChatArticleToRAG(msgId, { title, url, summary, cover, source, accountNick, accountId }, convId, sender, sourceType, msg.CreateTime).catch((err) =>
        logger.error(`[WeChatIngestService] Chat article RAG error for "${title}":`, err),
      );
    }
  }

  private async upsertChatArticleToRAG(
    msgId: string,
    article: { title: string; url: string; summary: string; cover: string; source: string; accountNick: string; accountId: string },
    fromConversationId: string,
    fromSender: string,
    sourceType: string,
    receivedTime: number,
  ): Promise<void> {
    const fullText = article.url ? await fetchArticleText(article.url, article.title) : article.title;
    const usedSummary = fullText === article.title;

    const docContent = [
      `标题: ${article.title}`,
      article.summary && !usedSummary ? `摘要: ${article.summary}` : '',
      `正文: ${usedSummary ? article.summary || article.title : fullText}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    logger.info(
      `[WeChatIngestService] RAG upsert chat article | collection=${this.config.rag.articleCollection} ` +
        `title="${article.title}" len=${docContent.length} usedSummary=${usedSummary}`,
    );

    await this.retrieval.upsertDocuments(this.config.rag.articleCollection, [
      {
        id: msgId,
        content: docContent,
        payload: {
          url: article.url,
          title: article.title,
          summary: article.summary,
          cover: article.cover,
          accountId: article.accountId,
          accountNick: article.accountNick,
          source: article.source,
          sourceType,
          fromConversationId,
          fromSender,
          receivedTime,
          platform: 'wechat',
          type: 'chat_article',
        },
      },
    ]);
    logger.info(`[WeChatIngestService] RAG upsert OK: "${article.title}" → ${this.config.rag.articleCollection}`);
  }

  // ──────────────────────────────────────────────────
  // Official account push handler
  // ──────────────────────────────────────────────────

  private async handleOAPushMessage(msg: WeChatWebhookMessage): Promise<void> {
    const items = parseOfficialAccountItems(msg.Content);
    if (items.length === 0) {
      logger.warn(`[WeChatIngestService] OA push from ${msg.FromUserName}: no items parsed`);
      return;
    }

    const accountId = msg.FromUserName;
    const accountNick = xmlTag(msg.Content, 'nickname') || xmlTag(msg.Content, 'appname') || accountId;
    const receivedAt = new Date().toISOString();

    logger.info(`[WeChatIngestService] OA push | account=${accountNick}(${accountId}) items=${items.length}`);

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!item) continue;
      const msgId = `${msg.NewMsgId}_${idx}`;

      // Store metadata to DB
      if (this.db) {
        this.db.insertOAArticle({
          msgId,
          accountId,
          accountNick,
          title: item.title,
          url: item.url,
          summary: item.summary,
          cover: item.cover,
          source: item.source || accountNick,
          pubTime: item.pubTime || msg.CreateTime,
          receivedAt,
          sourceType: 'oa_push',
          fromConversationId: '',
          fromSender: '',
        });
        logger.info(`[WeChatIngestService] OA article saved to DB | msgId=${msgId} title="${item.title}"`);
      }

      // Upsert to RAG (fetch full text + fall back to summary)
      if (this.retrieval.isRAGEnabled()) {
        this.upsertOAArticleToRAG(msgId, item, accountId, accountNick, msg.CreateTime).catch((err) =>
          logger.error(`[WeChatIngestService] RAG upsert error for "${item.title}":`, err),
        );
      }
    }
  }

  private async upsertOAArticleToRAG(
    msgId: string,
    item: OfficialAccountItem,
    accountId: string,
    accountNick: string,
    receivedTime: number,
  ): Promise<void> {
    // Try to fetch full article text; fall back to title + summary
    const fullText = item.url ? await fetchArticleText(item.url, item.title) : item.title;
    const usedSummary = fullText === item.title; // fetch failed or returned thin content

    const docContent = [
      `标题: ${item.title}`,
      item.summary && !usedSummary ? `摘要: ${item.summary}` : '',
      `正文: ${usedSummary ? item.summary || item.title : fullText}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    logger.info(
      `[WeChatIngestService] RAG upsert OA article | collection=${this.config.rag.articleCollection} ` +
        `title="${item.title}" len=${docContent.length} usedSummary=${usedSummary}`,
    );

    await this.retrieval.upsertDocuments(this.config.rag.articleCollection, [
      {
        id: msgId,
        content: docContent,
        payload: {
          url: item.url,
          title: item.title,
          summary: item.summary,
          cover: item.cover,
          accountId,
          accountNick,
          source: item.source || accountNick,
          pubTime: item.pubTime,
          receivedTime,
          platform: 'wechat',
          type: 'oa_article',
        },
      },
    ]);
    logger.info(`[WeChatIngestService] RAG upsert OK: "${item.title}" → ${this.config.rag.articleCollection}`);
  }

  // ──────────────────────────────────────────────────
  // RAG batch upsert for chat messages (called by buffer on flush)
  // ──────────────────────────────────────────────────

  private async upsertBatch(convId: string, messages: ParsedWeChatMessage[]): Promise<void> {
    if (messages.length === 0) return;

    if (!this.retrieval.isRAGEnabled()) {
      logger.warn(`[WeChatIngestService] upsertBatch called but RAG disabled — skipping ${messages.length} msgs`);
      return;
    }

    const first = messages[0];
    const last = messages[messages.length - 1];
    if (!first || !last) return;

    const isGroup = first.isGroup;
    const collection = ragCollection(convId, isGroup);
    const combined = messages
      .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] ${m.sender}: ${m.text}`)
      .join('\n');
    const windowId = `${convId}_${first.timestamp}_${last.timestamp}`;

    logger.info(
      `[WeChatIngestService] RAG upsert chat | conv=${convId} msgs=${messages.length} collection=${collection}`,
    );

    try {
      await this.retrieval.upsertDocuments(collection, [
        {
          id: windowId,
          content: combined,
          payload: {
            conversationId: convId,
            isGroup,
            messageCount: messages.length,
            startTime: first.timestamp,
            endTime: last.timestamp,
            platform: 'wechat',
            type: 'chat_window',
          },
        },
      ]);
      logger.info(`[WeChatIngestService] RAG upsert OK — ${messages.length} msgs → ${collection}`);
    } catch (err) {
      logger.error(`[WeChatIngestService] RAG upsert FAILED for conv=${convId}:`, err);
    }
  }

  // ──────────────────────────────────────────────────
  // SQLite persistence helpers (chat messages only)
  // ──────────────────────────────────────────────────

  private persistToDb(
    msg: WeChatWebhookMessage,
    category: MessageCategory,
    sender: string,
    content: string,
    isGroup: boolean,
    convId: string,
  ): void {
    if (!this.db) return;
    this.db.insert({
      newMsgId: String(msg.NewMsgId),
      conversationId: convId,
      isGroup: isGroup ? 1 : 0,
      sender,
      content,
      rawContent: msg.Content,
      msgType: msg.MsgType,
      category,
      createTime: msg.CreateTime,
      receivedAt: new Date().toISOString(),
    });
    logger.info(`[WeChatIngestService] DB insert OK | newMsgId=${msg.NewMsgId} conv=${convId} category=${category}`);
  }

  private persistChatToDb(msg: WeChatWebhookMessage, category: MessageCategory): void {
    if (!this.db) return;
    const convId = conversationId(msg.FromUserName);
    const isGroup = msg.FromUserName.endsWith('@chatroom');
    this.persistToDb(
      msg,
      category,
      msg.FromUserName,
      parseContentAsJson(msg.Content, category, msg.MsgType),
      isGroup,
      convId,
    );
  }
}
