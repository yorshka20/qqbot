// Conversation Initializer - initializes all conversation-related components

import type { Config } from '@/core/Config';
import type { APIClient } from '@/api/APIClient';
import { CommandManager, CommandParser, HelpCommand, StatusCommand, PingCommand } from '@/command';
import { TaskManager, TaskAnalyzer, ReplyTaskExecutor } from '@/task';
import { ContextManager } from '@/context';
import { AIManager, OpenAIProvider } from '@/ai';
import { HookManager } from '@/plugins/HookManager';
import { HookRegistry } from '@/plugins/HookRegistry';
import { ConversationManager } from './ConversationManager';
import { MessagePipeline } from './MessagePipeline';
import { CommandRouter } from './CommandRouter';
import { DatabaseManager } from '@/database/DatabaseManager';
import { logger } from '@/utils/logger';

export interface ConversationComponents {
  conversationManager: ConversationManager;
  hookManager: HookManager;
  hookRegistry: HookRegistry;
  commandManager: CommandManager;
  taskManager: TaskManager;
  aiManager: AIManager;
  contextManager: ContextManager;
  databaseManager?: DatabaseManager;
}

/**
 * Conversation Initializer
 * Initializes all conversation-related components
 */
export class ConversationInitializer {
  /**
   * Initialize all conversation components
   */
  static async initialize(
    config: Config,
    apiClient: APIClient,
  ): Promise<ConversationComponents> {
    logger.info('[ConversationInitializer] Initializing conversation components...');

    // Initialize database if configured
    let databaseManager: DatabaseManager | undefined;
    const dbConfig = config.getDatabaseConfig();
    if (dbConfig) {
      databaseManager = new DatabaseManager();
      await databaseManager.initialize(dbConfig);
      logger.info('[ConversationInitializer] Database initialized');
    }

    // Initialize AI Manager
    const aiManager = new AIManager();
    const aiConfig = config.getAIConfig();
    if (aiConfig) {
      // Register AI providers
      for (const [name, providerConfig] of Object.entries(aiConfig.providers)) {
        if (providerConfig.type === 'openai') {
          const provider = new OpenAIProvider({
            apiKey: providerConfig.apiKey,
            model: providerConfig.model,
            baseURL: providerConfig.baseURL,
            defaultTemperature: providerConfig.temperature,
            defaultMaxTokens: providerConfig.maxTokens,
          });
          aiManager.registerProvider(provider);
        }
        // Add other providers here (Anthropic, Ollama, etc.)
      }

      // Set current provider
      if (aiConfig.provider) {
        aiManager.setCurrentProvider(aiConfig.provider);
      }
      logger.info('[ConversationInitializer] AI Manager initialized');
    }

    // Initialize Context Manager
    const contextManager = new ContextManager(
      aiManager.getCurrentProvider() ? aiManager : undefined,
      false, // useSummary
      20, // summaryThreshold
    );
    logger.info('[ConversationInitializer] Context Manager initialized');

    // Initialize Command Manager
    const commandManager = new CommandManager();
    const commandConfig = (config.getConfig() as any).command;
    const prefixes = commandConfig?.prefixes || ['/', '!'];

    // Register builtin commands
    commandManager.register(new HelpCommand(commandManager), 100);
    commandManager.register(new StatusCommand(), 100);
    commandManager.register(new PingCommand(), 100);
    logger.info('[ConversationInitializer] Command Manager initialized');

    // Initialize Task Manager
    const taskManager = new TaskManager();
    const taskConfig = (config.getConfig() as any).task;

    // Register reply executor
    taskManager.registerExecutor(new ReplyTaskExecutor());

    // Register task types from config
    if (taskConfig?.types) {
      for (const taskType of taskConfig.types) {
        taskManager.registerTaskType({
          name: taskType.name,
          description: taskType.description,
          executor: taskType.executor,
        });
      }
    }
    logger.info('[ConversationInitializer] Task Manager initialized');

    // Initialize Task Analyzer
    const taskAnalyzer = new TaskAnalyzer(aiManager, taskManager);
    logger.info('[ConversationInitializer] Task Analyzer initialized');

    // Initialize Hook Manager
    const hookManager = new HookManager();
    const hookRegistry = new HookRegistry(hookManager);
    logger.info('[ConversationInitializer] Hook Manager initialized');

    // Initialize Command Router
    const commandRouter = new CommandRouter(prefixes);

    // Initialize Message Pipeline
    const pipeline = new MessagePipeline(
      commandRouter,
      commandManager,
      taskManager,
      taskAnalyzer,
      contextManager,
      aiManager,
      hookManager,
      apiClient,
    );

    // Initialize Conversation Manager
    const conversationManager = new ConversationManager(pipeline);
    logger.info('[ConversationInitializer] Conversation Manager initialized');

    logger.info('[ConversationInitializer] All components initialized successfully');

    return {
      conversationManager,
      hookManager,
      hookRegistry,
      commandManager,
      taskManager,
      aiManager,
      contextManager,
      databaseManager,
    };
  }
}
