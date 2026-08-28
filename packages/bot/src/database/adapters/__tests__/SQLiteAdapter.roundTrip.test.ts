/**
 * Round-trip tests for SQLiteModelAccessor.
 *
 * The contract under test is identity: a value written through the accessor must come back out of
 * it as the same value, in the type the model declares. SQLite cannot store objects, booleans or
 * dates natively, so the accessor converts on the way in and has to convert back on the way out —
 * and a conversion that only exists on one side is invisible to `tsc` (the field still satisfies
 * its declared type at every call site) and to any test that writes and reads through the same
 * wrong assumption. That gap is why `metadata` shipped as "write a string, read an object" for
 * months while five callers silently swallowed the mismatch.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgendaItem, BilibiliDanmakuRecord, Conversation, Message } from '@/database/models/types';
import { SQLiteAdapter } from '../SQLiteAdapter';

let dir: string;
let adapter: SQLiteAdapter;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qqbot-sqlite-'));
  adapter = new SQLiteAdapter(join(dir, 'test.db'));
  await adapter.connect();
  await adapter.migrate();
});

afterEach(async () => {
  await adapter.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

function newAgendaItem(overrides: Partial<AgendaItem> = {}): Omit<AgendaItem, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'round-trip',
    userId: '1',
    triggerType: 'cron',
    cronExpr: '0 0 * * *',
    intent: 'do a thing',
    cooldownMs: 60_000,
    maxSteps: 15,
    enabled: true,
    ...overrides,
  } as Omit<AgendaItem, 'id' | 'createdAt' | 'updatedAt'>;
}

describe('SQLiteModelAccessor — JSON fields', () => {
  it('returns an object for a field declared as an object', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ metadata: { source: 'file' } }));

    // create() returns the record it built, so the real assertion is on a fresh read.
    const read = await items.findById(created.id);

    expect(read?.metadata).toEqual({ source: 'file' });
    expect(typeof read?.metadata).toBe('object');
  });

  it('survives a nested structure without flattening or stringifying it', async () => {
    const items = adapter.getModel('agendaItems');
    const metadata = { source: 'llm', chainDepth: 2, tags: ['a', 'b'], nested: { deep: true } };
    const created = await items.create(newAgendaItem({ metadata }));

    expect((await items.findById(created.id))?.metadata).toEqual(metadata);
  });

  it('keeps the shape stable across an update', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ metadata: { source: 'file' } }));

    await items.update(created.id, { metadata: { source: 'llm', chainDepth: 1 } });

    expect((await items.findById(created.id))?.metadata).toEqual({ source: 'llm', chainDepth: 1 });
  });

  it('reads the same shape through find() as through findById()', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ metadata: { source: 'file' } }));

    const [found] = await items.find({ name: 'round-trip' });

    expect(found.metadata).toEqual((await items.findById(created.id))?.metadata);
  });

  it('leaves an absent field absent rather than inventing an empty object', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem());

    expect((await items.findById(created.id))?.metadata).toBeFalsy();
  });
});

describe('SQLiteModelAccessor — boolean fields', () => {
  it('returns a boolean for a field declared as a boolean', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ enabled: true }));

    const read = await items.findById(created.id);

    expect(read?.enabled).toBe(true);
    expect(typeof read?.enabled).toBe('boolean');
  });

  it('round-trips false as false, not 0', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ enabled: false }));

    const read = await items.findById(created.id);

    expect(read?.enabled).toBe(false);
    expect(typeof read?.enabled).toBe('boolean');
  });

  it('supports a strict equality check against the value that was written', async () => {
    // AgendaCommandHandler compares `item.enabled === enabled` to skip a no-op toggle; a numeric
    // 0/1 makes that comparison silently always false.
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ enabled: false }));

    expect((await items.findById(created.id))?.enabled === false).toBe(true);
  });

  it('restores boolean columns on other models too', async () => {
    const danmaku = adapter.getModel('bilibiliDanmaku');
    const created = await danmaku.create({
      roomId: '1',
      uid: '2',
      username: 'u',
      text: 't',
      normalizedText: 't',
      mentionsStreamer: true,
      receivedAt: new Date(),
    } as Omit<BilibiliDanmakuRecord, 'id' | 'createdAt' | 'updatedAt'>);

    expect((await danmaku.findById(created.id))?.mentionsStreamer).toBe(true);
  });

  it('leaves a boolean nested inside a JSON field alone — the parse already restores it', async () => {
    const conversation = await adapter.getModel('conversations').create({
      sessionId: 'user:1',
      sessionType: 'user',
      messageCount: 0,
      lastMessageAt: new Date(),
    } as Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>);
    const messages = adapter.getModel('messages');
    const created = await messages.create({
      conversationId: conversation.id,
      userId: '1',
      content: 'hi',
      messageType: 'private',
      protocol: 'milky',
      metadata: { isBotReply: true },
    } as Omit<Message, 'id' | 'createdAt' | 'updatedAt'>);

    expect((await messages.findById(created.id))?.metadata?.isBotReply).toBe(true);
  });

  it('filters on a boolean written as a boolean', async () => {
    const items = adapter.getModel('agendaItems');
    await items.create(newAgendaItem({ name: 'on', enabled: true }));
    await items.create(newAgendaItem({ name: 'off', enabled: false }));

    const enabled = await items.find({ enabled: true } as Partial<AgendaItem>);

    expect(enabled.map((i) => i.name)).toEqual(['on']);
  });
});

describe('SQLiteModelAccessor — identity of other stored types', () => {
  it('returns Dates for the timestamp columns', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem());

    const read = await items.findById(created.id);

    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.updatedAt).toBeInstanceOf(Date);
  });

  it('preserves numbers as numbers', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem({ cooldownMs: 82_800_000, maxSteps: 15 }));

    const read = await items.findById(created.id);

    expect(read?.cooldownMs).toBe(82_800_000);
    expect(read?.maxSteps).toBe(15);
  });

  it('honours a caller-supplied id instead of minting one', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create({ ...newAgendaItem(), id: '42' } as Omit<
      AgendaItem,
      'createdAt' | 'updatedAt'
    >);

    expect(created.id).toBe('42');
    expect((await items.findById('42'))?.name).toBe('round-trip');
  });

  it('still mints an id when the caller supplies none', async () => {
    const items = adapter.getModel('agendaItems');
    const created = await items.create(newAgendaItem());

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
