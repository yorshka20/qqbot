// CLI debugging tool for bot session testing

import readline from 'readline';
import { APIClient } from '../api/APIClient';
import { MessageAPI } from '../api/methods/MessageAPI';
import { Bot } from '../core/Bot';
import type { ProtocolName } from '../core/Config';
import { EventRouter } from '../events/EventRouter';
import { MessageHandler } from '../events/handlers/MessageHandler';
import { MetaEventHandler } from '../events/handlers/MetaEventHandler';
import { NoticeHandler } from '../events/handlers/NoticeHandler';
import { RequestHandler } from '../events/handlers/RequestHandler';
import type { NormalizedEvent, NormalizedMessageEvent } from '../events/types';
import { HookManager } from '../hooks/HookManager';
import { PluginManager } from '../plugins/PluginManager';
import { MilkyAdapter } from '../protocol/milky';
import { OneBot11Adapter } from '../protocol/onebot11/OneBot11Adapter';
import { SatoriAdapter } from '../protocol/satori/SatoriAdapter';
import { logger } from '../utils/logger';

interface Command {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void> | void;
}

class DebugCLI {
  private bot: Bot;
  private apiClient: APIClient;
  private eventRouter: EventRouter;
  private messageAPI: MessageAPI;
  private rl: readline.Interface;
  private commands: Map<string, Command> = new Map();
  private isRunning = false;

  constructor(configPath?: string) {
    this.bot = new Bot(configPath);
    const config = this.bot.getConfig();
    const connectionManager = this.bot.getConnectionManager();

    // Initialize API client
    const apiConfig = config.getAPIConfig();
    this.apiClient = new APIClient(
      apiConfig.strategy,
      apiConfig.preferredProtocol,
    );
    this.messageAPI = new MessageAPI(this.apiClient);

    // Initialize event router
    const eventDeduplicationConfig = config.getEventDeduplicationConfig();
    this.eventRouter = new EventRouter(eventDeduplicationConfig);

    // Set up event handlers
    const messageHandler = new MessageHandler();
    const noticeHandler = new NoticeHandler();
    const requestHandler = new RequestHandler();
    const metaEventHandler = new MetaEventHandler();

    // Set up event listeners to display events in CLI
    this.eventRouter.on('message', (event) => {
      messageHandler.handle(event);
      this.displayMessageEvent(event);
    });

    this.eventRouter.on('notice', (event) => {
      noticeHandler.handle(event);
      this.displayEvent('NOTICE', event);
    });

    this.eventRouter.on('request', (event) => {
      requestHandler.handle(event);
      this.displayEvent('REQUEST', event);
    });

    this.eventRouter.on('meta_event', (event) => {
      metaEventHandler.handle(event);
      // Don't display meta events by default (too noisy)
    });

    // Set up protocol adapters
    const adapters = new Map<ProtocolName, { adapter: any; connection: any }>();

    connectionManager.on('connectionOpen', async (protocolName, connection) => {
      logger.info(
        `[DebugCLI] Setting up adapter for protocol: ${protocolName}`,
      );

      let adapter;
      const protocolConfig = config.getProtocolConfig(
        protocolName as ProtocolName,
      );

      if (!protocolConfig) {
        logger.error(
          `[DebugCLI] Protocol config not found for: ${protocolName}`,
        );
        return;
      }

      // Create appropriate adapter based on protocol name
      switch (protocolName) {
        case 'onebot11':
          adapter = new OneBot11Adapter(protocolConfig, connection);
          break;
        case 'milky':
          adapter = new MilkyAdapter(protocolConfig, connection);
          break;
        case 'satori':
          adapter = new SatoriAdapter(protocolConfig, connection);
          break;
        default:
          logger.error(`[DebugCLI] Unknown protocol: ${protocolName}`);
          return;
      }

      // Set up adapter event handling
      adapter.onEvent((event) => {
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

    // Set up readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'bot> ',
    });

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

    // Send private message
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
          const messageId = await this.messageAPI.sendPrivateMessage(
            userId,
            message,
          );
          this.printSuccess(`Message sent! Message ID: ${messageId}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.printError(`Failed to send message: ${errorMessage}`);
          if (error instanceof Error && error.stack) {
            logger.debug('Error stack:', error.stack);
          }
        }
      },
    });

    // Send group message
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
          const messageId = await this.messageAPI.sendGroupMessage(
            groupId,
            message,
          );
          this.printSuccess(`Message sent! Message ID: ${messageId}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.printError(`Failed to send message: ${errorMessage}`);
          if (error instanceof Error && error.stack) {
            logger.debug('Error stack:', error.stack);
          }
        }
      },
    });

    // API call
    this.registerCommand({
      name: 'api',
      description: 'Call an API method',
      usage: 'api <action> [params...] [--protocol <protocol>]',
      handler: async (args) => {
        if (args.length < 1) {
          this.printError(
            'Usage: api <action> [params...] [--protocol <protocol>]',
          );
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

    // Show status
    this.registerCommand({
      name: 'status',
      description: 'Show bot status and connections',
      usage: 'status',
      handler: async () => {
        const protocols = this.apiClient.getAvailableProtocols();
        const config = this.bot.getConfig();
        const allProtocols = config.getEnabledProtocols().map((p) => p.name);

        this.printInfo('\nBot Status:');
        this.printInfo(`  Running: ${this.bot.isBotRunning() ? 'Yes' : 'No'}`);
        this.printInfo(
          `  Configured Protocols: ${allProtocols.join(', ') || 'None'}`,
        );
        this.printInfo(
          `  Connected Protocols: ${protocols.join(', ') || 'None'}`,
        );
        if (protocols.length === 0 && allProtocols.length > 0) {
          this.printWarning('  ⚠ No protocols are connected!');
        }
        this.printInfo('');
      },
    });

    // Exit command
    this.registerCommand({
      name: 'exit',
      description: 'Exit the debug CLI',
      usage: 'exit',
      handler: async () => {
        await this.shutdown();
        process.exit(0);
      },
    });

    // Quit command (alias for exit)
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

  private displayMessageEvent(event: NormalizedMessageEvent): void {
    const type = event.messageType === 'private' ? 'PRIVATE' : 'GROUP';
    const sender =
      event.sender?.nickname || event.sender?.card || `User ${event.userId}`;
    const location =
      event.messageType === 'private'
        ? `from ${sender}`
        : `in group ${event.groupId} from ${sender}`;

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

  private printInfo(message: string): void {
    console.log(`\x1b[36m${message}\x1b[0m`);
  }

  private printSuccess(message: string): void {
    console.log(`\x1b[32m${message}\x1b[0m`);
  }

  private printError(message: string): void {
    console.log(`\x1b[31m${message}\x1b[0m`);
  }

  private printWarning(message: string): void {
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
      // Start bot
      this.printInfo('Starting bot...');
      await this.bot.start();

      // Load plugins
      const config = this.bot.getConfig();
      const pluginsConfig = config.getPluginsConfig();
      const hookManager = new HookManager();
      const pluginManager = new PluginManager(hookManager);
      pluginManager.setContext({
        api: this.apiClient,
        events: this.eventRouter,
        bot: {
          getConfig: () => config.getConfig(),
        },
      });
      await pluginManager.loadPlugins(pluginsConfig.list);

      this.printSuccess('Bot initialized and ready!\n');
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
          this.printError(
            `Unknown command: ${commandName}. Type "help" for available commands.`,
          );
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

  private async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.printInfo('Shutting down...');
    this.isRunning = false;
    this.rl.close();
    await this.bot.stop();
    this.eventRouter.destroy();
    this.printSuccess('Shutdown complete');
  }
}

// Main entry point
async function main() {
  const configPath = process.env.CONFIG_PATH;
  const cli = new DebugCLI(configPath);

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
