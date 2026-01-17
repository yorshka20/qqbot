// MongoDB database adapter implementation

import { logger } from '@/utils/logger';
import { randomUUID } from 'crypto';
import { Collection, Db, MongoClient } from 'mongodb';
import type { DatabaseAdapter } from '../base/DatabaseAdapter';
import type {
  BaseModel,
  Command,
  Conversation,
  DatabaseModel,
  Message,
  ModelAccessor,
  Session,
  Task,
} from '../models/types';

/**
 * MongoDB model accessor implementation
 */
class MongoModelAccessor<T extends BaseModel> implements ModelAccessor<T> {
  constructor(private collection: Collection) { }

  async create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T> {
    const now = new Date();
    const id = randomUUID();
    const record = {
      ...data,
      _id: id,
      id,
      createdAt: now,
      updatedAt: now,
    } as T & { _id: string };

    await this.collection.insertOne(record as unknown as Record<string, unknown>);
    return record;
  }

  async findById(id: string): Promise<T | null> {
    const doc = await this.collection.findOne({ id });
    if (!doc) {
      return null;
    }
    return this.deserialize(doc) as T;
  }

  async find(criteria: Partial<T>): Promise<T[]> {
    const docs = await this.collection.find(criteria).toArray();
    return docs.map((doc) => this.deserialize(doc) as T);
  }

  async findOne(criteria: Partial<T>): Promise<T | null> {
    const doc = await this.collection.findOne(criteria);
    if (!doc) {
      return null;
    }
    return this.deserialize(doc) as T;
  }

  async update(id: string, data: Partial<Omit<T, 'id' | 'createdAt'>>): Promise<T> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Record with id ${id} not found`);
    }

    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    await this.collection.updateOne({ id }, { $set: updateData });
    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  async count(criteria?: Partial<T>): Promise<number> {
    const filter = criteria || {};
    return await this.collection.countDocuments(filter);
  }

  private deserialize(doc: Record<string, unknown>): T {
    const result = { ...doc } as Record<string, unknown>;

    // Remove MongoDB _id if present, use id instead
    if (result._id && !result.id) {
      result.id = result._id;
    }
    delete result._id;

    // Ensure dates are Date objects
    if (result.createdAt && !(result.createdAt instanceof Date)) {
      result.createdAt = new Date(result.createdAt as string);
    }
    if (result.updatedAt && !(result.updatedAt instanceof Date)) {
      result.updatedAt = new Date(result.updatedAt as string);
    }
    if (result.lastMessageAt && !(result.lastMessageAt instanceof Date)) {
      result.lastMessageAt = new Date(result.lastMessageAt as string);
    }

    return result as T;
  }
}

/**
 * MongoDB database adapter
 */
export class MongoDBAdapter implements DatabaseAdapter {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private models: DatabaseModel | null = null;

  constructor(
    private connectionString: string,
    private databaseName: string,
  ) { }

  async connect(): Promise<void> {
    if (this.client) {
      logger.warn('[MongoDBAdapter] Already connected');
      return;
    }

    try {
      this.client = new MongoClient(this.connectionString);
      await this.client.connect();
      this.db = this.client.db(this.databaseName);

      logger.info(`[MongoDBAdapter] Connected to database: ${this.databaseName}`);

      // Initialize models
      this.models = this.createModels();
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MongoDBAdapter] Failed to connect:', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.close();
    this.client = null;
    this.db = null;
    this.models = null;
    logger.info('[MongoDBAdapter] Disconnected from database');
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null;
  }

  async migrate(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    logger.info('[MongoDBAdapter] Running migrations...');

    // Create indexes for better query performance
    const collections = {
      conversations: this.db.collection('conversations'),
      messages: this.db.collection('messages'),
      sessions: this.db.collection('sessions'),
      tasks: this.db.collection('tasks'),
      commands: this.db.collection('commands'),
    };

    // Create indexes
    await collections.conversations.createIndex({ sessionId: 1, sessionType: 1 });
    await collections.conversations.createIndex({ lastMessageAt: -1 });

    await collections.messages.createIndex({ conversationId: 1 });
    await collections.messages.createIndex({ userId: 1 });
    await collections.messages.createIndex({ createdAt: -1 });

    await collections.sessions.createIndex({ sessionId: 1, sessionType: 1 });

    await collections.tasks.createIndex({ conversationId: 1 });
    await collections.tasks.createIndex({ status: 1 });
    await collections.tasks.createIndex({ createdAt: -1 });

    await collections.commands.createIndex({ conversationId: 1 });
    await collections.commands.createIndex({ userId: 1 });

    logger.info('[MongoDBAdapter] Migrations completed');
  }

  getModel<T extends keyof DatabaseModel>(modelName: T): DatabaseModel[T] {
    if (!this.models) {
      throw new Error('Database not connected');
    }
    return this.models[modelName];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.client || !this.db) {
      throw new Error('Database not connected');
    }

    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        return await fn();
      });
    } finally {
      await session.endSession();
    }
  }

  private createModels(): DatabaseModel {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    return {
      conversations: new MongoModelAccessor<Conversation>(this.db.collection('conversations')),
      messages: new MongoModelAccessor<Message>(this.db.collection('messages')),
      sessions: new MongoModelAccessor<Session>(this.db.collection('sessions')),
      tasks: new MongoModelAccessor<Task>(this.db.collection('tasks')),
      commands: new MongoModelAccessor<Command>(this.db.collection('commands')),
    };
  }
}
