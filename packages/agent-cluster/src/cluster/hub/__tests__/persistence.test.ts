import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventLog } from '../EventLog';
import { LockManager } from '../LockManager';
import { MessageBox } from '../MessageBox';

/**
 * The hub stores are built straight on a database the cluster has already migrated, so the
 * tests create the same three tables `ClusterManager.initDatabase()` does.
 */
function openDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE cluster_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    type TEXT NOT NULL,
    sourceWorkerId TEXT,
    targetWorkerId TEXT,
    data TEXT NOT NULL,
    jobId TEXT,
    taskId TEXT
  )`);
  db.run(`CREATE TABLE cluster_locks (
    filePath TEXT PRIMARY KEY,
    workerId TEXT NOT NULL,
    taskId TEXT,
    claimedAt INTEGER NOT NULL,
    lastRenewed INTEGER NOT NULL,
    ttl INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE cluster_messages (
    id TEXT PRIMARY KEY,
    targetWorkerId TEXT NOT NULL,
    type TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('LockManager persistence', () => {
  let db: Database;
  let eventLog: EventLog;
  const managers: LockManager[] = [];

  function newManager(ttl?: number): LockManager {
    const manager = new LockManager(db, eventLog, ttl);
    managers.push(manager);
    return manager;
  }

  beforeEach(() => {
    db = openDb();
    eventLog = new EventLog(db);
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
    db.close();
  });

  test('a lock taken by one instance is visible to the next one built on the same db', () => {
    const first = newManager();
    expect(first.tryAcquire(['src/a.ts', 'src/b.ts'], 'worker-1', 'task-1').granted).toBe(true);

    const second = newManager();
    const locks = second.getActiveLocks().sort((a, b) => a.filePath.localeCompare(b.filePath));
    expect(locks.map((l) => l.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(locks[0]).toMatchObject({ workerId: 'worker-1', taskId: 'task-1', ttl: 600_000 });
    expect(second.getWorkerLocks('worker-1')).toHaveLength(2);
  });

  test('another worker asking the restored instance for the same file gets a conflict', () => {
    newManager().tryAcquire(['src/a.ts'], 'worker-1', 'task-1');

    const result = newManager().tryAcquire(['src/a.ts', 'src/c.ts'], 'worker-2', 'task-2');
    expect(result.granted).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ file: 'src/a.ts', heldBy: 'worker-1' });
    // A refused request takes nothing, not even the free file.
    expect(db.query('SELECT COUNT(*) AS n FROM cluster_locks').get()).toEqual({ n: 1 });
  });

  test('the holder itself may re-acquire its file', () => {
    newManager().tryAcquire(['src/a.ts'], 'worker-1', 'task-1');

    expect(newManager().tryAcquire(['src/a.ts'], 'worker-1', 'task-1').granted).toBe(true);
    expect(db.query('SELECT COUNT(*) AS n FROM cluster_locks').get()).toEqual({ n: 1 });
  });

  test('releaseAll removes the rows, so a new instance sees nothing', () => {
    const first = newManager();
    first.tryAcquire(['src/a.ts', 'src/b.ts'], 'worker-1', 'task-1');
    first.tryAcquire(['src/c.ts'], 'worker-2', 'task-2');

    first.releaseAll('worker-1');

    const second = newManager();
    expect(second.getActiveLocks().map((l) => l.filePath)).toEqual(['src/c.ts']);
    expect(second.tryAcquire(['src/a.ts'], 'worker-3').granted).toBe(true);
  });

  test('an expired lock does not block a new worker, even after a restart', async () => {
    newManager(30).tryAcquire(['src/a.ts'], 'worker-1', 'task-1');
    await sleep(60);

    const result = newManager(30).tryAcquire(['src/a.ts'], 'worker-2', 'task-2');
    expect(result.granted).toBe(true);
    const row = db.query('SELECT workerId, taskId FROM cluster_locks WHERE filePath = ?').get('src/a.ts');
    expect(row).toEqual({ workerId: 'worker-2', taskId: 'task-2' });
  });

  test('renewAll writes the new lastRenewed through, so the restored lock keeps its TTL window', async () => {
    const first = newManager(200);
    first.tryAcquire(['src/a.ts'], 'worker-1', 'task-1');
    await sleep(120);
    first.renewAll('worker-1');
    await sleep(120);

    // 240 ms since claim (past the TTL), 120 ms since renewal (inside it).
    const result = newManager(200).tryAcquire(['src/a.ts'], 'worker-2');
    expect(result.granted).toBe(false);
    expect(result.conflicts[0]?.heldBy).toBe('worker-1');
  });
});

describe('MessageBox persistence', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  test('a message sent before a restart is consumed exactly once afterwards', () => {
    const id = new MessageBox(db).send('worker-1', 'planner', 'rebase first', 'directive', 'warning');

    const restored = new MessageBox(db);
    expect(restored.getUnreadCount('worker-1')).toBe(1);
    const updates = restored.consume('worker-1');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: 'directive',
      from: 'planner',
      summary: 'rebase first',
      data: { messageId: id, priority: 'warning' },
    });

    expect(restored.consume('worker-1')).toEqual([]);
    expect(new MessageBox(db).consume('worker-1')).toEqual([]);
    expect(db.query('SELECT read FROM cluster_messages WHERE id = ?').get(id)).toEqual({ read: 1 });
  });

  test('messages for other workers stay unread and in order', () => {
    const box = new MessageBox(db);
    box.send('worker-1', 'hub', 'first');
    box.send('worker-2', 'hub', 'for someone else');
    box.send('worker-1', 'hub', 'second');

    const restored = new MessageBox(db);
    expect(restored.consume('worker-1').map((u) => u.summary)).toEqual(['first', 'second']);
    expect(restored.getUnreadCount('worker-2')).toBe(1);
    expect(new MessageBox(db).getUnreadDirectives('worker-2')).toEqual([]);
    expect(new MessageBox(db).consume('worker-2').map((u) => u.summary)).toEqual(['for someone else']);
  });

  test('cleanup deletes old read messages and keeps old unread ones', () => {
    const box = new MessageBox(db);
    const consumed = box.send('worker-1', 'hub', 'already read');
    const pending = box.send('worker-2', 'hub', 'still waiting');
    const fresh = box.send('worker-1', 'hub', 'read just now');
    box.consume('worker-1');

    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    db.query('UPDATE cluster_messages SET createdAt = ? WHERE id IN (?, ?)').run(twoHoursAgo, consumed, pending);

    box.cleanup();

    const remaining = (db.query('SELECT id FROM cluster_messages ORDER BY createdAt').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(remaining).toEqual([pending, fresh]);
    expect(new MessageBox(db).consume('worker-2').map((u) => u.summary)).toEqual(['still waiting']);
  });
});
