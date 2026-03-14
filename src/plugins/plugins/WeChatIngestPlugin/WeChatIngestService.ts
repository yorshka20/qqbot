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
  }
  return { sender: fromUser, text: content, isGroup: false };
}

/** Extract the group ID (chatroom ID without @chatroom) or private wxid */
function conversationId(fromUser: string): string {
  if (fromUser.endsWith('@chatroom')) {
    return fromUser.replace('@chatroom', '');
  }
  return fromUser;
}

/** RAG collection name per conversation */
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

  // Extract title from XML <title> tag in Content
  const titleMatch =
    content.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/i) ?? content.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? '';

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { url, title, text: title };

    const html = await resp.text();
    const bodyMatch = html.match(JS_CONTENT_RE);
    const rawText = bodyMatch?.[1] ?? '';
    // Strip HTML tags and collapse whitespace
    const text = rawText
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return { url, title, text: text || title };
  } catch (err) {
    logger.warn(`[WeChatIngestService] Failed to fetch article ${url}:`, err);
    return { url, title, text: title };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Notification callback type (injected from plugin to avoid circular deps)
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
  private readonly notify: NotifyCallback | null;

  constructor(opts: {
    config: ResolvedWeChatIngestConfig;
    retrieval: RetrievalService;
    notify?: NotifyCallback;
  }) {
    this.config = opts.config;
    this.retrieval = opts.retrieval;
    this.notify = opts.notify ?? null;

    this.buffer = new WeChatMessageBuffer({
      idleMinutes: this.config.rag.bufferIdleMinutes,
      maxMessages: this.config.rag.bufferMaxMessages,
      onFlush: this.upsertBatch.bind(this),
    });
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
        if (req.method === 'POST' && url.pathname === listenPath) {
          return self.handleCallback(req);
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    logger.info(`[WeChatIngestService] Listening on 0.0.0.0:${listenPort}${listenPath}`);
  }

  async stop(): Promise<void> {
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
      return new Response('Bad Request', { status: 400 });
    }

    const msg = body as WeChatWebhookMessage;
    if (!msg?.MsgType || !msg?.FromUserName) {
      return new Response('OK', { status: 200 });
    }

    const category = classifyMessage(msg);

    // Always skip system/sync messages early
    if (category === 'system') {
      return new Response('OK', { status: 200 });
    }

    // Process asynchronously — never block the webhook response
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
        // Raw store: just log, no RAG for now
        logger.debug(`[WeChatIngestService] Skipping MsgType=${msg.MsgType} (${category}) from ${msg.FromUserName}`);
        break;
    }
  }

  private async handleTextMessage(msg: WeChatWebhookMessage): Promise<void> {
    const { sender, text, isGroup } = parseGroupMessage(msg.Content, msg.FromUserName);
    const convId = conversationId(msg.FromUserName);

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

    // Real-time notification check (before buffering)
    if (this.config.realtime.enabled && this.notify && this.config.realtime.rules.length > 0) {
      this.notify(text, this.config.realtime.rules).catch((err) =>
        logger.error('[WeChatIngestService] notify error:', err),
      );
    }

    this.buffer.push(parsed);
  }

  private async handleArticleMessage(msg: WeChatWebhookMessage): Promise<void> {
    if (!this.retrieval.isRAGEnabled()) return;

    const article = await extractArticle(msg.Content);
    if (!article) return;

    const docContent = article.title ? `标题: ${article.title}\n\n${article.text}` : article.text;

    if (!docContent.trim()) return;

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

    logger.info(`[WeChatIngestService] Article upserted: "${article.title}" → ${this.config.rag.articleCollection}`);
  }

  // ──────────────────────────────────────────────────
  // RAG batch upsert (called by buffer on flush)
  // ──────────────────────────────────────────────────

  private async upsertBatch(convId: string, messages: ParsedWeChatMessage[]): Promise<void> {
    if (!this.retrieval.isRAGEnabled() || messages.length === 0) return;

    const isGroup = messages[0]!.isGroup;
    const collection = ragCollection(convId, isGroup);

    // Merge window into a single document (same strategy as RAGPersistenceSystem)
    const combined = messages
      .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] ${m.sender}: ${m.text}`)
      .join('\n');

    const windowId = `${convId}_${messages[0]!.timestamp}_${messages[messages.length - 1]!.timestamp}`;

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

    logger.info(`[WeChatIngestService] Flushed ${messages.length} msgs → ${collection}`);
  }
}
