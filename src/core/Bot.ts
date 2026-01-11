// Main bot orchestrator class

import { EventEmitter } from 'events';
import { Config } from './Config';
import { ConnectionManager } from './ConnectionManager';
import { setLogLevel } from '@/utils/logger';
import { logger } from '@/utils/logger';

export interface BotEvents {
  ready: () => void;
  error: (error: Error) => void;
}

export declare interface Bot {
  on<U extends keyof BotEvents>(event: U, listener: BotEvents[U]): this;
  emit<U extends keyof BotEvents>(event: U, ...args: Parameters<BotEvents[U]>): boolean;
}

export class Bot extends EventEmitter {
  private config: Config;
  private connectionManager: ConnectionManager;
  private isRunning = false;

  constructor(configPath?: string) {
    super();
    this.config = new Config(configPath);
    
    // Initialize logger with config log level
    setLogLevel(this.config.getLogLevel());
    
    this.connectionManager = new ConnectionManager(this.config);
    this.setupConnectionManagerEvents();
  }

  getConfig(): Config {
    return this.config;
  }

  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[Bot] Bot is already running');
      return;
    }

    logger.info('[Bot] Starting bot...');
    this.isRunning = true;

    try {
      // Connect to all enabled protocols
      await this.connectionManager.connectAll();
      
      // Wait for all connections to be established
      await this.waitForConnections();
      
      logger.info('[Bot] Bot started successfully');
      this.emit('ready');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[Bot] Failed to start bot:', err);
      this.emit('error', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('[Bot] Bot is not running');
      return;
    }

    logger.info('[Bot] Stopping bot...');
    this.isRunning = false;

    try {
      this.connectionManager.disconnectAll();
      logger.info('[Bot] Bot stopped successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[Bot] Error stopping bot:', err);
      throw err;
    }
  }

  isBotRunning(): boolean {
    return this.isRunning;
  }

  private setupConnectionManagerEvents(): void {
    this.connectionManager.on('allConnected', () => {
      logger.info('[Bot] All protocol connections established');
    });

    this.connectionManager.on('allDisconnected', () => {
      logger.warn('[Bot] All protocol connections lost');
    });

    this.connectionManager.on('connectionError', (protocol, error) => {
      logger.error(`[Bot] Connection error for protocol ${protocol}:`, error);
      this.emit('error', error);
    });
  }

  private async waitForConnections(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for connections'));
      }, 30000); // 30 second timeout

      if (this.connectionManager.isAllConnected()) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.connectionManager.once('allConnected', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
