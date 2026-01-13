// Configuration management - main entry point

import { ConfigError } from '@/utils/errors';
import { existsSync, readFileSync } from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { extname, resolve } from 'path';

// Import all config types
import type { AIConfig, ContextMemoryConfig, SessionProviderConfig } from './ai';
import type { BotSelfConfig } from './bot';
import type { DatabaseConfig } from './database';
import type { PluginsConfig } from './plugins';
import type { PromptsConfig } from './prompts';
import type { APIConfig, EventConfig, ProtocolConfig, ProtocolName } from './protocol';
import type { TTSConfig } from './tts';
import type { LogLevel } from './types';

// Re-export all types for convenience
export type {
  AIConfig,
  AIProviderConfig,
  AIProviderType,
  AnthropicProviderConfig,
  AutoSwitchConfig,
  ContextMemoryConfig,
  DeepSeekProviderConfig,
  DefaultProvidersConfig,
  LocalText2ImageProviderConfig,
  NovelAIProviderConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  SessionProviderConfig,
} from './ai';
export type { BotSelfConfig } from './bot';
export type { DatabaseConfig, DatabaseType, MongoDBConfig, SQLiteConfig } from './database';
export type { PluginsConfig } from './plugins';
export type { PromptsConfig } from './prompts';
export type {
  APIConfig,
  EventDeduplicationConfig,
  ProtocolConfig,
  ProtocolConnectionConfig,
  ProtocolName,
  ReconnectConfig,
} from './protocol';
export type { TTSConfig } from './tts';
export type { LogLevel } from './types';

export interface BotConfig {
  protocols: ProtocolConfig[];
  api: APIConfig;
  events: EventConfig;
  bot: BotSelfConfig;
  plugins: PluginsConfig;
  database: DatabaseConfig;
  ai?: AIConfig;
  contextMemory?: ContextMemoryConfig;
  prompts: PromptsConfig;
  tts?: TTSConfig;
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
        throw new ConfigError(`Config file not found at specified path: ${configPath} (resolved: ${resolved})`);
      }
      // Validate file extension
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.jsonc') {
        throw new ConfigError(`Config file must have .jsonc extension. Found: ${ext} at ${resolved}`);
      }
      return resolved;
    }

    // Check CONFIG_PATH environment variable
    const envConfigPath = process.env.CONFIG_PATH;
    if (envConfigPath) {
      const resolved = resolve(envConfigPath);
      if (!existsSync(resolved)) {
        throw new ConfigError(`Config file not found at CONFIG_PATH: ${envConfigPath} (resolved: ${resolved})`);
      }
      // Validate file extension
      const ext = extname(resolved).toLowerCase();
      if (ext !== '.jsonc') {
        throw new ConfigError(`Config file must have .jsonc extension. Found: ${ext} at ${resolved}`);
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
        const errorMessages = parseErrors.map((err) => `Error ${err.error} at offset ${err.offset}`);
        throw new ConfigError(`JSONC parse errors in ${configPath}: ${errorMessages.join(', ')}`);
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
        throw new ConfigError(`Invalid JSONC in config file ${configPath}: ${error.message}`);
      }
      if (error instanceof Error) {
        throw new ConfigError(`Failed to read config file ${configPath}: ${error.message}`);
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
        throw new ConfigError(`Protocol ${protocol.name} must have connection.url and connection.apiUrl`);
      }
    }
  }

  getConfig(): BotConfig {
    return this.config;
  }

  getEnabledProtocols(): ProtocolConfig[] {
    return this.config.protocols.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
  }

  getProtocolConfig(name: ProtocolName): ProtocolConfig | undefined {
    return this.config.protocols.find((p) => p.name === name);
  }

  getAPIConfig(): APIConfig {
    return this.config.api;
  }

  getEventConfig(): EventConfig {
    return this.config.events;
  }

  getLogLevel(): LogLevel {
    return this.config.bot.logLevel;
  }

  getPluginsConfig() {
    return this.config.plugins;
  }

  /**
   * Get plugin config by name
   */
  getPluginConfig(pluginName: string): any | undefined {
    const plugin = this.config.plugins.list.find((p) => p.name === pluginName);
    return plugin?.config;
  }

  /**
   * Get enabled plugin names
   */
  getEnabledPluginNames(): string[] {
    return this.config.plugins.list.filter((p) => p.enabled).map((p) => p.name);
  }

  getDatabaseConfig(): DatabaseConfig {
    if (!this.config.database) {
      throw new ConfigError('Database configuration is required. Please set "database" in config file.');
    }
    return this.config.database;
  }

  getAIConfig(): AIConfig | undefined {
    return this.config.ai;
  }

  /**
   * Get default provider name for a capability
   * Supports both new defaultProviders structure and legacy provider field
   */
  getDefaultProviderName(capability: 'llm' | 'vision' | 'text2img' | 'img2img'): string | undefined {
    const aiConfig = this.config.ai;
    if (!aiConfig) {
      return undefined;
    }

    // Try new structure first
    if (aiConfig.defaultProviders) {
      return aiConfig.defaultProviders[capability];
    }

    // Fall back to legacy provider field for LLM
    if (capability === 'llm' && aiConfig.provider) {
      return aiConfig.provider;
    }

    return undefined;
  }

  /**
   * Get session-level provider configuration
   */
  getSessionProviderConfig(sessionId: string): SessionProviderConfig | undefined {
    const aiConfig = this.config.ai;
    if (!aiConfig || !aiConfig.sessionProviders) {
      return undefined;
    }

    return aiConfig.sessionProviders[sessionId];
  }

  getContextMemoryConfig(): ContextMemoryConfig | undefined {
    return this.config.contextMemory;
  }

  getPromptsConfig(): PromptsConfig {
    if (!this.config.prompts) {
      throw new ConfigError('Prompts configuration is required. Please set "prompts" in config file.');
    }
    return this.config.prompts;
  }

  getTTSConfig(): TTSConfig | undefined {
    return this.config.tts;
  }
}
