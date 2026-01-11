// SQLite database adapter implementation

import Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../base/DatabaseAdapter';
import type {
  DatabaseModel,
  BaseModel,
  Conversation,
  Message,
  Session,
  Task,
  Command,
  ModelAccessor,
} from '../models/types';
import { logger } from '@/utils/logger';
import { randomUUID } from 'crypto';

/**
 * SQLite model accessor implementation
 */
class SQLiteModelAccessor<T extends BaseModel> implements ModelAccessor<T> {
  constructor(
    private db: Database.Database,
    private tableName: string,
  ) {}

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const now = new Date();
    const id = randomUUID();
    const record = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    } as T;

    const keys = Object.keys(record).filter(
      (k) => k !== 'id' && k !== 'createdAt' && k !== 'updatedAt',
    );
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => {
      const value = (record as Record<string, unknown>)[k];
      return typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : value;
    });

    const sql = `INSERT INTO ${this.tableName} (id, ${keys.join(', ')}, createdAt, updatedAt) VALUES (?, ${placeholders}, ?, ?)`;
    this.db.prepare(sql).run(id, ...values, now.toISOString(), now.toISOString());

    return record;
  }

  async findById(id: string): Promise<T | null> {
    const row = this.db
      .prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return this.deserialize(row) as T;
  }

  async find(criteria: Partial<T>): Promise<T[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(criteria)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(
          typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
        );
      }
    }

    const sql =
      conditions.length > 0
        ? `SELECT * FROM ${this.tableName} WHERE ${conditions.join(' AND ')}`
        : `SELECT * FROM ${this.tableName}`;

    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.deserialize(row) as T);
  }

  async findOne(criteria: Partial<T>): Promise<T | null> {
    const results = await this.find(criteria);
    return results[0] || null;
  }

  async update(
    id: string,
    data: Partial<Omit<T, 'id' | 'createdAt'>>,
  ): Promise<T> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Record with id ${id} not found`);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (key !== 'id' && key !== 'createdAt' && value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(
          typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
        );
      }
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE ${this.tableName} SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db
      .prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  async count(criteria?: Partial<T>): Promise<number> {
    if (!criteria || Object.keys(criteria).length === 0) {
      const row = this.db
        .prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`)
        .get() as { count: number };
      return row.count;
    }

    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(criteria)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(
          typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
        );
      }
    }

    const sql = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE ${conditions.join(' AND ')}`;
    const row = this.db.prepare(sql).get(...values) as { count: number };
    return row.count;
  }

  private deserialize(row: Record<string, unknown>): T {
    const result = { ...row } as Record<string, unknown>;

    // Parse dates
    if (result.createdAt) {
      result.createdAt = new Date(result.createdAt as string);
    }
    if (result.updatedAt) {
      result.updatedAt = new Date(result.updatedAt as string);
    }
    if (result.lastMessageAt) {
      result.lastMessageAt = new Date(result.lastMessageAt as string);
    }

    // Parse JSON fields
    const jsonFields = ['metadata', 'context', 'parameters', 'result', 'args', 'rawContent'];
    for (const field of jsonFields) {
      if (result[field] && typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field] as string);
        } catch {
          // Keep as string if parsing fails
        }
      }
    }

    return result as T;
  }
}

/**
 * SQLite database adapter
 */
export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database | null = null;
  private models: DatabaseModel | null = null;

  constructor(private dbPath: string) {}

  async connect(): Promise<void> {
    if (this.db) {
      logger.warn('[SQLiteAdapter] Already connected');
      return;
    }

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL'); // Enable WAL mode for better concurrency
      this.db.pragma('foreign_keys = ON'); // Enable foreign key constraints

      logger.info(`[SQLiteAdapter] Connected to database: ${this.dbPath}`);

      // Initialize models
      this.models = this.createModels();
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[SQLiteAdapter] Failed to connect:', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
    this.models = null;
    logger.info('[SQLiteAdapter] Disconnected from database');
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  async migrate(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    logger.info('[SQLiteAdapter] Running migrations...');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionType TEXT NOT NULL CHECK(sessionType IN ('user', 'group')),
        messageCount INTEGER NOT NULL DEFAULT 0,
        lastMessageAt TEXT NOT NULL,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        userId INTEGER NOT NULL,
        messageType TEXT NOT NULL CHECK(messageType IN ('private', 'group')),
        groupId INTEGER,
        content TEXT NOT NULL,
        rawContent TEXT,
        protocol TEXT NOT NULL,
        messageId TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionType TEXT NOT NULL CHECK(sessionType IN ('user', 'group')),
        context TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        taskType TEXT NOT NULL,
        parameters TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
        result TEXT,
        error TEXT,
        executor TEXT NOT NULL,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES conversations(id),
        FOREIGN KEY (messageId) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        commandName TEXT NOT NULL,
        args TEXT NOT NULL,
        userId INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES conversations(id),
        FOREIGN KEY (messageId) REFERENCES messages(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId);
      CREATE INDEX IF NOT EXISTS idx_messages_userId ON messages(userId);
      CREATE INDEX IF NOT EXISTS idx_tasks_conversationId ON tasks(conversationId);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_commands_conversationId ON commands(conversationId);
    `);

    logger.info('[SQLiteAdapter] Migrations completed');
  }

  getModel<T extends keyof DatabaseModel>(modelName: T): DatabaseModel[T] {
    if (!this.models) {
      throw new Error('Database not connected');
    }
    return this.models[modelName];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    const transaction = this.db.transaction(() => {
      return fn();
    });

    return transaction();
  }

  private createModels(): DatabaseModel {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    return {
      conversations: new SQLiteModelAccessor<Conversation>(this.db, 'conversations'),
      messages: new SQLiteModelAccessor<Message>(this.db, 'messages'),
      sessions: new SQLiteModelAccessor<Session>(this.db, 'sessions'),
      tasks: new SQLiteModelAccessor<Task>(this.db, 'tasks'),
      commands: new SQLiteModelAccessor<Command>(this.db, 'commands'),
    };
  }
}
