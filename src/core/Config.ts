// Configuration management

import { ConfigError } from '@/utils/errors';
import { existsSync, readFileSync } from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { extname, resolve } from 'path';

export type ProtocolName = 'milky' | 'onebot11' | 'satori';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type BackoffStrategy = 'exponential' | 'linear';
export type APIStrategy = 'priority' | 'round-robin' | 'capability-based';
export type DeduplicationStrategy =
  | 'first-received'
  | 'priority-protocol'
  | 'merge';

export interface ProtocolConnectionConfig {
  url: string;
  apiUrl: string;
  accessToken: string;
}

export interface ReconnectConfig {
  enabled: boolean;
  maxRetries: number;
  backoff: BackoffStrategy;
  initialDelay: number;
  maxDelay: number;
}

export interface ProtocolConfig {
  name: ProtocolName;
  enabled: boolean;
  priority: number;
  connection: ProtocolConnectionConfig;
  reconnect: ReconnectConfig;
}

export interface APIConfig {
  strategy: APIStrategy;
  preferredProtocol?: ProtocolName;
}

export interface EventDeduplicationConfig {
  enabled: boolean;
  strategy: DeduplicationStrategy;
  window: number;
}

export interface BotConfig {
  protocols: ProtocolConfig[];
  api: APIConfig;
  events: {
    deduplication: EventDeduplicationConfig;
  };
  bot: {
    selfId: number | null;
    logLevel: LogLevel;
  };
  plugins: {
    enabled: string[];
    directory: string;
  };
}

export class Config {
  private config: BotConfig;

  constructor(configPath?: string) {
    try {
      const resolvedPath = this.resolveConfigPath(configPath);
      this.config = this.loadConfig(resolvedPath);
      this.validateConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new ConfigError(`Failed to load config: ${error.message}`);
      }
      throw new ConfigError('Failed to load config: Unknown error');
    }
  }

  private resolveConfigPath(configPath?: string): string {
    // Priority: 1. constructor argument, 2. CONFIG_PATH env var, 3. default location
    if (configPath) {
      const resolved = resolve(configPath);
      if (!existsSync(resolved)) {
        throw new ConfigError(
          `Config file not found at specified path: ${configPath} (resolved: ${resolved})`,
        );
      }
      // Validate file extension
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.jsonc') {
        throw new ConfigError(
          `Config file must have .jsonc extension. Found: ${ext} at ${resolved}`,
        );
      }
      return resolved;
    }

    // Check CONFIG_PATH environment variable
    const envConfigPath = process.env.CONFIG_PATH;
    if (envConfigPath) {
      const resolved = resolve(envConfigPath);
      if (!existsSync(resolved)) {
        throw new ConfigError(
          `Config file not found at CONFIG_PATH: ${envConfigPath} (resolved: ${resolved})`,
        );
      }
      // Validate file extension
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.jsonc') {
        throw new ConfigError(
          `Config file must have .jsonc extension. Found: ${ext} at ${resolved}`,
        );
      }
      return resolved;
    }

    // Try default location (project root) - only .jsonc
    const defaultPath = resolve(process.cwd(), 'config.jsonc');

    if (existsSync(defaultPath)) {
      return defaultPath;
    }

    // No config file found
    throw new ConfigError(
      `Config file not found. Please provide a config.jsonc file via:\n` +
        `  1. Config constructor argument: new Config('/path/to/config.jsonc')\n` +
        `  2. CONFIG_PATH environment variable: CONFIG_PATH=/path/to/config.jsonc\n` +
        `  3. Place config.jsonc in project root: ${defaultPath}\n` +
        `  You can copy config.example.json to config.jsonc as a starting point.`,
    );
  }

  private loadConfig(configPath: string): BotConfig {
    try {
      const configContent = readFileSync(configPath, 'utf-8');

      // Parse JSONC (JSON with Comments)
      const parseErrors: Array<{
        error: number;
        offset: number;
        length: number;
      }> = [];
      const config = parseJsonc(configContent, parseErrors) as BotConfig;

      if (parseErrors.length > 0) {
        const errorMessages = parseErrors.map(
          (err) => `Error ${err.error} at offset ${err.offset}`,
        );
        throw new ConfigError(
          `JSONC parse errors in ${configPath}: ${errorMessages.join(', ')}`,
        );
      }

      // Validate that config has required structure
      if (!config || typeof config !== 'object') {
        throw new ConfigError('Config file must contain a valid JSON object');
      }

      return config;
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new ConfigError(
          `Invalid JSONC in config file ${configPath}: ${error.message}`,
        );
      }
      if (error instanceof Error) {
        throw new ConfigError(
          `Failed to read config file ${configPath}: ${error.message}`,
        );
      }
      throw new ConfigError(`Failed to load config file ${configPath}`);
    }
  }

  private validateConfig(): void {
    if (!Array.isArray(this.config.protocols)) {
      throw new ConfigError('protocols must be an array');
    }

    const enabledProtocols = this.config.protocols.filter((p) => p.enabled);
    if (enabledProtocols.length === 0) {
      throw new ConfigError('At least one protocol must be enabled');
    }

    // Validate each protocol config
    for (const protocol of this.config.protocols) {
      if (!protocol.connection.url || !protocol.connection.apiUrl) {
        throw new ConfigError(
          `Protocol ${protocol.name} must have connection.url and connection.apiUrl`,
        );
      }
    }
  }

  getConfig(): BotConfig {
    return this.config;
  }

  getEnabledProtocols(): ProtocolConfig[] {
    return this.config.protocols
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  getProtocolConfig(name: ProtocolName): ProtocolConfig | undefined {
    return this.config.protocols.find((p) => p.name === name);
  }

  getAPIConfig(): APIConfig {
    return this.config.api;
  }

  getEventDeduplicationConfig(): EventDeduplicationConfig {
    return this.config.events.deduplication;
  }

  getLogLevel(): LogLevel {
    return this.config.bot.logLevel;
  }

  getPluginsConfig() {
    return this.config.plugins;
  }
}
