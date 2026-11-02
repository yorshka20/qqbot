import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { MemoryDisplayNames, memorySubjectKey } from '../memoryDisplayNames';

function createService(): { service: MemoryDisplayNames; db: Database } {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    groupId TEXT,
    userId TEXT,
    metadata TEXT,
    createdAt TEXT
  )`);
  return { service: new MemoryDisplayNames(db), db };
}

function insertMessage(
  db: Database,
  row: { id: string; groupId: string; userId: string; createdAt: string; metadata: Record<string, unknown> },
): void {
  db.query('INSERT INTO messages (id, groupId, userId, metadata, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.groupId,
    row.userId,
    JSON.stringify(row.metadata),
    row.createdAt,
  );
}

describe('memory display names', () => {
  it('uses the latest group name', () => {
    const { service, db } = createService();
    insertMessage(db, {
      id: '1',
      groupId: '100',
      userId: '1',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { groupName: '旧群名' },
    });
    insertMessage(db, {
      id: '2',
      groupId: '100',
      userId: '1',
      createdAt: '2026-06-01T00:00:00.000Z',
      metadata: { groupName: '新群名' },
    });

    expect(service.lookupLatestGroupNames(['100']).get('100')).toBe('新群名');
  });

  it('prefers the group card on the latest message over the account nickname', () => {
    const { service, db } = createService();
    insertMessage(db, {
      id: '1',
      groupId: '100',
      userId: '200',
      createdAt: '2026-06-01T00:00:00.000Z',
      metadata: { sender: { nickname: '账号昵称', card: '群名片' } },
    });

    const names = service.lookupLatestNicknames([{ groupId: '100', userId: '200' }]);
    expect(names.get(memorySubjectKey('100', '200'))).toBe('群名片');
  });

  it('uses the latest name in the group, not an older card', () => {
    const { service, db } = createService();
    insertMessage(db, {
      id: '1',
      groupId: '100',
      userId: '200',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { sender: { card: '旧名片' } },
    });
    insertMessage(db, {
      id: '2',
      groupId: '100',
      userId: '200',
      createdAt: '2026-06-01T00:00:00.000Z',
      metadata: { sender: { nickname: '新昵称' } },
    });

    const names = service.lookupLatestNicknames([{ groupId: '100', userId: '200' }]);
    expect(names.get(memorySubjectKey('100', '200'))).toBe('新昵称');
  });

  it('falls back to a name from another conversation when this group has none', () => {
    const { service, db } = createService();
    insertMessage(db, {
      id: '1',
      groupId: '999',
      userId: '200',
      createdAt: '2026-06-01T00:00:00.000Z',
      metadata: { sender: { nickname: '别处的名字' } },
    });

    const names = service.lookupLatestNicknames([{ groupId: '100', userId: '200' }]);
    expect(names.get(memorySubjectKey('100', '200'))).toBe('别处的名字');
  });
});
