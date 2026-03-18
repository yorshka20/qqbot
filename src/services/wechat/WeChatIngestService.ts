// WeChat Ingest Service — HTTP webhook server + message processing pipeline

// import all executors to ensure decorators are executed
import './executors';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import type { RetrievalService } from '@/services/retrieval';
import { chunkText } from '@/services/retrieval/rag/chunkText';
import { logger } from '@/utils/logger';
import type {
  MessageCategory,
  ParsedWeChatMessage,
  ResolvedWeChatIngestConfig,
  WeChatRealtimeRule,
  WeChatWebhookMessage,
} from './types';
import type { WeChatDatabase, WeChatMessageRow, WeChatOAArticleRow } from './WeChatDatabase';
import { WeChatMessageBuffer } from './WeChatMessageBuffer';
import type { WechatEventBridge } from './WechatEventBridge';

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
  /** Best available download URL (HD > regular > thumb), empty if none found */
  url: string;
  md5: string;
  width: number;
  height: number;
  /** Estimated file size in bytes */
  fileSize: number;
  /** AES key for CDN encrypted resources */
  aeskey: string;
}

/** Parse image metadata from a MsgType=3 rawContent XML. */
export function extractImgInfo(rawContent: string): ImgInfo | null {
  // Match <img ...attributes... /> or <img ...attributes... >
  const m = rawContent.match(/<img\s([^>]+?)(?:\/?>)/is);
  if (!m) {
    logger.debug('[extractImgInfo] No <img> tag found in content');
    return null;
  }
  const attrs = m[0];

  // Prefer HD > regular > thumbnail URL
  // Try tp* (thumbnail preview HTTP URLs) first, then cdn* (CDN keys, may or may not be HTTP)
  const url =
    xmlAttr(attrs, 'tphdurl') ||
    xmlAttr(attrs, 'tpurl') ||
    xmlAttr(attrs, 'tpthumburl') ||
    xmlAttr(attrs, 'cdnbigimgurl') ||
    xmlAttr(attrs, 'cdnmidimgurl') ||
    xmlAttr(attrs, 'cdnhdimgurl') ||
    xmlAttr(attrs, 'cdnthumburl');

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
    Number(xmlAttr(attrs, 'tphdlength')) || Number(xmlAttr(attrs, 'tplength')) || Number(xmlAttr(attrs, 'length')) || 0;

  return {
    url: url || '',
    md5: xmlAttr(attrs, 'md5'),
    width,
    height,
    fileSize,
    aeskey: xmlAttr(attrs, 'aeskey'),
  };
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
        const mediaXml = mediaStart >= 0 && mediaEnd > mediaStart ? finderXml.substring(mediaStart, mediaEnd + 8) : '';
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
    case 'image': {
      const info = extractImgInfo(xml);
      return JSON.stringify({
        type: 'image',
        md5: info?.md5 ?? '',
        width: info?.width ?? 0,
        height: info?.height ?? 0,
        fileSize: info?.fileSize ?? 0,
        aeskey: info?.aeskey ?? '',
        filePath: null,
      });
    }
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
      // Block-level tags → newline (preserve paragraph structure)
      .replace(/<\s*\/?\s*(?:p|div|br|section|article|h[1-6]|ul|ol|li|blockquote|pre|hr|tr|table)[\s>/]/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      // Collapse multiple blank lines into double-newline (preserve paragraph breaks)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
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

/** Callback to resolve a conversationId (chatroom ID) to a human-readable name */
export type GroupNameResolver = (conversationId: string) => Promise<string | null>;

/** Callback to download an image from WeChat CDN via PadPro API */
export type CdnImageDownloader = (aeskey: string, cdnUrl: string) => Promise<Buffer | null>;

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
  private readonly resolveGroupName: GroupNameResolver | null;
  private readonly downloadCdnImage: CdnImageDownloader | null;
  private readonly eventBridge: WechatEventBridge | null;
  /** Serial queue for RAG upsert tasks to avoid overwhelming Ollama */
  private ragQueue: (() => Promise<void>)[] = [];
  private ragQueueRunning = false;
  /** Cache: conversationId → sanitized folder name */
  private groupNameCache = new Map<string, string>();
  /** Dedup: recently seen NewMsgId values to prevent duplicate processing */
  private seenMsgIds = new Set<string>();
  private static readonly SEEN_MSG_MAX = 5000;
  private totalReceived = 0;

  constructor(opts: {
    config: ResolvedWeChatIngestConfig;
    retrieval: RetrievalService;
    db?: WeChatDatabase;
    notify?: NotifyCallback;
    resolveGroupName?: GroupNameResolver;
    downloadCdnImage?: CdnImageDownloader;
    eventBridge?: WechatEventBridge;
  }) {
    this.config = opts.config;
    this.retrieval = opts.retrieval;
    this.db = opts.db ?? null;
    this.notify = opts.notify ?? null;
    this.resolveGroupName = opts.resolveGroupName ?? null;
    this.downloadCdnImage = opts.downloadCdnImage ?? null;
    this.eventBridge = opts.eventBridge ?? null;

    this.buffer = new WeChatMessageBuffer({
      idleMinutes: this.config.rag.bufferIdleMinutes,
      maxMessages: this.config.rag.bufferMaxMessages,
      onFlush: async (convId, msgs) => {
        this.enqueueRAG(`batch:${convId}`, () => this.upsertBatch(convId, msgs));
      },
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
        // Skip logging for HEAD/GET health-checks to avoid log pollution
        if (req.method === 'POST') {
          logger.info(
            `[WeChatIngestService] HTTP ${req.method} ${url.pathname} from ${req.headers.get('x-forwarded-for') ?? 'unknown'}`,
          );
        }
        if (url.pathname === listenPath) {
          if (req.method === 'POST') {
            return self.handleCallback(req);
          }
          // HEAD / GET health-check from wechatpadpro — acknowledge without processing
          return new Response('OK', { status: 200 });
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
  // Group name → folder name resolution
  // ──────────────────────────────────────────────────

  /** Resolve a conversationId to a sanitised folder name (group name or wxid). */
  private async getFolderName(convId: string, isGroup: boolean): Promise<string> {
    // Check cache first
    const cached = this.groupNameCache.get(convId);
    if (cached) return cached;

    let folderName = convId; // fallback

    if (isGroup && this.resolveGroupName) {
      try {
        const name = await this.resolveGroupName(convId);
        if (name) {
          // Sanitise for filesystem: replace path-unsafe chars
          folderName = name.replace(/[/\\:*?"<>|]/g, '_').trim() || convId;
        }
      } catch (err) {
        logger.warn(`[WeChatIngestService] Failed to resolve group name for ${convId}:`, err);
      }
    }

    this.groupNameCache.set(convId, folderName);
    return folderName;
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

    // Deduplicate by NewMsgId — WeChat webhooks may deliver the same message multiple times
    const msgIdStr = String(msg.NewMsgId);
    if (msgIdStr && this.seenMsgIds.has(msgIdStr)) {
      logger.debug(`[WeChatIngestService] Duplicate message skipped | NewMsgId=${msgIdStr}`);
      return new Response('OK', { status: 200 });
    }
    if (msgIdStr) {
      this.seenMsgIds.add(msgIdStr);
      // Prevent unbounded growth: prune oldest entries when limit reached
      if (this.seenMsgIds.size > WeChatIngestService.SEEN_MSG_MAX) {
        const iter = this.seenMsgIds.values();
        // Delete the oldest ~20% to avoid pruning on every message
        const pruneCount = Math.floor(WeChatIngestService.SEEN_MSG_MAX * 0.2);
        for (let i = 0; i < pruneCount; i++) {
          const oldest = iter.next().value;
          if (oldest) this.seenMsgIds.delete(oldest);
        }
      }
    }

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

    // Pre-warm group name cache in background (non-blocking) for group messages
    const isGroup = msg.FromUserName.endsWith('@chatroom');
    if (isGroup && this.resolveGroupName) {
      const convId = msg.FromUserName.replace('@chatroom', '');
      if (!this.groupNameCache.has(convId)) {
        this.resolveGroupName(convId)
          .then((name) => {
            if (name && !this.groupNameCache.has(convId)) {
              this.groupNameCache.set(convId, name.replace(/[/\\:*?"<>|]/g, '_').trim() || convId);
            }
          })
          .catch(() => {}); // errors logged inside resolveGroupName
      }
    }

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

    const buildContent = (filePath: string | null) =>
      JSON.stringify({
        type: 'image',
        md5: imgInfo?.md5 ?? '',
        width: imgInfo?.width ?? 0,
        height: imgInfo?.height ?? 0,
        fileSize: imgInfo?.fileSize ?? 0,
        aeskey: imgInfo?.aeskey ?? '',
        filePath,
      });

    // Persist to DB immediately with full metadata
    this.persistToDb(msg, 'image', sender, buildContent(null), isGroup, convId);

    if (!imgInfo) {
      logger.warn(`[WeChatIngestService] Image: no <img> tag found | newMsgId=${msg.NewMsgId}`);
      return;
    }

    // Use md5 as filename for deduplication; fallback to newMsgId
    const filename = imgInfo.md5 ? `${imgInfo.md5}.jpg` : `${msg.NewMsgId}.jpg`;
    const folderName = await this.getFolderName(convId, isGroup);
    const savePath = resolve(`output/wechat/${folderName}`);
    const filePath = `output/wechat/${folderName}/${filename}`;

    // Skip download if already saved (same image forwarded multiple times)
    if (existsSync(resolve(filePath))) {
      logger.info(`[WeChatIngestService] Image already exists, skipping download: ${filePath}`);
      if (this.db) {
        this.db.updateContentByMsgId(String(msg.NewMsgId), buildContent(filePath));
      }
      return;
    }

    logger.info(`[WeChatIngestService] Downloading image | newMsgId=${msg.NewMsgId} → ${filePath}`);
    const saved = await this.downloadAndSaveImage(imgInfo, savePath, filename);

    if (saved) {
      logger.info(`[WeChatIngestService] Image saved: ${filePath}`);
      if (this.db) {
        this.db.updateContentByMsgId(String(msg.NewMsgId), buildContent(filePath));
      }
    } else {
      logger.warn(`[WeChatIngestService] Image download failed | newMsgId=${msg.NewMsgId}`);
    }
  }

  /**
   * Download image: try PadPro CDN download first (using aeskey + cdnUrl),
   * then fall back to direct HTTP download if a tp* URL is available.
   */
  private async downloadAndSaveImage(imgInfo: ImgInfo, savePath: string, filename: string): Promise<boolean> {
    // Strategy 1: PadPro CDN download (works for all WeChat images with aeskey)
    if (this.downloadCdnImage && imgInfo.aeskey && imgInfo.url) {
      try {
        const buf = await this.downloadCdnImage(imgInfo.aeskey, imgInfo.url);
        if (buf && buf.length > 100) {
          if (!existsSync(savePath)) {
            const { mkdirSync } = await import('node:fs');
            mkdirSync(savePath, { recursive: true });
          }
          const { writeFileSync } = await import('node:fs');
          writeFileSync(resolve(savePath, filename), buf);
          return true;
        }
      } catch (err) {
        logger.warn(`[WeChatIngestService] CDN download failed, trying HTTP fallback:`, err);
      }
    }

    // Strategy 2: Direct HTTP download (for tp* URLs)
    const httpUrl = imgInfo.url.startsWith('http://') || imgInfo.url.startsWith('https://') ? imgInfo.url : null;
    if (httpUrl) {
      try {
        await ResourceDownloader.downloadToBase64(httpUrl, {
          savePath,
          filename,
          timeout: 30_000,
          maxSize: 20 * 1024 * 1024,
        });
        return true;
      } catch (err) {
        logger.error(`[WeChatIngestService] HTTP download failed:`, err);
      }
    }

    return false;
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
    this.persistToDb(msg, 'article', sender, parseContentAsJson(msg.Content, 'article', msg.MsgType), isGroup, convId);

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

    logger.info(`[WeChatIngestService] Chat article | ${sourceType} conv=${convId} sender=${sender} title="${title}"`);

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
      this.enqueueRAG(title, () =>
        this.upsertChatArticleToRAG(
          msgId,
          { title, url, summary, cover, source, accountNick, accountId },
          convId,
          sender,
          sourceType,
          msg.CreateTime,
        ),
      );
    }
  }

  private async upsertChatArticleToRAG(
    msgId: string,
    article: {
      title: string;
      url: string;
      summary: string;
      cover: string;
      source: string;
      accountNick: string;
      accountId: string;
    },
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

    const articlePayload = {
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
    };

    logger.info(
      `[WeChatIngestService] RAG upsert chat article | collection=${this.config.rag.chunksCollection} ` +
        `title="${article.title}" len=${docContent.length} usedSummary=${usedSummary}`,
    );

    // Upsert chunks to chunksCollection (full text already in SQLite via persistToDb)
    await this.upsertArticleChunks(msgId, docContent, articlePayload);

    logger.info(`[WeChatIngestService] RAG upsert OK: "${article.title}" → ${this.config.rag.chunksCollection}`);
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

    // Check ignore list
    if (this.config.ignoredOAAccounts.has(accountNick)) {
      logger.info(`[WeChatIngestService] OA push IGNORED (blacklisted) | account=${accountNick}(${accountId})`);
      return;
    }

    logger.info(`[WeChatIngestService] OA push | account=${accountNick}(${accountId}) items=${items.length}`);

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!item) continue;
      const msgId = `${msg.NewMsgId}_${idx}`;

      // Store metadata to DB
      const articleRow: Omit<WeChatOAArticleRow, 'id'> = {
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
      };

      if (this.db) {
        this.db.insertOAArticle(articleRow);
        logger.info(`[WeChatIngestService] OA article saved to DB | msgId=${msgId} title="${item.title}"`);
      }

      // Publish event to InternalEventBus
      if (this.eventBridge) {
        this.eventBridge.publishOAArticle(articleRow as WeChatOAArticleRow);
      }

      // Upsert to RAG (fetch full text + fall back to summary)
      if (this.retrieval.isRAGEnabled()) {
        this.enqueueRAG(item.title, () =>
          this.upsertOAArticleToRAG(msgId, item, accountId, accountNick, msg.CreateTime),
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

    const articlePayload = {
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
    };

    logger.info(
      `[WeChatIngestService] RAG upsert OA article | collection=${this.config.rag.chunksCollection} ` +
        `title="${item.title}" len=${docContent.length} usedSummary=${usedSummary}`,
    );

    // Upsert chunks to chunksCollection (full text already in SQLite via persistToDb)
    await this.upsertArticleChunks(msgId, docContent, articlePayload);

    logger.info(`[WeChatIngestService] RAG upsert OK: "${item.title}" → ${this.config.rag.chunksCollection}`);
  }

  // ──────────────────────────────────────────────────
  // Shared: chunk an article and upsert to chunksCollection
  // ──────────────────────────────────────────────────

  private async upsertArticleChunks(
    articleId: string,
    docContent: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const chunks = chunkText(docContent);

    // Even single-chunk (short) articles go into chunksCollection —
    // this is now the only Qdrant collection for article search.
    const chunkDocs = chunks.map((chunk) => ({
      id: chunks.length === 1 ? articleId : `${articleId}_chunk_${chunk.index}`,
      content: chunk.text,
      payload: {
        ...payload,
        articleId,
        chunkIndex: chunk.index,
        totalChunks: chunks.length,
      },
    }));

    await this.retrieval.upsertDocuments(this.config.rag.chunksCollection, chunkDocs);
    logger.info(
      `[WeChatIngestService] Article "${payload.title}" → ${chunks.length} chunk(s) → ${this.config.rag.chunksCollection}`,
    );
  }

  // ──────────────────────────────────────────────────
  // RAG serial queue — one upsert at a time
  // ──────────────────────────────────────────────────

  private enqueueRAG(label: string, task: () => Promise<void>): void {
    this.ragQueue.push(async () => {
      try {
        await task();
      } catch (err) {
        logger.error(`[WeChatIngestService] RAG queue task error for "${label}":`, err);
      }
    });
    this.drainRAGQueue();
  }

  private async drainRAGQueue(): Promise<void> {
    if (this.ragQueueRunning) return;
    this.ragQueueRunning = true;
    while (this.ragQueue.length > 0) {
      const task = this.ragQueue.shift();
      if (task) await task();
    }
    this.ragQueueRunning = false;
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
    const row: Omit<WeChatMessageRow, 'id' | 'processed'> = {
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
    };

    if (this.db) {
      this.db.insert(row);
      logger.info(`[WeChatIngestService] DB insert OK | newMsgId=${msg.NewMsgId} conv=${convId} category=${category}`);
    }

    // Publish event to InternalEventBus
    if (this.eventBridge) {
      const fullRow: WeChatMessageRow = { ...row, processed: 0 };
      switch (category) {
        case 'text':
          this.eventBridge.publishTextMessage(fullRow);
          break;
        case 'article':
          this.eventBridge.publishArticleMessage(fullRow);
          break;
        case 'image':
          this.eventBridge.publishImageMessage(fullRow);
          break;
        case 'file':
          this.eventBridge.publishFileMessage(fullRow);
          break;
        default:
          // For 'other' category, still publish a generic message event
          this.eventBridge.publishTextMessage(fullRow);
      }
    }
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
