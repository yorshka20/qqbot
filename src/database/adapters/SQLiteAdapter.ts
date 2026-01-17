// SQLite database adapter implementation

import { logger } from '@/utils/logger';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DatabaseAdapter } from '../base/DatabaseAdapter';
import type {
  BaseModel,
  Command,
  Conversation,
  ConversationConfig,
  DatabaseModel,
  Message,
  ModelAccessor,
  Session,
  Task,
} from '../models/types';

/**
 * SQLite model accessor implementation
 */
class SQLiteModelAccessor<T extends BaseModel> implements ModelAccessor<T> {
  constructor(
    private db: Database,
    private tableName: string,
  ) { }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const now = new Date();
    const id = randomUUID();
    const record = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    } as T;

    const keys = Object.keys(record).filter((k) => k !== 'id' && k !== 'createdAt' && k !== 'updatedAt');
    const placeholders = keys.map(() => '?').join(', ');
    const values: (string | number | bigint | boolean | null)[] = keys.map((k) => {
      const value = (record as Record<string, unknown>)[k];
      if (value === null || value === undefined) {
        return null;
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value as string | number | bigint | boolean;
    });

    const sql = `INSERT INTO ${this.tableName} (id, ${keys.join(', ')}, createdAt, updatedAt) VALUES (?, ${placeholders}, ?, ?)`;
    const stmt = this.db.query(sql);
    stmt.run(id, ...values, now.toISOString(), now.toISOString());

    return record;
  }

  async findById(id: string): Promise<T | null> {
    const stmt = this.db.query(`SELECT * FROM ${this.tableName} WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return this.deserialize(row) as T;
  }

  async find(criteria: Partial<T>): Promise<T[]> {
    const conditions: string[] = [];
    const values: (string | number | bigint | boolean | null)[] = [];

    for (const [key, value] of Object.entries(criteria)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        if (value === null) {
          values.push(null);
        } else if (typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value as string | number | bigint | boolean);
        }
      }
    }

    const sql =
      conditions.length > 0
        ? `SELECT * FROM ${this.tableName} WHERE ${conditions.join(' AND ')}`
        : `SELECT * FROM ${this.tableName}`;

    const stmt = this.db.query(sql);
    const rows = (conditions.length > 0 ? stmt.all(...values) : stmt.all()) as Record<string, unknown>[];
    return rows.map((row) => this.deserialize(row) as T);
  }

  async findOne(criteria: Partial<T>): Promise<T | null> {
    const results = await this.find(criteria);
    return results[0] || null;
  }

  async update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Record with id ${id} not found`);
    }

    const updates: string[] = [];
    const values: (string | number | bigint | boolean | null)[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (key !== 'id' && key !== 'createdAt' && value !== undefined) {
        updates.push(`${key} = ?`);
        if (value === null) {
          values.push(null);
        } else if (typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value as string | number | bigint | boolean);
        }
      }
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE ${this.tableName} SET ${updates.join(', ')} WHERE id = ?`;
    const stmt = this.db.query(sql);
    stmt.run(...values);

    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<boolean> {
    const stmt = this.db.query(`DELETE FROM ${this.tableName} WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  async count(criteria?: Partial<T>): Promise<number> {
    if (!criteria || Object.keys(criteria).length === 0) {
      const stmt = this.db.query(`SELECT COUNT(*) as count FROM ${this.tableName}`);
      const row = stmt.get() as { count: number };
      return row.count;
    }

    const conditions: string[] = [];
    const values: (string | number | bigint | boolean | null)[] = [];

    for (const [key, value] of Object.entries(criteria)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        if (value === null) {
          values.push(null);
        } else if (typeof value === 'object') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value as string | number | bigint | boolean);
        }
      }
    }

    const sql = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE ${conditions.join(' AND ')}`;
    const stmt = this.db.query(sql);
    const row = stmt.get(...values) as { count: number };
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
    const jsonFields = ['metadata', 'context', 'parameters', 'result', 'args', 'rawContent', 'config'];
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
  private db: Database | null = null;
  private models: DatabaseModel | null = null;

  constructor(private dbPath: string) { }

  async connect(): Promise<void> {
    if (this.db) {
      logger.warn('[SQLiteAdapter] Already connected');
      return;
    }

    try {
      // Resolve the database path (handle both relative and absolute paths)
      const resolvedPath = resolve(this.dbPath);
      const dbDir = dirname(resolvedPath);

      // Ensure the directory exists
      try {
        await stat(dbDir);
      } catch {
        // Directory doesn't exist, create it
        await mkdir(dbDir, { recursive: true });
        logger.info(`[SQLiteAdapter] Created database directory: ${dbDir}`);
      }

      // Create or open the database
      this.db = new Database(resolvedPath);
      this.db.run('PRAGMA journal_mode = WAL'); // Enable WAL mode for better concurrency
      this.db.run('PRAGMA foreign_keys = ON'); // Enable foreign key constraints

      logger.info(`[SQLiteAdapter] Connected to database: ${resolvedPath}`);

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

    // Create tables - execute each statement separately for bun:sqlite compatibility
    const statements = [
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionType TEXT NOT NULL CHECK(sessionType IN ('user', 'group')),
        messageCount INTEGER NOT NULL DEFAULT 0,
        lastMessageAt TEXT NOT NULL,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
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
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionType TEXT NOT NULL CHECK(sessionType IN ('user', 'group')),
        context TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
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
      )`,
      `CREATE TABLE IF NOT EXISTS commands (
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
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_configs (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        sessionType TEXT NOT NULL CHECK(sessionType IN ('user', 'group')),
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(sessionId, sessionType)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_userId ON messages(userId)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_conversationId ON tasks(conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
      `CREATE INDEX IF NOT EXISTS idx_commands_conversationId ON commands(conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_conversation_configs_session ON conversation_configs(sessionId, sessionType)`,
    ];

    for (const statement of statements) {
      this.db.run(statement);
    }

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

    // bun:sqlite transactions are synchronous, but we need to handle async operations
    // We manually manage the transaction using BEGIN/COMMIT/ROLLBACK
    try {
      this.db.run('BEGIN TRANSACTION');
      const result = await fn();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
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
      conversationConfigs: new SQLiteModelAccessor<ConversationConfig>(this.db, 'conversation_configs'),
    };
  }
}
