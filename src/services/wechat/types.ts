// WeChat Ingest Plugin - Type definitions

// ────────────────────────────────────────────────────────────────────────────
// Webhook payload from WeChatPadPro
// ────────────────────────────────────────────────────────────────────────────

export interface WeChatWebhookMessage {
  Content: string;
  CreateTime: number;
  FromUserName: string;
  MsgId: number;
  MsgType: number;
  NewMsgId: number;
  ToUserName: string;
  timestamp: number;
  timestamp_ms: number;
  ts: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal parsed message (after classification & group-message parsing)
// ────────────────────────────────────────────────────────────────────────────

export type MessageCategory = 'text' | 'image' | 'article' | 'file' | 'system' | 'other';

export interface ParsedWeChatMessage {
  /** Original message ID (NewMsgId as string for RAG document ID) */
  id: string;
  /** The source: group chatroom ID or private wxid */
  conversationId: string;
  /** Whether this came from a group chat */
  isGroup: boolean;
  /** Sender within the conversation (nickname or wxid) */
  sender: string;
  /** Plain text content */
  text: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
  /** Original MsgType */
  msgType: number;
  category: MessageCategory;
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin configuration (from config.jsonc → plugins.list[].config)
// ────────────────────────────────────────────────────────────────────────────

export interface WeChatRealtimeRule {
  pattern: string; // regex string
  qqGroupId: string;
  template: string; // e.g. "微信消息: {text}"
}

export interface WeChatIngestConfig {
  listenPort?: number;
  listenPath?: string;
  padpro?: {
    apiBase?: string;
    adminKey?: string;
    authKey?: string;
    wxid?: string;
  };
  rag?: {
    articleCollection?: string;
    momentsCollection?: string;
    bufferIdleMinutes?: number;
    bufferMaxMessages?: number;
  };
  /** OA account nicknames to ignore (skip article ingestion). Can also be a path to a .txt file (one name per line). */
  ignoredOAAccounts?: string[] | string;
  realtime?: {
    enabled?: boolean;
    rules?: WeChatRealtimeRule[];
  };
  digest?: {
    enabled?: boolean;
    cron?: string;
    targetQQGroup?: string;
  };
  sns?: {
    enabled?: boolean;
    pollIntervalMinutes?: number;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Resolved (with defaults applied) config
// ────────────────────────────────────────────────────────────────────────────

export interface ResolvedWeChatIngestConfig {
  listenPort: number;
  listenPath: string;
  rag: {
    articleCollection: string;
    momentsCollection: string;
    bufferIdleMinutes: number;
    bufferMaxMessages: number;
  };
  realtime: {
    enabled: boolean;
    rules: WeChatRealtimeRule[];
  };
  /** Set of OA account nicknames to skip when ingesting articles */
  ignoredOAAccounts: Set<string>;
}

export function resolveConfig(raw: WeChatIngestConfig | undefined): ResolvedWeChatIngestConfig {
  return {
    listenPort: raw?.listenPort ?? 9920,
    listenPath: raw?.listenPath ?? '/wechat/callback',
    rag: {
      articleCollection: raw?.rag?.articleCollection ?? 'wechat_articles',
      momentsCollection: raw?.rag?.momentsCollection ?? 'wechat_moments',
      bufferIdleMinutes: raw?.rag?.bufferIdleMinutes ?? 5,
      bufferMaxMessages: raw?.rag?.bufferMaxMessages ?? 10,
    },
    realtime: {
      enabled: raw?.realtime?.enabled ?? false,
      rules: raw?.realtime?.rules ?? [],
    },
    ignoredOAAccounts: loadIgnoredOAAccounts(raw?.ignoredOAAccounts),
  };
}

/** Load ignored OA accounts from config: string[] inline, or a path to a .txt file (one name per line). */
function loadIgnoredOAAccounts(value: string[] | string | undefined): Set<string> {
  if (!value) return new Set();
  if (Array.isArray(value)) return new Set(value.map((s) => s.trim()).filter(Boolean));
  // Treat as file path
  try {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const content = readFileSync(resolve(value), 'utf-8') as string;
    const names = content
      .split('\n')
      .map((line: string) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
    return new Set(names);
  } catch {
    return new Set();
  }
}
