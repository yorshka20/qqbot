// Database adapter abstract interface

import type { DatabaseModel } from '../models/types';

/**
 * Abstract database adapter interface
 * Provides unified interface for different database implementations
 */
export interface DatabaseAdapter {
  /**
   * Connect to database
   */
  connect(): Promise<void>;

  /**
   * Disconnect from database
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Run database migrations
   */
  migrate(): Promise<void>;

  /**
   * Get model accessor
   */
  getModel<T extends keyof DatabaseModel>(modelName: T): DatabaseModel[T];

  /**
   * Execute transaction
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
