#!/usr/bin/env bun
/**
 * One-time cleanup script: re-parse the `content` column for all rows in
 * wechat_messages so that old raw-XML values are replaced with correct JSON.
 *
 * Run once:  bun scripts/fix-wechat-db-content.ts
 * (Optional) dry-run:  bun scripts/fix-wechat-db-content.ts --dry-run
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = resolve('data/wechat.db');

// ────────────────────────────────────────────────────────────────────────────
// XML helpers (duplicated here for script isolation — no bot imports needed)
// ────────────────────────────────────────────────────────────────────────────

function xmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([^\\]]*)\\]\\]>|([^<]*))</${tag}>`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

function parseContentAsJson(rawContent: string, category: string, msgType: number): string {
  switch (category) {
    case 'text':
      // Should not reach here — text handled separately
      return JSON.stringify({ text: rawContent });

    case 'article':
      return JSON.stringify({
        title: xmlTag(rawContent, 'title'),
        url: xmlTag(rawContent, 'url'),
        description: xmlTag(rawContent, 'des'),
        digest: xmlTag(rawContent, 'digest'),
        source: xmlTag(rawContent, 'sourcedisplayname') || xmlTag(rawContent, 'appname'),
      });

    case 'file': {
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

    case 'image':
      return JSON.stringify({ type: 'image' });

    default:
      return JSON.stringify({
        msgType,
        preview: rawContent
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .substring(0, 200),
      });
  }
}

/** For group text messages rawContent is "sender_wxid:\nactual text" */
function extractTextFromRaw(rawContent: string, isGroup: number): string {
  if (isGroup) {
    const nl = rawContent.indexOf('\n');
    if (nl > 0 && rawContent[nl - 1] === ':') {
      return rawContent.substring(nl + 1);
    }
  }
  return rawContent;
}

function isLikelyJson(s: string): boolean {
  return s.trimStart().startsWith('{');
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

interface MsgRow {
  id: number;
  rawContent: string;
  content: string;
  category: string;
  msgType: number;
  isGroup: number;
}

console.log(`Opening DB: ${DB_PATH}${DRY_RUN ? '  [DRY RUN]' : ''}`);
const db = new Database(DB_PATH);

// Ensure WAL mode for safe read-while-writing
db.run('PRAGMA journal_mode = WAL');

const rows = db.query<MsgRow, []>(
  `SELECT id, rawContent, content, category, msgType, isGroup FROM wechat_messages ORDER BY id`,
).all();

console.log(`Rows to inspect: ${rows.length}\n`);

let fixed = 0;
let already = 0;
let empty = 0;

const updateStmt = DRY_RUN
  ? null
  : db.query<void, [string, number]>(`UPDATE wechat_messages SET content = ? WHERE id = ?`);

for (const row of rows) {
  if (!row.rawContent) {
    empty++;
    continue;
  }

  let newContent: string;
  if (row.category === 'text') {
    newContent = JSON.stringify({ text: extractTextFromRaw(row.rawContent, row.isGroup) });
  } else {
    newContent = parseContentAsJson(row.rawContent, row.category, row.msgType);
  }

  if (newContent === row.content) {
    already++;
    continue;
  }

  const wasXml = !isLikelyJson(row.content);
  console.log(
    `  [${DRY_RUN ? 'dry' : 'fix'}] id=${row.id} category=${row.category} isGroup=${row.isGroup}` +
      `  ${wasXml ? 'XML→JSON' : 'JSON→JSON(updated)'}`,
  );
  if (DRY_RUN) {
    console.log(`    before: ${row.content.substring(0, 80)}`);
    console.log(`    after:  ${newContent.substring(0, 120)}`);
  }

  if (!DRY_RUN) updateStmt!.run(newContent, row.id);
  fixed++;
}

console.log(`\n── Summary ─────────────────────────────`);
console.log(`  Fixed   : ${fixed}`);
console.log(`  Skipped : ${already} (already correct)`);
console.log(`  Empty   : ${empty} (no rawContent)`);
console.log(`  Total   : ${rows.length}`);
if (DRY_RUN) console.log(`\n  This was a dry run — no changes written.`);
db.close();
