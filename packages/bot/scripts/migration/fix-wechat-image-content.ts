#!/usr/bin/env bun
/**
 * Fix script: re-parse image/file message `content` columns with correct metadata,
 * resolve group names via PadPro API (synced to DB), and download images via CDN API.
 *
 * Run once:  bun scripts/fix-wechat-image-content.ts
 * Dry-run:   bun scripts/fix-wechat-image-content.ts --dry-run
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = resolve('data/wechat.db');
const CONFIG_PATH = resolve(process.env.CONFIG_PATH ?? (existsSync('config.d') ? 'config.d' : 'config.jsonc'));

// ────────────────────────────────────────────────────────────────────────────
// XML helpers (duplicated for script isolation)
// ────────────────────────────────────────────────────────────────────────────

function xmlAttr(xml: string, attr: string): string {
  const re = new RegExp(`\\b${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? '').replace(/&amp;/g, '&');
}

function xmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([^\\]]*)\\]\\]>|([^<]*))</${tag}>`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Image metadata extraction (mirrors WeChatIngestService.extractImgInfo)
// ────────────────────────────────────────────────────────────────────────────

interface ImgInfo {
  url: string;
  md5: string;
  width: number;
  height: number;
  fileSize: number;
  aeskey: string;
}

function extractImgInfo(rawContent: string): ImgInfo | null {
  const m = rawContent.match(/<img\s([^>]+?)(?:\/?>)/is);
  if (!m) return null;
  const attrs = m[0];

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
    Number(xmlAttr(attrs, 'tphdlength')) ||
    Number(xmlAttr(attrs, 'tplength')) ||
    Number(xmlAttr(attrs, 'length')) ||
    0;

  return {
    url: url || '',
    md5: xmlAttr(attrs, 'md5'),
    width,
    height,
    fileSize,
    aeskey: xmlAttr(attrs, 'aeskey'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// File metadata extraction for MsgType=49 file messages
// ────────────────────────────────────────────────────────────────────────────

function parseFileContent(rawContent: string): string {
  const finderStart = rawContent.indexOf('<finderFeed>');
  if (finderStart >= 0) {
    const finderEnd = rawContent.indexOf('</finderFeed>');
    const finderXml = rawContent.substring(finderStart, finderEnd >= 0 ? finderEnd + 13 : rawContent.length);
    const mediaStart = finderXml.indexOf('<media>');
    const mediaEnd = finderXml.indexOf('</media>');
    const mediaXml =
      mediaStart >= 0 && mediaEnd > mediaStart ? finderXml.substring(mediaStart, mediaEnd + 8) : '';
    return JSON.stringify({
      type: 'finder_video',
      nickname: xmlTag(finderXml, 'nickname'),
      desc: xmlTag(finderXml, 'desc'),
      username: xmlTag(finderXml, 'username'),
      avatar: xmlTag(finderXml, 'avatar'),
      videoUrl: xmlTag(mediaXml || finderXml, 'url'),
      coverUrl: xmlTag(mediaXml || finderXml, 'coverUrl'),
      duration: Number(xmlTag(mediaXml || finderXml, 'videoPlayDuration')) || 0,
    });
  }
  return JSON.stringify({
    title: xmlTag(rawContent, 'title'),
    description: xmlTag(rawContent, 'des'),
    fileName: xmlTag(rawContent, 'filename') || xmlTag(rawContent, 'title'),
    fileSize: xmlTag(rawContent, 'totallen'),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// PadPro API helpers
// ────────────────────────────────────────────────────────────────────────────

interface PadProConfig {
  apiBase: string;
  authKey: string;
}

interface StrWrapper { str?: string }

function strFieldOrStr(v: StrWrapper | string | undefined): string {
  if (typeof v === 'string') return v;
  return v?.str ?? '';
}

/** Sync all groups from PadPro API → wechat_groups table, return convId→nickName map. */
async function syncGroupsToDb(padpro: PadProConfig, db: Database): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const url = `${padpro.apiBase}/group/GetAllGroupList?key=${encodeURIComponent(padpro.authKey)}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      console.log(`  [warn] PadPro API returned HTTP ${resp.status}`);
      return map;
    }
    const json = (await resp.json()) as {
      Data?: {
        ChatRoomList?: Array<{ ChatRoomName?: StrWrapper | string; NickName?: StrWrapper | string; MemberCount?: number }>;
        chatRoomList?: Array<{ ChatRoomName?: StrWrapper | string; NickName?: StrWrapper | string; MemberCount?: number }>;
      };
    };
    const list = json.Data?.ChatRoomList ?? json.Data?.chatRoomList ?? [];
    const now = new Date().toISOString();
    const stmt = db.query(
      `INSERT OR REPLACE INTO wechat_groups (chatroomId, conversationId, nickName, memberCount, owner, updatedAt)
       VALUES (?, ?, ?, ?, '', ?)`,
    );

    for (const item of list) {
      const chatroomId = strFieldOrStr(item.ChatRoomName);
      const nickName = strFieldOrStr(item.NickName);
      if (!chatroomId || !nickName) continue;
      const convId = chatroomId.replace('@chatroom', '');
      stmt.run(chatroomId, convId, nickName, item.MemberCount ?? 0, now);
      map.set(convId, nickName);
    }
  } catch (err) {
    console.log(`  [warn] PadPro API error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

/** Download image via PadPro CDN API. Returns image buffer or null. */
async function downloadViaCdn(
  padpro: PadProConfig,
  aeskey: string,
  cdnUrl: string,
): Promise<Buffer | null> {
  const url = `${padpro.apiBase}/message/SendCdnDownload?key=${encodeURIComponent(padpro.authKey)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ AesKey: aeskey, FileURL: cdnUrl, FileType: 2 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.log(`    [cdn-fail] HTTP ${resp.status}`);
      return null;
    }
    const json = (await resp.json()) as { Code?: number; Data?: { FileData?: string; TotalSize?: number } };
    if (!json.Data?.FileData) {
      console.log(`    [cdn-fail] No FileData in response`);
      return null;
    }
    return Buffer.from(json.Data.FileData, 'base64');
  } catch (err) {
    console.log(`    [cdn-fail] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'unknown';
}

function loadPadProConfig(): PadProConfig | null {
  try {
    const { loadConfigAuto } = require('../../src/core/config/loadConfigDir') as typeof import('../../src/core/config/loadConfigDir');
    const config = loadConfigAuto(CONFIG_PATH) as {
      plugins?: { list?: Array<{ name: string; config?: { padpro?: PadProConfig } }> };
    };
    const plugin = config.plugins?.list?.find((p) => p.name === 'wechatIngest');
    const padpro = plugin?.config?.padpro;
    if (padpro?.apiBase && padpro?.authKey) return padpro;
  } catch (err) {
    console.log(`  [warn] Could not load config: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

interface MsgRow {
  id: number;
  newMsgId: string;
  rawContent: string;
  content: string;
  category: string;
  msgType: number;
  isGroup: number;
  conversationId: string;
}

console.log(`Opening DB: ${DB_PATH}${DRY_RUN ? '  [DRY RUN]' : ''}`);
const db = new Database(DB_PATH);
db.run('PRAGMA journal_mode = WAL');

// Ensure wechat_groups table exists
db.run(`
  CREATE TABLE IF NOT EXISTS wechat_groups (
    chatroomId     TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL UNIQUE,
    nickName       TEXT NOT NULL DEFAULT '',
    memberCount    INTEGER NOT NULL DEFAULT 0,
    owner          TEXT NOT NULL DEFAULT '',
    updatedAt      TEXT NOT NULL DEFAULT ''
  )
`);

// ── Step 1: Sync group names from PadPro API → DB ──

const padpro = loadPadProConfig();
let groupNames = new Map<string, string>();

if (padpro) {
  console.log('\nSyncing group names from PadPro API → DB...');
  groupNames = await syncGroupsToDb(padpro, db);
  console.log(`  Synced ${groupNames.size} groups to wechat_groups table`);
} else {
  console.log('\n[warn] No PadPro config found');
}

// Load group names from DB (includes previously synced data)
const dbGroups = db
  .query<{ conversationId: string; nickName: string }, []>(
    `SELECT conversationId, nickName FROM wechat_groups`,
  )
  .all();
for (const g of dbGroups) {
  if (g.nickName && !groupNames.has(g.conversationId)) {
    groupNames.set(g.conversationId, g.nickName);
  }
}
console.log(`  Total group names available: ${groupNames.size}`);
for (const [id, name] of groupNames) {
  console.log(`    ${id} → ${name}`);
}

// ── Step 2: Process image and file messages ──

const rows = db.query<MsgRow, []>(
  `SELECT id, newMsgId, rawContent, content, category, msgType, isGroup, conversationId
   FROM wechat_messages
   WHERE category IN ('image', 'file')
   ORDER BY id`,
).all();

console.log(`\nFound ${rows.length} image/file messages to inspect\n`);

let fixedContent = 0;
let downloaded = 0;
let downloadFailed = 0;
let alreadyCorrect = 0;
let noRawContent = 0;

const updateStmt = DRY_RUN
  ? null
  : db.query<void, [string, number]>(`UPDATE wechat_messages SET content = ? WHERE id = ?`);

for (const row of rows) {
  if (!row.rawContent) {
    noRawContent++;
    continue;
  }

  const groupName = groupNames.get(row.conversationId) ?? null;
  const folderName = groupName ? sanitizeFolderName(groupName) : row.conversationId;

  if (row.category === 'image') {
    const imgInfo = extractImgInfo(row.rawContent);

    // Attempt download via CDN API
    let filePath: string | null = null;
    const filename = imgInfo?.md5 ? `${imgInfo.md5}.jpg` : `${row.newMsgId}.jpg`;
    const savePath = `output/wechat/${folderName}`;
    const targetPath = `${savePath}/${filename}`;

    if (existsSync(resolve(targetPath))) {
      filePath = targetPath;
    } else if (padpro && imgInfo?.aeskey && imgInfo?.url && !DRY_RUN) {
      console.log(`  [download] id=${row.id} via CDN → ${targetPath}`);
      const buf = await downloadViaCdn(padpro, imgInfo.aeskey, imgInfo.url);
      if (buf && buf.length > 100) {
        const dir = resolve(savePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(targetPath), buf);
        filePath = targetPath;
        downloaded++;
        console.log(`    [ok] ${buf.length} bytes saved`);
      } else {
        downloadFailed++;
      }
    } else if (DRY_RUN && imgInfo?.aeskey && imgInfo?.url) {
      console.log(`    [dry] Would CDN download: aeskey=${imgInfo.aeskey.substring(0, 16)}... → ${targetPath}`);
    }

    const newContent = JSON.stringify({
      type: 'image',
      md5: imgInfo?.md5 ?? '',
      width: imgInfo?.width ?? 0,
      height: imgInfo?.height ?? 0,
      fileSize: imgInfo?.fileSize ?? 0,
      aeskey: imgInfo?.aeskey ?? '',
      groupName,
      filePath,
    });

    if (newContent !== row.content) {
      console.log(
        `  [fix] id=${row.id} group=${groupName ?? row.conversationId} ` +
          `md5=${imgInfo?.md5 ?? 'n/a'} ${imgInfo?.width ?? 0}x${imgInfo?.height ?? 0} ` +
          `size=${imgInfo?.fileSize ?? 0}${filePath ? ' ✓saved' : ''}`,
      );
      if (!DRY_RUN) updateStmt?.run(newContent, row.id);
      fixedContent++;
    } else {
      alreadyCorrect++;
    }
  } else if (row.category === 'file') {
    const newContent = parseFileContent(row.rawContent);
    if (newContent !== row.content) {
      console.log(`  [fix] id=${row.id} category=file`);
      if (!DRY_RUN) updateStmt?.run(newContent, row.id);
      fixedContent++;
    } else {
      alreadyCorrect++;
    }
  }
}

console.log(`\n── Summary ─────────────────────────────`);
console.log(`  Content fixed  : ${fixedContent}`);
console.log(`  Already correct: ${alreadyCorrect}`);
console.log(`  No rawContent  : ${noRawContent}`);
console.log(`  Downloaded     : ${downloaded}`);
console.log(`  Download failed: ${downloadFailed}`);
console.log(`  Group names    : ${groupNames.size} (from DB)`);
console.log(`  Total inspected: ${rows.length}`);
if (DRY_RUN) console.log(`\n  This was a dry run — no changes written.`);
db.close();
