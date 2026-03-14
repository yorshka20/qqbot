// WeChat Ingest Service — HTTP webhook server + message processing pipeline

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
    // Fallback: no colon-newline format but still a group message
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
// Article content extraction
// ────────────────────────────────────────────────────────────────────────────

const ARTICLE_URL_RE = /https?:\/\/mp\.weixin\.qq\.com\/s\/[^\s"<>]+/;
const JS_CONTENT_RE = /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>/i;

async function extractArticle(content: string): Promise<{ url: string; title: string; text: string } | null> {
  const urlMatch = content.match(ARTICLE_URL_RE);
  if (!urlMatch) return null;
  const url = urlMatch[0];

  const titleMatch =
    content.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/i) ?? content.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? '';

  logger.info(`[WeChatIngestService] Fetching article: "${title}" ${url}`);
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
      return { url, title, text: title };
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

    logger.info(`[WeChatIngestService] Article extracted: "${title}" — ${text.length} chars`);
    return { url, title, text: text || title };
  } catch (err) {
    logger.warn(`[WeChatIngestService] Article fetch error for ${url}:`, err);
    return { url, title, text: title };
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
        // Log every incoming request so we can verify delivery
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
  // Message processing
  // ──────────────────────────────────────────────────

  private async processMessage(msg: WeChatWebhookMessage, category: MessageCategory): Promise<void> {
    switch (category) {
      case 'text':
        await this.handleTextMessage(msg);
        break;
      case 'article':
        await this.handleArticleMessage(msg);
        break;
      case 'image':
      case 'file':
      case 'other':
        this.persistRawToDb(msg, category);
        logger.debug(`[WeChatIngestService] No RAG for MsgType=${msg.MsgType} (${category}) — saved to DB only`);
        break;
    }
  }

  private async handleTextMessage(msg: WeChatWebhookMessage): Promise<void> {
    const { sender, text, isGroup } = parseGroupMessage(msg.Content, msg.FromUserName);
    const convId = conversationId(msg.FromUserName);

    logger.info(
      `[WeChatIngestService] Text | conv=${convId} isGroup=${isGroup} sender=${sender} ` +
        `text="${text.substring(0, 60).replace(/\n/g, '↵')}"`,
    );

    // Persist to SQLite immediately (regardless of RAG state)
    this.persistToDb(msg, 'text', sender, text, isGroup, convId);

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

    // Real-time notification check
    if (this.config.realtime.enabled && this.notify && this.config.realtime.rules.length > 0) {
      this.notify(text, this.config.realtime.rules).catch((err) =>
        logger.error('[WeChatIngestService] notify error:', err),
      );
    }

    // RAG buffer
    if (this.retrieval.isRAGEnabled()) {
      this.buffer.push(parsed);
      logger.info(`[WeChatIngestService] Buffered text for RAG | conv=${convId}`);
    } else {
      logger.debug('[WeChatIngestService] RAG disabled — text saved to DB only');
    }
  }

  private async handleArticleMessage(msg: WeChatWebhookMessage): Promise<void> {
    // Always persist raw to DB
    this.persistRawToDb(msg, 'article');

    if (!this.retrieval.isRAGEnabled()) {
      logger.info('[WeChatIngestService] Article received but RAG disabled — saved to DB only');
      return;
    }

    const article = await extractArticle(msg.Content);
    if (!article) {
      logger.warn(`[WeChatIngestService] Article: no URL found in Content from ${msg.FromUserName}`);
      return;
    }

    const docContent = article.title ? `标题: ${article.title}\n\n${article.text}` : article.text;
    if (!docContent.trim()) {
      logger.warn(`[WeChatIngestService] Article: empty content after extraction for ${article.url}`);
      return;
    }

    logger.info(
      `[WeChatIngestService] Upserting article to RAG | collection=${this.config.rag.articleCollection} ` +
        `title="${article.title}" len=${docContent.length}`,
    );

    try {
      await this.retrieval.upsertDocuments(this.config.rag.articleCollection, [
        {
          id: String(msg.NewMsgId),
          content: docContent,
          payload: {
            url: article.url,
            title: article.title,
            source: msg.FromUserName,
            timestamp: msg.CreateTime,
            platform: 'wechat',
            type: 'article',
          },
        },
      ]);
      logger.info(
        `[WeChatIngestService] Article upserted OK: "${article.title}" → ${this.config.rag.articleCollection}`,
      );
    } catch (err) {
      logger.error('[WeChatIngestService] Article RAG upsert failed:', err);
    }
  }

  // ──────────────────────────────────────────────────
  // RAG batch upsert (called by buffer on flush)
  // ──────────────────────────────────────────────────

  private async upsertBatch(convId: string, messages: ParsedWeChatMessage[]): Promise<void> {
    if (messages.length === 0) return;

    if (!this.retrieval.isRAGEnabled()) {
      logger.warn(`[WeChatIngestService] upsertBatch called but RAG disabled — skipping ${messages.length} msgs`);
      return;
    }

    const isGroup = messages[0]!.isGroup;
    const collection = ragCollection(convId, isGroup);
    const combined = messages
      .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] ${m.sender}: ${m.text}`)
      .join('\n');
    const windowId = `${convId}_${messages[0]!.timestamp}_${messages[messages.length - 1]!.timestamp}`;

    logger.info(
      `[WeChatIngestService] RAG upsert | conv=${convId} msgs=${messages.length} collection=${collection} windowId=${windowId}`,
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
            startTime: messages[0]!.timestamp,
            endTime: messages[messages.length - 1]!.timestamp,
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
  // SQLite persistence helpers
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
    logger.info(`[WeChatIngestService] DB insert OK | newMsgId=${msg.NewMsgId} conv=${convId}`);
  }

  private persistRawToDb(msg: WeChatWebhookMessage, category: MessageCategory): void {
    if (!this.db) return;
    const convId = conversationId(msg.FromUserName);
    const isGroup = msg.FromUserName.endsWith('@chatroom');
    this.db.insert({
      newMsgId: String(msg.NewMsgId),
      conversationId: convId,
      isGroup: isGroup ? 1 : 0,
      sender: msg.FromUserName,
      content: msg.Content.substring(0, 500), // truncate XML content
      rawContent: msg.Content,
      msgType: msg.MsgType,
      category,
      createTime: msg.CreateTime,
      receivedAt: new Date().toISOString(),
    });
  }
}
