// Configuration management - main entry point

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { LanRelayConfig } from './types/lanRelay';
import { ConfigError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { loadConfigAuto } from './loadConfigDir';
// Import all config types
import type { AIConfig, AIProviderCapability, ContextMemoryConfig, SessionProviderConfig } from './types/ai';
import type { BotSelfConfig, ClaudeCodeServiceConfig, FileReadServiceConfig, StaticServerConfig } from './types/bot';
import type { DatabaseConfig } from './types/database';
import type { MCPConfig } from './types/mcp';
import type { MemoryConfig } from './types/memory';
import type { PluginsConfig } from './types/plugins';
import type { PromptsConfig } from './types/prompts';
import type { APIConfig, EventConfig, ProtocolConfig, ProtocolName } from './types/protocol';
import type { RAGConfig } from './types/rag';
import type { TTSConfig } from './types/tts';
import type { VideoKnowledgeConfig } from './types/videoKnowledge';

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
export type { BotSelfConfig, ClaudeCodeServiceConfig, ProjectRegistryConfig, StaticServerConfig } from './types/bot';
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
export type { VideoKnowledgeConfig } from './types/videoKnowledge';
export type { LanRelayConfig, LanRelayInstanceRole } from './types/lanRelay';

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
  claudeCodeService?: ClaudeCodeServiceConfig;
  videoKnowledge?: VideoKnowledgeConfig;
  cluster?: Record<string, unknown>;
  /** LAN WebSocket relay (host/client); optional. */
  lanRelay?: LanRelayConfig;
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

  /**
   * Resolve config source. Supports both single file (config.jsonc) and
   * directory (config.d/) layouts.
   *
   * Priority: constructor arg → CONFIG_PATH env → config.d/ → config.jsonc
   */
  private resolveConfigPath(configPath?: string): string {
    const candidates = [
      configPath,
      process.env.CONFIG_PATH,
      resolve(process.cwd(), 'config.d'),
      resolve(process.cwd(), 'config.jsonc'),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const resolved = resolve(candidate);
      if (existsSync(resolved)) {
        return resolved;
      }
    }

    throw new ConfigError(
      `Config not found. Provide one of:\n` +
        `  1. Constructor argument: new Config('/path/to/config.d' or '/path/to/config.jsonc')\n` +
        `  2. CONFIG_PATH env var (file or directory)\n` +
        `  3. config.d/ directory in project root\n` +
        `  4. config.jsonc file in project root`,
    );
  }

  private loadConfig(configPath: string): BotConfig {
    const isDir = statSync(configPath).isDirectory();
    const merged = loadConfigAuto(configPath);
    logger.info(`[Config] Loaded config from ${isDir ? 'directory' : 'file'}: ${configPath}`);
    return merged as unknown as BotConfig;
  }

  /**
   * Cross-field validation for the lanRelay block. Disabled blocks pass
   * through untouched (every field is optional in that case). When enabled,
   * the role-dependent fields (listenPort for host, connectUrl for client)
   * are required so we can fail loudly at boot rather than at first use.
   */
  private validateLanRelayConfig(lr: LanRelayConfig | undefined): void {
    if (!lr || !lr.enabled) {
      return;
    }
    if (!lr.instanceRole) {
      throw new ConfigError('lanRelay.instanceRole is required when lanRelay.enabled is true');
    }
    if (!lr.token || String(lr.token).trim() === '') {
      throw new ConfigError('lanRelay.token is required when lanRelay.enabled is true');
    }
    if (lr.instanceRole === 'host') {
      if (lr.listenPort == null || Number.isNaN(Number(lr.listenPort))) {
        throw new ConfigError('lanRelay.listenPort is required when lanRelay.instanceRole is host');
      }
    }
    if (lr.instanceRole === 'client') {
      if (!lr.connectUrl || String(lr.connectUrl).trim() === '') {
        throw new ConfigError('lanRelay.connectUrl is required when lanRelay.instanceRole is client');
      }
    }
  }

  private validateConfig(): void {
    if (!Array.isArray(this.config.protocols)) {
      throw new ConfigError('protocols must be an array');
    }

    const enabledProtocols = this.config.protocols.filter((p) => p.enabled);
    const lr = this.config.lanRelay;
    const clientRelayOnly = lr?.enabled === true && lr.instanceRole === 'client';
    if (enabledProtocols.length === 0 && !clientRelayOnly) {
      throw new ConfigError('At least one protocol must be enabled (unless lanRelay.enabled + instanceRole client)');
    }

    this.validateLanRelayConfig(lr);

    // Validate each protocol config
    for (const protocol of this.config.protocols) {
      // Discord manages its own connection via discord.js; url/apiUrl are not needed.
      if (protocol.name === 'discord') {
        if (!protocol.connection.accessToken) {
          throw new ConfigError('Discord protocol must have connection.accessToken (bot token)');
        }
        continue;
      }
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
   * Parsed from config.bot.selfId; 0 if missing or invalid.
   */
  getBotUserId(): number {
    const raw = this.config?.bot?.selfId;
    if (raw == null || raw === '') {
      return 0;
    }
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (Number.isNaN(n) || n <= 0) {
      return 0;
    }
    return n;
  }

  getEnabledProtocols(): ProtocolConfig[] {
    return this.config.protocols.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
  }

  /**
   * Protocols that should actually open IM connections.
   * LAN relay clients skip all IM protocols while keeping a full config file.
   */
  getProtocolsToConnect(): ProtocolConfig[] {
    const lr = this.config.lanRelay;
    if (lr?.enabled && lr.instanceRole === 'client') {
      return [];
    }
    return this.getEnabledProtocols();
  }

  getLanRelayConfig(): LanRelayConfig | undefined {
    return this.config.lanRelay;
  }

  isLanRelayClientMode(): boolean {
    const lr = this.config.lanRelay;
    return lr?.enabled === true && lr.instanceRole === 'client';
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
   * Whether to use skills for reply generation (default: true).
   */
  getUseSkills(): boolean {
    return this.config.ai?.useSkills !== false;
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
      filter: this.config.memory?.filter,
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

  getClaudeCodeServiceConfig(): ClaudeCodeServiceConfig | undefined {
    return this.config.claudeCodeService;
  }

  getVideoKnowledgeConfig(): VideoKnowledgeConfig | undefined {
    return this.config.videoKnowledge;
  }

  getClusterConfig(): Record<string, unknown> | undefined {
    return this.config.cluster;
  }
}
