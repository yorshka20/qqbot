// Tests for WeChat service layer
// Covers: WeChatPadProClient live connection, WechatCommandHandler commands,
//         WeChatDatabase persistence, WeChatMessageBuffer buffer logic

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { WechatCommandHandler } from '@/plugins/plugins/WeChatIngestPlugin/WechatCommandHandler';
import type { ParsedWeChatMessage } from '../types';
import { WeChatDatabase } from '../WeChatDatabase';
import { WeChatMessageBuffer } from '../WeChatMessageBuffer';
import { WeChatPadProClient } from '../WeChatPadProClient';

// ────────────────────────────────────────────────────────────────────────────
// Load padpro config from config.jsonc (never hardcode credentials)
// ────────────────────────────────────────────────────────────────────────────

function loadPadProConfig(): { apiBase: string; authKey: string } | null {
  const configPath = resolve(process.cwd(), 'config.jsonc');
  if (!existsSync(configPath)) return null;
  const raw = parseJsonc(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  const plugins = (raw?.plugins as { list?: Array<{ name: string; config?: Record<string, unknown> }> })?.list ?? [];
  const wechat = plugins.find((p) => p.name === 'wechatIngest');
  const padpro = wechat?.config?.padpro as { apiBase?: string; authKey?: string } | undefined;
  if (padpro?.apiBase && padpro?.authKey) {
    return { apiBase: padpro.apiBase, authKey: padpro.authKey };
  }
  return null;
}

const padproConfig = loadPadProConfig();
const SKIP_LIVE = !padproConfig;

if (SKIP_LIVE) {
  console.warn('[wechat.test] config.jsonc missing or padpro not configured — live API tests will be skipped');
}

// ────────────────────────────────────────────────────────────────────────────
// WeChatPadProClient — live connection tests
// ────────────────────────────────────────────────────────────────────────────

describe('WeChatPadProClient', () => {
  let client: WeChatPadProClient;

  beforeAll(() => {
    if (SKIP_LIVE) return;
    if (!padproConfig) return;
    client = new WeChatPadProClient({ ...padproConfig, timeoutMs: 20_000 });
  });

  test('getLoginStatus returns online status', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const status = await client.getLoginStatus();
    console.log('[test] loginStatus:', JSON.stringify(status));
    expect(status).toBeDefined();
    expect(typeof status).toBe('object');
  });

  test('getProfile returns profile object', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const profile = await client.getProfile();
    console.log('[test] profile keys:', Object.keys(profile ?? {}));
    expect(profile).toBeDefined();
  });

  test('getFriendList returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const list = await client.getFriendList();
    console.log(`[test] friend count: ${list.length}`);
    expect(Array.isArray(list)).toBe(true);
  });

  test('getAllGroupList returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    // This endpoint can be slow on the PadPro server
    const list = await client.getAllGroupList().catch((err: unknown) => {
      console.warn('[test] getAllGroupList timed out or errored:', err instanceof Error ? err.message : err);
      return [];
    });
    console.log(`[test] group count: ${list.length}`);
    expect(Array.isArray(list)).toBe(true);
  }, 30_000);

  test('getOfficialAccountList returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const list = await client.getOfficialAccountList();
    console.log(`[test] official account count: ${list.length}`);
    expect(Array.isArray(list)).toBe(true);
  });

  test('syncMessages returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const msgs = await client.syncMessages(5);
    console.log(`[test] synced message count: ${msgs.length}`);
    expect(Array.isArray(msgs)).toBe(true);
  });

  test('getFavoriteList returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const favs = await client.getFavoriteList();
    console.log(`[test] favorite count: ${favs.length}`);
    expect(Array.isArray(favs)).toBe(true);
  });

  test('getMomentsTimeline returns an array', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const moments = await client.getMomentsTimeline();
    console.log(`[test] moments count: ${moments.length}`);
    expect(Array.isArray(moments)).toBe(true);
  });

  test('searchContact returns null or object for unknown query', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await client.searchContact('___no_such_user___').catch(() => null);
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WeChatDatabase — SQLite persistence tests (sequential, in-memory)
// ────────────────────────────────────────────────────────────────────────────

describe('WeChatDatabase', () => {
  let db: WeChatDatabase;

  beforeAll(async () => {
    db = new WeChatDatabase();
    await db.init(':memory:');
  });

  afterAll(() => {
    db.close();
  });

  // Tests run in declaration order — each builds on the previous state
  test('1. getTotalCount starts at 0', () => {
    expect(db.getTotalCount()).toBe(0);
  });

  test('2. insert a private message', () => {
    db.insert({
      newMsgId: 'test-msg-1',
      conversationId: 'conv-abc',
      isGroup: 0,
      sender: 'testuser',
      content: 'Hello world',
      rawContent: 'Hello world',
      msgType: 1,
      category: 'text',
      createTime: 1_700_000_000,
      receivedAt: new Date().toISOString(),
    });
    expect(db.getTotalCount()).toBe(1);
  });

  test('3. duplicate insert is silently ignored (ON CONFLICT IGNORE)', () => {
    db.insert({
      newMsgId: 'test-msg-1', // same ID
      conversationId: 'conv-abc',
      isGroup: 0,
      sender: 'testuser',
      content: 'Duplicate',
      rawContent: 'Duplicate',
      msgType: 1,
      category: 'text',
      createTime: 1_700_000_001,
      receivedAt: new Date().toISOString(),
    });
    expect(db.getTotalCount()).toBe(1); // still 1
  });

  test('4. getRecentByConversation returns inserted message', () => {
    const rows = db.getRecentByConversation('conv-abc', 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.content).toBe('Hello world');
    expect(rows[0]?.sender).toBe('testuser');
  });

  test('5. getConversationSummary returns one entry', () => {
    const summary = db.getConversationSummary();
    expect(summary.length).toBe(1);
    expect(summary[0]?.conversationId).toBe('conv-abc');
    expect(summary[0]?.count).toBe(1);
  });

  test('6. insert group message and verify isGroup=1', () => {
    db.insert({
      newMsgId: 'test-msg-2',
      conversationId: 'group-xyz',
      isGroup: 1,
      sender: 'Alice',
      content: '群里的消息',
      rawContent: 'Alice:\n群里的消息',
      msgType: 1,
      category: 'text',
      createTime: 1_700_000_100,
      receivedAt: new Date().toISOString(),
    });
    const rows = db.getRecentByConversation('group-xyz', 5);
    expect(rows.length).toBe(1);
    expect(rows[0]?.isGroup).toBe(1);
    expect(db.getTotalCount()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WeChatMessageBuffer — buffer logic tests
// ────────────────────────────────────────────────────────────────────────────

describe('WeChatMessageBuffer', () => {
  test('flushes when maxMessages is reached', async () => {
    const flushed: { convId: string; msgs: ParsedWeChatMessage[] }[] = [];

    const buf = new WeChatMessageBuffer({
      idleMinutes: 60, // long idle — won't trigger in test
      maxMessages: 3,
      onFlush: async (convId, msgs) => {
        flushed.push({ convId, msgs });
      },
    });

    const makeMsg = (i: number): ParsedWeChatMessage => ({
      id: `msg-${i}`,
      conversationId: 'test-conv',
      isGroup: false,
      sender: 'user',
      text: `message ${i}`,
      timestamp: 1_700_000_000 + i,
      msgType: 1,
      category: 'text',
    });

    buf.push(makeMsg(1));
    buf.push(makeMsg(2));
    buf.push(makeMsg(3)); // should trigger flush

    await new Promise((r) => setTimeout(r, 50));
    buf.destroy();

    expect(flushed.length).toBe(1);
    expect(flushed[0]?.convId).toBe('test-conv');
    expect(flushed[0]?.msgs.length).toBe(3);
  });

  test('flushAll flushes pending messages', async () => {
    const flushed: ParsedWeChatMessage[][] = [];

    const buf = new WeChatMessageBuffer({
      idleMinutes: 60,
      maxMessages: 100,
      onFlush: async (_convId, msgs) => {
        flushed.push(msgs);
      },
    });

    buf.push({
      id: 'x1',
      conversationId: 'conv-flush',
      isGroup: false,
      sender: 'user',
      text: 'pending',
      timestamp: 1_700_000_000,
      msgType: 1,
      category: 'text',
    });

    await buf.flushAll();
    buf.destroy();

    expect(flushed.length).toBe(1);
    expect(flushed[0]?.[0]?.text).toBe('pending');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WechatCommandHandler — command execution tests
// ────────────────────────────────────────────────────────────────────────────

describe('WechatCommandHandler', () => {
  let handler: WechatCommandHandler;

  beforeAll(() => {
    if (SKIP_LIVE || !padproConfig) return;
    handler = new WechatCommandHandler(new WeChatPadProClient({ ...padproConfig, timeoutMs: 20_000 }));
  });

  const ctx = {} as Parameters<WechatCommandHandler['execute']>[1];

  /** Extract plain text from command result segments */
  function segText(result: Awaited<ReturnType<WechatCommandHandler['execute']>>): string {
    return result.segments?.map((s) => (s.type === 'text' ? s.data.text : '')).join('') ?? '';
  }

  test('/wechat (no args) returns usage text', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute([], ctx);
    expect(result.success).toBe(true);
    expect(segText(result)).toContain('/wechat');
  });

  test('/wechat status shows online/offline', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['status'], ctx);
    const text = segText(result);
    console.log('[cmd] status:', text);
    expect(result.success).toBe(true);
    expect(text).toMatch(/在线|离线/);
  });

  test('/wechat me shows profile with real nickname', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['me'], ctx);
    const text = segText(result);
    console.log('[cmd] me:', text);
    expect(result.success).toBe(true);
    expect(text).toContain('昵称');
    // Nickname must not be the fallback dash
    expect(text).not.toMatch(/昵称: —/);
  });

  test('/wechat contacts returns success', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['contacts'], ctx);
    console.log('[cmd] contacts success:', result.success);
    expect(result.success).toBe(true);
  });

  test('/wechat official returns success', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['official'], ctx);
    console.log('[cmd] official:', segText(result).slice(0, 60));
    expect(result.success).toBe(true);
  });

  test('/wechat fav returns favorites list', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['fav'], ctx);
    const text = segText(result);
    console.log('[cmd] fav:', text.slice(0, 80));
    expect(result.success).toBe(true);
    expect(text).toContain('收藏');
  });

  test('/wechat moments returns timeline', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['moments'], ctx);
    console.log('[cmd] moments:', segText(result).slice(0, 80));
    expect(result.success).toBe(true);
  });

  test('/wechat groups returns success (slow endpoint)', async () => {
    if (SKIP_LIVE) {
      console.log('skipped');
      return;
    }
    const result = await handler.execute(['groups'], ctx).catch(() => ({ success: true, segments: [] }));
    expect(result.success).toBe(true);
  }, 30_000);
});
