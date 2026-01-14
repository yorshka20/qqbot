// CLI debugging tool for bot session testing
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import readline from 'readline';
import { PromptInitializer } from '../ai/PromptInitializer';
import { APIClient } from '../api/APIClient';
import { MessageAPI } from '../api/methods/MessageAPI';
import type { APIStrategy } from '../api/types';
import type { ConversationContext } from '../context/types';
import { ConversationInitializer } from '../conversation/ConversationInitializer';
import { Bot } from '../core/Bot';
import type { Config, ProtocolName } from '../core/config';
import { EventInitializer } from '../events/EventInitializer';
import type { NormalizedEvent, NormalizedMessageEvent } from '../events/types';
import { MCPInitializer } from '../mcp/MCPInitializer';
import { PluginInitializer } from '../plugins/PluginInitializer';
import { ProtocolAdapterInitializer } from '../protocol/ProtocolAdapterInitializer';
import { SearchService } from '../search';
import { logger } from '../utils/logger';

interface Command {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void> | void;
}

/**
 * Mock APIClient for simulation mode
 * Intercepts message sending and only outputs to console
 */
class MockAPIClient extends APIClient {
  private debugCLI: DebugCLI;

  constructor(debugCLI: DebugCLI, strategy: APIStrategy, preferredProtocol?: ProtocolName) {
    super(strategy, preferredProtocol);
    this.debugCLI = debugCLI;
  }

  async call<TResponse = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    protocol: ProtocolName = 'milky',
    timeout = 10000,
    conversationContext?: ConversationContext,
  ): Promise<TResponse> {
    // Intercept message sending actions
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      this.debugCLI.printMockReply(action, params);
      return { message_id: Date.now() } as TResponse;
    }

    // For other API calls, log a warning
    this.debugCLI.printWarning(`[Mock Mode] API call "${action}" not supported in mock mode`);
    return {} as TResponse;
  }
}

class DebugCLI {
  private bot: Bot | null = null;
  private apiClient: APIClient;
  private eventRouter: any;
  private messageAPI: MessageAPI;
  private rl: readline.Interface;
  private commands: Map<string, Command> = new Map();
  private isRunning = false;
  private isMockMode: boolean;
  private config: Config;
  private conversationManager: any;
  private commandManager: any;
  private pluginManager: any;

  constructor(configPath: string | undefined, mockMode: boolean) {
    this.isMockMode = mockMode;

    // Set up readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'bot> ',
    });

    // Load config
    this.bot = mockMode ? null : new Bot(configPath);
    this.config = this.bot ? this.bot.getConfig() : new Bot(configPath).getConfig();

    // Initialize API client based on mode
    const apiConfig = this.config.getAPIConfig();
    if (mockMode) {
      this.apiClient = new MockAPIClient(this, apiConfig.strategy, apiConfig.preferredProtocol);
    } else {
      this.apiClient = new APIClient(apiConfig.strategy, apiConfig.preferredProtocol);
    }
    this.messageAPI = new MessageAPI(this.apiClient);

    // Register commands
    this.registerCommands();
  }

  private registerCommands(): void {
    // Help command
    this.registerCommand({
      name: 'help',
      description: 'Show available commands',
      usage: 'help [command]',
      handler: async (args) => {
        if (args.length > 0) {
          const cmd = this.commands.get(args[0]);
          if (cmd) {
            this.printInfo(`\n${cmd.name}: ${cmd.description}`);
            this.printInfo(`Usage: ${cmd.usage}\n`);
          } else {
            this.printError(`Unknown command: ${args[0]}`);
          }
        } else {
          this.printInfo('\nAvailable commands:');
          for (const cmd of this.commands.values()) {
            this.printInfo(`  ${cmd.name.padEnd(20)} - ${cmd.description}`);
          }
          this.printInfo('');
        }
      },
    });

    // Simulate message command (both modes)
    this.registerCommand({
      name: 'msg',
      description: 'Simulate a message event',
      usage: 'msg <type> <userId> [groupId] <message> [--at-bot]',
      handler: async (args) => {
        await this.handleSimulate(args);
      },
    });

    // Send private message (real mode only)
    if (!this.isMockMode) {
      this.registerCommand({
        name: 'send',
        description: 'Send a private message',
        usage: 'send <userId> <message>',
        handler: async (args) => {
          if (args.length < 2) {
            this.printError('Usage: send <userId> <message>');
            return;
          }
          const userId = parseInt(args[0], 10);
          if (isNaN(userId)) {
            this.printError('Invalid user ID');
            return;
          }
          const message = args.slice(1).join(' ');
          try {
            const messageId = await this.messageAPI.sendPrivateMessage(userId, message);
            this.printSuccess(`Message sent! Message ID: ${messageId}`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.printError(`Failed to send message: ${errorMessage}`);
            if (error instanceof Error && error.stack) {
              logger.debug('Error stack:', error.stack);
            }
          }
        },
      });

      // Send group message (real mode only)
      this.registerCommand({
        name: 'group',
        description: 'Send a group message',
        usage: 'group <groupId> <message>',
        handler: async (args) => {
          if (args.length < 2) {
            this.printError('Usage: group <groupId> <message>');
            return;
          }
          const groupId = parseInt(args[0], 10);
          if (isNaN(groupId)) {
            this.printError('Invalid group ID');
            return;
          }
          const message = args.slice(1).join(' ');
          try {
            const messageId = await this.messageAPI.sendGroupMessage(groupId, message);
            this.printSuccess(`Message sent! Message ID: ${messageId}`);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.printError(`Failed to send message: ${errorMessage}`);
            if (error instanceof Error && error.stack) {
              logger.debug('Error stack:', error.stack);
            }
          }
        },
      });
    }

    // API call
    this.registerCommand({
      name: 'api',
      description: 'Call an API method',
      usage: 'api <action> [params...] [--protocol <protocol>]',
      handler: async (args) => {
        if (args.length < 1) {
          this.printError('Usage: api <action> [params...] [--protocol <protocol>]');
          return;
        }
        const action = args[0];
        let protocol: ProtocolName = 'milky';
        const params: Record<string, unknown> = {};

        // Parse arguments
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--protocol' && i + 1 < args.length) {
            protocol = args[i + 1] as ProtocolName;
            i++;
          } else if (args[i].includes('=')) {
            const [key, value] = args[i].split('=');
            params[key] = isNaN(Number(value)) ? value : Number(value);
          } else {
            params[args[i]] = true;
          }
        }

        try {
          const result = await this.apiClient.call(action, params, protocol);
          this.printSuccess(`API call result:`);
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          this.printError(`API call failed: ${error}`);
        }
      },
    });

    // List commands
    this.registerCommand({
      name: 'list-commands',
      description: 'List all registered commands',
      usage: 'list-commands',
      handler: async () => {
        if (!this.commandManager) {
          this.printError('Command manager not initialized');
          return;
        }
        // Get all registered commands from CommandManager
        const commands = this.commandManager.getAllCommands?.() || [];
        if (commands.length === 0) {
          this.printInfo('No commands registered');
          return;
        }
        this.printInfo('\nRegistered commands:');
        for (const cmd of commands) {
          const name = cmd.handler?.name || 'unknown';
          const desc = cmd.handler?.description || 'No description';
          const plugin = cmd.pluginName ? ` [${cmd.pluginName}]` : '';
          this.printInfo(`  ${name.padEnd(20)} - ${desc}${plugin}`);
        }
        this.printInfo('');
      },
    });

    // List plugins
    this.registerCommand({
      name: 'list-plugins',
      description: 'List all loaded plugins',
      usage: 'list-plugins',
      handler: async () => {
        if (!this.pluginManager) {
          this.printError('Plugin manager not initialized');
          return;
        }
        // Get all loaded plugins from PluginManager
        const plugins = this.pluginManager.getAllPlugins?.() || [];
        if (plugins.length === 0) {
          this.printInfo('No plugins loaded');
          return;
        }
        this.printInfo('\nLoaded plugins:');
        for (const plugin of plugins) {
          const name = plugin.name || 'unknown';
          const version = plugin.version || 'unknown';
          const enabled = plugin.enabled !== false ? 'enabled' : 'disabled';
          this.printInfo(`  ${name.padEnd(20)} v${version} (${enabled})`);
        }
        this.printInfo('');
      },
    });

    // Show status
    this.registerCommand({
      name: 'status',
      description: 'Show bot status and connections',
      usage: 'status',
      handler: async () => {
        const protocols = this.apiClient.getAvailableProtocols();
        const allProtocols = this.config.getEnabledProtocols().map((p) => p.name);

        this.printInfo('\nBot Status:');
        this.printInfo(`  Mode: ${this.isMockMode ? 'Mock (Simulation)' : 'Real (Connected)'}`);
        if (!this.isMockMode && this.bot) {
          this.printInfo(`  Running: ${this.bot.isBotRunning() ? 'Yes' : 'No'}`);
        }
        this.printInfo(`  Configured Protocols: ${allProtocols.join(', ') || 'None'}`);
        if (!this.isMockMode) {
          this.printInfo(`  Connected Protocols: ${protocols.join(', ') || 'None'}`);
          if (protocols.length === 0 && allProtocols.length > 0) {
            this.printWarning('  ⚠ No protocols are connected!');
          }
        } else {
          this.printInfo('  Connected Protocols: N/A (Mock Mode)');
        }
        this.printInfo('');
      },
    });

    // Quit command
    this.registerCommand({
      name: 'quit',
      description: 'Exit the debug CLI',
      usage: 'quit',
      handler: async () => {
        await this.shutdown();
        process.exit(0);
      },
    });
  }

  private registerCommand(command: Command): void {
    this.commands.set(command.name, command);
  }

  private async handleSimulate(args: string[]): Promise<void> {
    if (args.length < 3) {
      this.printError('Usage: simulate <type> <userId> [groupId] <message> [--at-bot]');
      this.printInfo('  type: private or group');
      this.printInfo('  userId: user ID (number)');
      this.printInfo('  groupId: group ID (number, required for group type)');
      this.printInfo('  message: message content');
      this.printInfo('  --at-bot: add @bot mention (for group messages)');
      return;
    }

    const type = args[0].toLowerCase();
    if (type !== 'private' && type !== 'group') {
      this.printError('Type must be "private" or "group"');
      return;
    }

    const userId = parseInt(args[1], 10);
    if (isNaN(userId)) {
      this.printError('Invalid user ID');
      return;
    }

    let groupId: number | undefined;
    let messageStartIndex = 2;
    let atBot = false;

    if (type === 'group') {
      if (args.length < 4) {
        this.printError('Group messages require groupId');
        return;
      }
      groupId = parseInt(args[2], 10);
      if (isNaN(groupId)) {
        this.printError('Invalid group ID');
        return;
      }
      messageStartIndex = 3;
    }

    // Parse message and flags
    const messageParts: string[] = [];
    for (let i = messageStartIndex; i < args.length; i++) {
      if (args[i] === '--at-bot') {
        atBot = true;
      } else {
        messageParts.push(args[i]);
      }
    }

    if (messageParts.length === 0) {
      this.printError('Message cannot be empty');
      return;
    }

    const message = messageParts.join(' ');

    // Create mock message event
    const event = this.createMockMessageEvent(type as 'private' | 'group', userId, message, groupId, atBot);

    // Display input message
    this.printInfo(`\n[Simulating ${type.toUpperCase()}] User ${userId}${groupId ? ` in group ${groupId}` : ''}:`);
    this.printMessage(`  ${message}`);
    if (atBot) {
      this.printInfo('  (@bot mentioned)');
    }

    // Process message
    if (!this.conversationManager) {
      this.printError('Conversation manager not initialized');
      return;
    }

    try {
      const result = await this.conversationManager.processMessage(event);
      if (result.success) {
        if (result.reply) {
          if (this.isMockMode) {
            this.printSuccess('\n[Bot Reply (Mock)]:');
          } else {
            this.printSuccess('\n[Bot Reply]:');
          }
          this.printMessage(`  ${result.reply}\n`);
        } else {
          this.printInfo('\n[No reply generated]\n');
        }
      } else {
        this.printError(`\n[Error]: ${result.error || 'Unknown error'}\n`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.printError(`\n[Error processing message]: ${errorMessage}\n`);
      if (error instanceof Error && error.stack) {
        logger.debug('Error stack:', error.stack);
      }
    }
  }

  private createMockMessageEvent(
    type: 'private' | 'group',
    userId: number,
    message: string,
    groupId?: number,
    atBot: boolean = false,
  ): NormalizedMessageEvent {
    const segments: Array<{ type: string; data?: Record<string, unknown> }> = [];

    if (atBot && type === 'group') {
      segments.push({
        type: 'mention',
        data: { user_id: 0 }, // @0 means @bot in Milky protocol
      });
    }

    const botConfig = this.config.getConfig();
    const botSelfId = botConfig.bot.selfId;

    return {
      type: 'message',
      messageType: type,
      userId,
      groupId,
      message,
      segments: segments.length > 0 ? segments : undefined,
      timestamp: Date.now(),
      protocol: 'milky',
      id: Date.now().toString(),
      messageId: Date.now(),
      sender: {
        userId,
        nickname: `User ${userId}`,
        role: 'member',
      },
    };
  }

  printMockReply(action: string, params: Record<string, unknown>): void {
    const message = params.message as string;
    if (action === 'send_private_msg') {
      const userId = params.user_id as number;
      this.printSuccess(`\n[Mock] Would send private message to ${userId}:`);
      this.printMessage(`  ${message}\n`);
    } else if (action === 'send_group_msg') {
      const groupId = params.group_id as number;
      this.printSuccess(`\n[Mock] Would send group message to ${groupId}:`);
      this.printMessage(`  ${message}\n`);
    }
    this.rl.prompt();
  }

  private printInfo(message: string): void {
    console.log(`\x1b[36m${message}\x1b[0m`);
  }

  private printSuccess(message: string): void {
    console.log(`\x1b[32m${message}\x1b[0m`);
  }

  private printError(message: string): void {
    console.log(`\x1b[31m${message}\x1b[0m`);
  }

  printWarning(message: string): void {
    console.log(`\x1b[33m${message}\x1b[0m`);
  }

  private printMessage(message: string): void {
    console.log(`\x1b[37m${message}\x1b[0m`);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.printWarning('CLI is already running');
      return;
    }

    this.isRunning = true;

    try {
      // Initialize prompt system (before conversation initialization)
      PromptInitializer.initialize(this.config);

      if (this.isMockMode) {
        await this.initializeMockMode();
      } else {
        await this.initializeRealMode();
      }

      this.printSuccess('Bot initialized and ready!\n');
      this.printInfo(`Mode: ${this.isMockMode ? 'Mock (Simulation)' : 'Real (Connected)'}`);
      this.printInfo('Type "help" for available commands.\n');

      // Set up command handler
      this.rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          this.rl.prompt();
          return;
        }

        const [commandName, ...args] = trimmed.split(/\s+/);
        const command = this.commands.get(commandName);

        if (command) {
          try {
            await command.handler(args);
          } catch (error) {
            this.printError(`Error executing command: ${error}`);
          }
        } else {
          this.printError(`Unknown command: ${commandName}. Type "help" for available commands.`);
        }

        this.rl.prompt();
      });

      this.rl.on('close', async () => {
        await this.shutdown();
        process.exit(0);
      });

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        this.printInfo('\nReceived SIGINT, shutting down...');
        await this.shutdown();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        this.printInfo('\nReceived SIGTERM, shutting down...');
        await this.shutdown();
        process.exit(0);
      });

      this.rl.prompt();
    } catch (error) {
      this.printError(`Failed to start bot: ${error}`);
      this.isRunning = false;
      throw error;
    }
  }

  private async initializeMockMode(): Promise<void> {
    this.printInfo('Initializing in Mock Mode (no real connections)...');

    // Initialize MCP system (if enabled)
    const mcpSystem = MCPInitializer.initialize(this.config);

    // Initialize search service (if MCP is enabled)
    let searchService: SearchService | undefined;
    const mcpConfig = this.config.getMCPConfig();
    if (mcpConfig && mcpConfig.enabled) {
      searchService = new SearchService(mcpConfig);
      logger.info('[DebugCLI] SearchService initialized');
    }

    // Initialize conversation components
    this.printInfo('Initializing conversation system...');
    const conversationComponents = await ConversationInitializer.initialize(this.config, this.apiClient, searchService);
    this.conversationManager = conversationComponents.conversationManager;
    this.commandManager = conversationComponents.commandManager;

    // Initialize event router (for plugins that might use it)
    const eventSystem = EventInitializer.initialize(this.config, conversationComponents.conversationManager);
    this.eventRouter = eventSystem.eventRouter;

    // Initialize plugin system
    this.printInfo('Initializing plugin system...');
    const pluginSystem = PluginInitializer.initialize(
      this.config,
      conversationComponents.hookManager,
      this.apiClient,
      this.eventRouter,
    );
    this.pluginManager = pluginSystem.pluginManager;

    // Connect to MCP servers (if enabled)
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, this.config);
      // Update SearchService with MCP manager for MCP mode
      if (searchService) {
        MCPInitializer.updateSearchService(mcpSystem, searchService);
      }
    }

    // Load plugins
    await PluginInitializer.loadPlugins(pluginSystem, this.config);
  }

  private async initializeRealMode(): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot instance not initialized in real mode');
    }

    this.printInfo('Initializing in Real Mode (with connections)...');

    const connectionManager = this.bot.getConnectionManager();

    // Initialize MCP system (if enabled)
    const mcpSystem = MCPInitializer.initialize(this.config);

    // Initialize search service (if MCP is enabled)
    let searchService: SearchService | undefined;
    const mcpConfig = this.config.getMCPConfig();
    if (mcpConfig && mcpConfig.enabled) {
      searchService = new SearchService(mcpConfig);
      logger.info('[DebugCLI] SearchService initialized');
    }

    // Initialize conversation components
    this.printInfo('Initializing conversation system...');
    const conversationComponents = await ConversationInitializer.initialize(this.config, this.apiClient, searchService);
    this.conversationManager = conversationComponents.conversationManager;
    this.commandManager = conversationComponents.commandManager;

    // Initialize event system
    const eventSystem = EventInitializer.initialize(this.config, conversationComponents.conversationManager);
    this.eventRouter = eventSystem.eventRouter;

    // Set up protocol adapters
    const adapters = new Map<ProtocolName, { adapter: any; connection: any }>();

    connectionManager.on('connectionOpen', async (protocolName, connection) => {
      logger.info(`[DebugCLI] Setting up adapter for protocol: ${protocolName}`);

      const protocolConfig = this.config.getProtocolConfig(protocolName as ProtocolName);
      if (!protocolConfig) {
        logger.error(`[DebugCLI] Protocol config not found for: ${protocolName}`);
        return;
      }

      // Import adapters dynamically
      let adapter;
      switch (protocolName) {
        case 'onebot11':
          const { OneBot11Adapter } = await import('../protocol/onebot11/OneBot11Adapter');
          adapter = new OneBot11Adapter(protocolConfig, connection);
          break;
        case 'milky':
          const { MilkyAdapter } = await import('../protocol/milky');
          adapter = new MilkyAdapter(protocolConfig, connection);
          break;
        case 'satori':
          const { SatoriAdapter } = await import('../protocol/satori/SatoriAdapter');
          adapter = new SatoriAdapter(protocolConfig, connection);
          break;
        default:
          logger.error(`[DebugCLI] Unknown protocol: ${protocolName}`);
          return;
      }

      // Set up adapter event handling
      adapter.onEvent((event: any) => {
        if (event && typeof event === 'object' && 'type' in event) {
          this.eventRouter.routeEvent(event as NormalizedEvent);
        }
      });

      // Register adapter with API client
      this.apiClient.registerAdapter(protocolName as ProtocolName, adapter);
      adapters.set(protocolName as ProtocolName, { adapter, connection });

      this.printInfo(`✓ Adapter registered for protocol: ${protocolName}`);
    });

    connectionManager.on('connectionClose', (protocolName) => {
      logger.info(`[DebugCLI] Connection closed for protocol: ${protocolName}`);
      this.apiClient.unregisterAdapter(protocolName as ProtocolName);
      adapters.delete(protocolName as ProtocolName);
      this.printWarning(`✗ Connection closed for protocol: ${protocolName}`);
    });

    // Initialize protocol adapter system (BEFORE starting bot)
    ProtocolAdapterInitializer.initialize(this.config, connectionManager, this.eventRouter, this.apiClient);

    // Initialize plugin system
    this.printInfo('Initializing plugin system...');
    const pluginSystem = PluginInitializer.initialize(
      this.config,
      conversationComponents.hookManager,
      this.apiClient,
      this.eventRouter,
    );
    this.pluginManager = pluginSystem.pluginManager;

    // Start bot (this will trigger connection events)
    this.printInfo('Starting bot...');
    await this.bot.start();

    // Connect to MCP servers (after bot is started)
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, this.config);
      // Update SearchService with MCP manager for MCP mode
      if (searchService) {
        MCPInitializer.updateSearchService(mcpSystem, searchService);
      }
    }

    // Load plugins after bot is started
    await PluginInitializer.loadPlugins(pluginSystem, this.config);

    // Set up event handlers to display events in CLI
    const { MessageHandler } = await import('../events/handlers/MessageHandler');
    const { NoticeHandler } = await import('../events/handlers/NoticeHandler');
    const { RequestHandler } = await import('../events/handlers/RequestHandler');
    const { MetaEventHandler } = await import('../events/handlers/MetaEventHandler');

    const messageHandler = new MessageHandler(conversationComponents.conversationManager);
    const noticeHandler = new NoticeHandler();
    const requestHandler = new RequestHandler();
    const metaEventHandler = new MetaEventHandler();

    this.eventRouter.on('message', (event: NormalizedMessageEvent) => {
      messageHandler.handle(event);
      this.displayMessageEvent(event);
    });

    this.eventRouter.on('notice', (event: any) => {
      noticeHandler.handle(event);
      this.displayEvent('NOTICE', event);
    });

    this.eventRouter.on('request', (event: any) => {
      requestHandler.handle(event);
      this.displayEvent('REQUEST', event);
    });

    this.eventRouter.on('meta_event', (event: any) => {
      metaEventHandler.handle(event);
      // Don't display meta events by default (too noisy)
    });
  }

  private displayMessageEvent(event: NormalizedMessageEvent): void {
    const type = event.messageType === 'private' ? 'PRIVATE' : 'GROUP';
    const sender = event.sender?.nickname || event.sender?.card || `User ${event.userId}`;
    const location = event.messageType === 'private' ? `from ${sender}` : `in group ${event.groupId} from ${sender}`;

    this.printMessage(`\n[${type}] ${location}:`);
    this.printMessage(`  ${event.message}\n`);
    this.rl.prompt();
  }

  private displayEvent(type: string, event: NormalizedEvent): void {
    this.printInfo(`\n[${type}] Event received:`);
    console.log(JSON.stringify(event, null, 2));
    this.printInfo('');
    this.rl.prompt();
  }

  private async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.printInfo('Shutting down...');
    this.isRunning = false;
    this.rl.close();

    if (this.bot) {
      await this.bot.stop();
    }

    if (this.eventRouter) {
      this.eventRouter.destroy();
    }

    this.printSuccess('Shutdown complete');
  }
}

// Main entry point
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const isMockMode = args.includes('--mock');
  const configPath = process.env.CONFIG_PATH;

  if (isMockMode) {
    logger.info('[DebugCLI] Starting in Mock Mode (simulation)');
  } else {
    logger.info('[DebugCLI] Starting in Real Mode (with connections)');
  }

  const cli = new DebugCLI(configPath, isMockMode);

  try {
    await cli.start();
  } catch (error) {
    logger.error('[DebugCLI] Fatal error:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.main) {
  main().catch((error) => {
    logger.error('[DebugCLI] Unhandled error:', error);
    process.exit(1);
  });
}
