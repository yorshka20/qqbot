// Configuration management - main entry point

import { existsSync, readFileSync } from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { extname, resolve } from 'path';
import { ConfigError } from '@/utils/errors';
// Import all config types
import type { AIConfig, AIProviderCapability, ContextMemoryConfig, SessionProviderConfig } from './types/ai';
import type { BotSelfConfig, FileReadServiceConfig, StaticServerConfig } from './types/bot';
import type { DatabaseConfig } from './types/database';
import type { MCPConfig } from './types/mcp';
import type { MemoryConfig } from './types/memory';
import type { PluginsConfig } from './types/plugins';
import type { PromptsConfig } from './types/prompts';
import type { APIConfig, EventConfig, ProtocolConfig, ProtocolName } from './types/protocol';
import type { RAGConfig } from './types/rag';
import type { TTSConfig } from './types/tts';

// Re-export runtime/conversation config (merged from former src/config)
export { ConversationConfigService, type SessionType } from '../../conversation/ConversationConfigService';
export { updateEnabledDisabled } from './ConfigUtils';
export { GlobalConfigManager } from './GlobalConfigManager';
export { getSessionId, getSessionType } from './SessionUtils';
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
} from './types/ai';
export type { BotSelfConfig, StaticServerConfig } from './types/bot';
export type { LogLevel } from './types/const';
export type { DatabaseConfig, DatabaseType, MongoDBConfig, SQLiteConfig } from './types/database';
export type {
  MCPConfig,
  MCPServerConfig,
  ProxyConfig,
  SearchConfig,
  SearchFetchConfig,
  SearchMode,
  SearXNGConfig,
  TriggerStrategy,
} from './types/mcp';
export type { MemoryConfig } from './types/memory';
export type { PluginsConfig } from './types/plugins';
export type { PromptsConfig } from './types/prompts';
export type {
  APIConfig,
  EventDeduplicationConfig,
  ProtocolConfig,
  ProtocolConnectionConfig,
  ProtocolName,
  ReconnectConfig,
} from './types/protocol';
export type { RAGConfig } from './types/rag';
export type { TTSConfig } from './types/tts';

export interface BotConfig {
  protocols: ProtocolConfig[];
  api: APIConfig;
  events: EventConfig;
  bot: BotSelfConfig;
  plugins: PluginsConfig;
  database: DatabaseConfig;
  ai?: AIConfig;
  contextMemory?: ContextMemoryConfig;
  memory?: MemoryConfig;
  prompts: PromptsConfig;
  tts?: TTSConfig;
  mcp?: MCPConfig;
  rag?: RAGConfig;
  staticServer?: StaticServerConfig;
  fileReadService?: FileReadServiceConfig;
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

  /**
   * Bot's own QQ user id as number for API use (e.g. forward message).
   * Parsed from config.bot.selfId; undefined if missing or invalid.
   */
  getBotUserId(): number | undefined {
    const raw = this.config?.bot?.selfId;
    if (raw == null || raw === '') {
      return undefined;
    }
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (Number.isNaN(n) || n <= 0) {
      return undefined;
    }
    return n;
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
   * Whether to use native tool use for reply generation (default: true).
   */
  getUseToolUse(): boolean {
    return this.config.ai?.useToolUse !== false;
  }

  /**
   * Get default provider name for a capability
   */
  getDefaultProviderName(capability: AIProviderCapability): string | undefined {
    const aiConfig = this.config.ai;
    if (!aiConfig) {
      return undefined;
    }

    if (aiConfig.defaultProviders) {
      return aiConfig.defaultProviders[capability];
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

  getMemoryConfig(): MemoryConfig {
    return {
      dir: this.config.memory?.dir ?? 'data/memory',
    };
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

  getMCPConfig(): MCPConfig | undefined {
    return this.config.mcp;
  }

  getRAGConfig(): RAGConfig | undefined {
    return this.config.rag;
  }

  getStaticServerConfig(): StaticServerConfig | undefined {
    return this.config.staticServer;
  }

  getFileReadServiceConfig(): FileReadServiceConfig | undefined {
    return this.config.fileReadService;
  }
}
