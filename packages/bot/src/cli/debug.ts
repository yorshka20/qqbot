// CLI debugging tool for bot session testing
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import readline from 'node:readline';
import type { CommandManager } from '@/command/CommandManager';
import type { ConversationManager } from '@/conversation/ConversationManager';
import type { PluginManager } from '@/plugins/PluginManager';
import type { APIClient } from '../api/APIClient';
import type { MessageAPI } from '../api/methods/MessageAPI';
import { type App, startApp } from '../core/app';
import type { Config, ProtocolName } from '../core/config';
import { getContainer } from '../core/DIContainer';
import { DITokens } from '../core/DITokens';
import type { NormalizedEvent, NormalizedMessageEvent } from '../events/types';
import { registerProtocol } from '../protocol/ProtocolRegistry';
import { logger } from '../utils/logger';
import { MockConnection } from './MockConnection';
import { MockProtocolAdapter } from './MockProtocolAdapter';

interface Command {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void> | void;
}

class DebugCLI {
  private app!: App;
  private apiClient!: APIClient;
  private messageAPI!: MessageAPI;
  private config!: Config;
  private conversationManager!: ConversationManager;
  private commandManager!: CommandManager;
  private pluginManager!: PluginManager;
  private rl: readline.Interface;
  private commands: Map<string, Command> = new Map();
  private isRunning = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly configPath: string | undefined;
  private isMockMode: boolean;

  constructor(configPath: string | undefined, mockMode: boolean) {
    this.configPath = configPath;
    this.isMockMode = mockMode;

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
          if (Number.isNaN(userId)) {
            this.printError('Invalid user ID');
            return;
          }
          const message = args.slice(1).join(' ');
          try {
            const messageId = await this.messageAPI.sendPrivateMessage(userId, message, 'milky');
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
          if (Number.isNaN(groupId)) {
            this.printError('Invalid group ID');
            return;
          }
          const message = args.slice(1).join(' ');
          try {
            const messageId = await this.messageAPI.sendGroupMessage(groupId, message, 'milky');
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
            params[key] = Number.isNaN(Number(value)) ? value : Number(value);
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
        // Get all registered commands from CommandManager
        const commands = this.commandManager.getAllCommands({ userId: '0', groupId: '0', userType: 'admin' });
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
        // Get all loaded plugins from PluginManager
        const plugins = this.pluginManager.getAllPlugins();
        const enabledPluginNames = new Set(this.pluginManager.getEnabledPlugins());
        if (plugins.length === 0) {
          this.printInfo('No plugins loaded');
          return;
        }
        this.printInfo('\nLoaded plugins:');
        for (const plugin of plugins) {
          const name = plugin.name || 'unknown';
          const version = plugin.version || 'unknown';
          const enabled = enabledPluginNames.has(name) ? 'enabled' : 'disabled';
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
        if (!this.isMockMode) {
          this.printInfo(`  Running: ${this.app.bot.isBotRunning() ? 'Yes' : 'No'}`);
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
      this.printError('Usage: msg <type> <userId> [groupId] <message> [--at-bot]');
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
    if (Number.isNaN(userId)) {
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
      if (Number.isNaN(groupId)) {
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
    this.printSkillLoopHint(message);

    // Process message
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

  private printSkillLoopHint(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
      this.printInfo('[ReplySystem] Command-like input detected, ReplySystem will skip AI reply generation.');
      return;
    }
    this.printInfo('[ReplySystem] Message will enter unified skill-loop reply flow.');
  }

  private createMockMessageEvent(
    type: 'private' | 'group',
    userId: number | string,
    message: string,
    groupId?: number | string,
    atBot: boolean = false,
  ): NormalizedMessageEvent {
    const segments: Array<{ type: string; data?: Record<string, unknown> }> = [];

    // Add @bot mention if requested (for group messages)
    if (atBot && type === 'group') {
      segments.push({
        type: 'mention',
        data: { user_id: 0 }, // @0 means @bot in Milky protocol
      });
    }

    // Add text segment for the message content
    if (message) {
      segments.push({
        type: 'text',
        data: { text: message },
      });
    }

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
        role: type === 'group' ? 'member' : undefined,
      },
    };
  }

  printMockReply(action: string, params: Record<string, unknown>): void {
    const message = params.message as string | unknown[];
    const messageText = typeof message === 'string' ? message : JSON.stringify(message);

    if (action === 'send_private_msg' || action === 'send_private_message') {
      const userId = params.user_id as number;
      this.printSuccess(`\n[Mock] Would send private message to ${userId}:`);
      this.printMessage(`  ${messageText}\n`);
    } else if (action === 'send_group_msg' || action === 'send_group_message') {
      const groupId = params.group_id as number;
      this.printSuccess(`\n[Mock] Would send group message to ${groupId}:`);
      this.printMessage(`  ${messageText}\n`);
    }
    this.rl.prompt();
  }

  printInfo(message: string): void {
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
      this.printInfo(
        this.isMockMode
          ? 'Initializing in Mock Mode (no real connections)...'
          : 'Initializing in Real Mode (with connections)...',
      );
      this.app = await startApp(this.configPath, { connect: !this.isMockMode });
      this.config = this.app.bot.getConfig();
      const container = getContainer();
      this.apiClient = container.resolve<APIClient>(DITokens.API_CLIENT);
      this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
      this.pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
      this.conversationManager = this.app.conversationComponents.conversationManager;
      this.commandManager = this.app.conversationComponents.commandManager;

      if (this.isMockMode) {
        await this.attachMockProtocol();
      } else {
        this.attachEventDisplay();
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

  /** Route the first enabled protocol's API calls to the CLI instead of a socket. */
  private async attachMockProtocol(): Promise<void> {
    const enabledProtocols = this.config.getEnabledProtocols();
    const protocolConfig = enabledProtocols.length > 0 ? enabledProtocols[0] : this.config.getProtocolConfig('milky');

    if (!protocolConfig) {
      throw new Error('No protocol configuration found for mock mode');
    }

    const mockConnection = new MockConnection(protocolConfig);
    const mockAdapter = new MockProtocolAdapter(protocolConfig, mockConnection, this);
    // Same two registrations ProtocolAdapterInitializer makes when a real protocol connects:
    // APIClient routes API calls, ProtocolRegistry answers SendSystem's capability queries.
    this.apiClient.registerAdapter('milky', mockAdapter);
    registerProtocol('milky', { adapter: mockAdapter });
    this.printInfo('✓ Mock protocol adapter registered');

    // Search stays live in mock mode so tool calls behave as in production.
    await this.app.retrievalService.connectSearchTransports();
  }

  /** Echo incoming events to the terminal; the app's own handlers still process them. */
  private attachEventDisplay(): void {
    this.app.eventRouter.on('message', (event: NormalizedMessageEvent) => {
      this.displayMessageEvent(event);
    });
    this.app.eventRouter.on('notice', (event: NormalizedEvent) => {
      this.displayEvent('NOTICE', event);
    });
    this.app.eventRouter.on('request', (event: NormalizedEvent) => {
      this.displayEvent('REQUEST', event);
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

  // Every exit path (quit, readline close, signals) awaits this one promise. Readline is
  // closed only after the first await: rl.close() emits 'close' synchronously, and that
  // handler must find the promise already stored instead of starting a second shutdown.
  private shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.printInfo('Shutting down...');
    this.isRunning = false;

    await this.app.shutdown();
    this.rl.close();

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
