#!/usr/bin/env bun
/**
 * Migration: convert userId (INTEGER) and groupId (INTEGER) columns in the messages table to TEXT.
 * Required for Discord protocol support (snowflake IDs exceed JS Number.MAX_SAFE_INTEGER).
 *
 * Run once:  bun scripts/migration/migrate-userid-to-text.ts
 * Dry-run:   bun scripts/migration/migrate-userid-to-text.ts --dry-run
 *
 * This is safe to run on databases that have already been migrated (idempotent).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = resolve(process.argv[2] ?? 'data/bot.db');

if (!existsSync(DB_PATH)) {
  console.error(`Database file not found: ${DB_PATH}`);
  console.error('Usage: bun scripts/migration/migrate-userid-to-text.ts [path/to/bot.db] [--dry-run]');
  process.exit(1);
}

console.log(`Opening database: ${DB_PATH}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

const db = new Database(DB_PATH);

// Check current column types via table_info
const columns = db.query("PRAGMA table_info('messages')").all() as Array<{
  name: string;
  type: string;
}>;

const userIdCol = columns.find((c) => c.name === 'userId');
const groupIdCol = columns.find((c) => c.name === 'groupId');

if (!userIdCol) {
  console.log('No messages table or no userId column found. Nothing to migrate.');
  db.close();
  process.exit(0);
}

console.log(`Current userId type: ${userIdCol.type}`);
console.log(`Current groupId type: ${groupIdCol?.type ?? 'N/A'}`);

// SQLite doesn't support ALTER COLUMN directly, so we use the rename-recreate pattern.
// 1. Rename old table
// 2. Create new table with TEXT columns
// 3. Copy data
// 4. Drop old table

if (userIdCol.type === 'TEXT' && (!groupIdCol || groupIdCol.type === 'TEXT')) {
  console.log('Columns are already TEXT. Migration not needed.');
  db.close();
  process.exit(0);
}

if (DRY_RUN) {
  const count = (db.query('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  console.log(`[DRY RUN] Would migrate ${count} rows. No changes made.`);
  db.close();
  process.exit(0);
}

console.log('Starting migration...');

db.exec('BEGIN TRANSACTION');

try {
  // Step 1: Rename existing table
  db.exec('ALTER TABLE messages RENAME TO messages_old');

  // Step 2: Create new table with TEXT columns for userId and groupId
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL,
    userId TEXT NOT NULL,
    messageType TEXT NOT NULL CHECK(messageType IN ('private', 'group')),
    groupId TEXT,
    content TEXT NOT NULL,
    rawContent TEXT,
    protocol TEXT NOT NULL,
    messageId TEXT,
    messageSeq INTEGER,
    metadata TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (conversationId) REFERENCES conversations(id)
  )`);

  // Step 3: Copy data, casting INTEGER to TEXT
  db.exec(`INSERT INTO messages
    SELECT id, conversationId, CAST(userId AS TEXT), messageType, CAST(groupId AS TEXT),
           content, rawContent, protocol, messageId, messageSeq, metadata, createdAt, updatedAt
    FROM messages_old`);

  const count = (db.query('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  console.log(`Migrated ${count} rows.`);

  // Step 4: Drop old table
  db.exec('DROP TABLE messages_old');

  // Recreate indexes if they existed
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_userId ON messages(userId)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId)');

  db.exec('COMMIT');
  console.log('Migration completed successfully.');
} catch (error) {
  db.exec('ROLLBACK');
  console.error('Migration failed, changes rolled back:', error);
  process.exit(1);
} finally {
  db.close();
}
