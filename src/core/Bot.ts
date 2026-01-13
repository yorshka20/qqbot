// Main bot orchestrator class

import { logger, setLogLevel } from '@/utils/logger';
import { EventEmitter } from 'events';
import { Config } from './config';
import { ConnectionManager } from './ConnectionManager';

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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 30000; // 30 seconds default

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

      // Start heartbeat to keep connections alive
      this.startHeartbeat();

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

    // Stop heartbeat
    this.stopHeartbeat();

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

  /**
   * Start heartbeat to keep WebSocket connections alive
   * Sends a lightweight ping message to all connected protocols periodically
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      logger.warn('[Bot] Heartbeat is already running');
      return;
    }

    logger.info(`[Bot] Starting heartbeat with interval ${this.heartbeatIntervalMs}ms`);

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.info('[Bot] Heartbeat stopped');
    }
  }

  /**
   * Send heartbeat (WebSocket ping) to all connected protocols
   * Uses native WebSocket ping frame to keep connection alive
   */
  private sendHeartbeat(): void {
    const connections = this.connectionManager.getConnections();

    if (connections.size === 0) {
      logger.debug('[Bot] No connections available for heartbeat');
      return;
    }

    let sentCount = 0;
    for (const [protocolName, connection] of connections) {
      if (connection.getState() !== 'connected') {
        logger.debug(`[Bot] Skipping heartbeat for ${protocolName} (state: ${connection.getState()})`);
        continue;
      }

      try {
        // Use native WebSocket ping frame
        connection.ping();
        sentCount++;
        logger.info(`[Bot] Heartbeat (ping) sent to ${protocolName}`);
      } catch (error) {
        // Log error but don't throw - heartbeat failure shouldn't crash the bot
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`[Bot] Failed to send heartbeat to ${protocolName}: ${err.message}`);
      }
    }

    if (sentCount === 0) {
      logger.warn('[Bot] No heartbeats sent - no connected protocols');
    }
  }
}
