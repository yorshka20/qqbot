// Database manager - creates and manages database adapter instance

import type { DatabaseAdapter } from './base/DatabaseAdapter';
import { SQLiteAdapter } from './adapters/SQLiteAdapter';
import { MongoDBAdapter } from './adapters/MongoDBAdapter';
import type { DatabaseConfig } from '@/core/Config';
import { logger } from '@/utils/logger';

export class DatabaseManager {
  private adapter: DatabaseAdapter | null = null;

  async initialize(config: DatabaseConfig): Promise<void> {
    if (this.adapter) {
      logger.warn('[DatabaseManager] Database already initialized');
      return;
    }

    logger.info(`[DatabaseManager] Initializing database: ${config.type}`);

    switch (config.type) {
      case 'sqlite': {
        if (!config.sqlite) {
          throw new Error('SQLite config is required when type is sqlite');
        }
        this.adapter = new SQLiteAdapter(config.sqlite.path);
        break;
      }
      case 'mongodb': {
        if (!config.mongodb) {
          throw new Error('MongoDB config is required when type is mongodb');
        }
        // Build connection string if options provided
        let connectionString = config.mongodb.connectionString;
        if (config.mongodb.options?.user && config.mongodb.options?.password) {
          const url = new URL(connectionString);
          url.username = config.mongodb.options.user;
          url.password = config.mongodb.options.password;
          if (config.mongodb.options.authSource) {
            url.searchParams.set('authSource', config.mongodb.options.authSource);
          }
          connectionString = url.toString();
        }
        this.adapter = new MongoDBAdapter(connectionString, config.mongodb.database);
        break;
      }
      default:
        throw new Error(`Unsupported database type: ${config.type}`);
    }

    await this.adapter.connect();
    await this.adapter.migrate();

    logger.info('[DatabaseManager] Database initialized successfully');
  }

  getAdapter(): DatabaseAdapter {
    if (!this.adapter) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.adapter;
  }

  async close(): Promise<void> {
    if (this.adapter) {
      await this.adapter.disconnect();
      this.adapter = null;
      logger.info('[DatabaseManager] Database closed');
    }
  }

  isInitialized(): boolean {
    return this.adapter !== null;
  }
}
