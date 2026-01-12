// Configuration management

import { ConfigError } from '@/utils/errors';
import { existsSync, readFileSync } from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { extname, resolve } from 'path';

export type ProtocolName = 'milky' | 'onebot11' | 'satori';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type BackoffStrategy = 'exponential' | 'linear';
export type APIStrategy = 'priority' | 'round-robin' | 'capability-based';
export type DeduplicationStrategy = 'first-received' | 'priority-protocol' | 'merge';

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

export type DatabaseType = 'sqlite' | 'mongodb';

export interface SQLiteConfig {
  path: string;
}

export interface MongoDBConfig {
  connectionString: string;
  database: string;
  options?: {
    authSource?: string;
    user?: string;
    password?: string;
  };
}

export interface DatabaseConfig {
  type: DatabaseType;
  sqlite?: SQLiteConfig;
  mongodb?: MongoDBConfig;
}

export type AIProviderType = 'openai' | 'anthropic' | 'ollama' | 'deepseek';

export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  model?: string; // claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.
  temperature?: number;
  maxTokens?: number;
}

export interface OllamaProviderConfig {
  type: 'ollama';
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface DeepSeekProviderConfig {
  type: 'deepseek';
  apiKey: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export type AIProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | OllamaProviderConfig
  | DeepSeekProviderConfig;

/**
 * Default providers configuration (by capability)
 */
export interface DefaultProvidersConfig {
  llm?: string; // Default LLM provider name
  vision?: string; // Default vision/multimodal provider name
  text2img?: string; // Default text-to-image provider name
  img2img?: string; // Default image-to-image provider name
}

/**
 * Session-level provider override configuration
 */
export interface SessionProviderConfig {
  llm?: string;
  vision?: string;
  text2img?: string;
  img2img?: string;
}

/**
 * Auto-switch configuration
 */
export interface AutoSwitchConfig {
  // Automatically switch to vision provider when message contains images
  // but current provider doesn't support vision
  enableVisionFallback?: boolean;
}

export interface AIConfig {
  // Default providers by capability (replaces single "provider" field)
  defaultProviders?: DefaultProvidersConfig;
  // Legacy: single provider name (for backward compatibility)
  provider?: string;
  // Provider configurations
  providers: Record<string, AIProviderConfig>;
  // Session-level provider overrides (key is sessionId)
  sessionProviders?: Record<string, SessionProviderConfig>;
  // Auto-switch configuration
  autoSwitch?: AutoSwitchConfig;
}

export interface ContextMemoryConfig {
  // Maximum number of messages to store in memory buffer
  maxBufferSize?: number;
  // Whether to use summary memory (requires AI manager)
  useSummary?: boolean;
  // Threshold for triggering summary (number of messages)
  summaryThreshold?: number;
  // Maximum number of history messages to include in AI prompt
  maxHistoryMessages?: number;
}

export interface BotSelfConfig {
  selfId: string;
  logLevel: LogLevel;
  // Bot owner: highest permission level, can use all commands
  owner: string;
  // Bot admins: user IDs that have admin permission level
  // These users can adjust bot behavior and trigger special commands
  admins: string[];
}

export interface PluginsConfig {
  list: Array<{
    name: string;
    enabled: boolean;
    config?: any; // Each plugin has its own config structure
  }>;
}

export interface PromptsConfig {
  // Directory path for prompt templates (relative to project root or absolute path)
  directory: string;
}

export interface BotConfig {
  protocols: ProtocolConfig[];
  api: APIConfig;
  events: {
    deduplication: EventDeduplicationConfig;
  };
  bot: BotSelfConfig;
  plugins: PluginsConfig;
  database: DatabaseConfig;
  ai?: AIConfig;
  contextMemory?: ContextMemoryConfig;
  prompts: PromptsConfig;
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

  getEventDeduplicationConfig(): EventDeduplicationConfig {
    return this.config.events.deduplication;
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
}
