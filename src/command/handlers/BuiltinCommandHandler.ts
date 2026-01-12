// Builtin command handlers

import { Text2ImageOptions } from '@/ai';
import type { AIService } from '@/ai/AIService';
import type { APIClient } from '@/api/APIClient';
import { DITokens } from '@/core/DITokens';
import { NormalizedMessageEvent } from '@/events/types';
import { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '../CommandManager';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Help command - shows available commands
 */
@Command({
  name: 'help',
  description: 'Show available commands',
  usage: '/help [command]',
  permissions: ['user'], // All users can use help
})
@injectable()
export class HelpCommand implements CommandHandler {
  name = 'help';
  description = 'Show available commands';
  usage = '/help [command]';

  constructor(@inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager) {}

  execute(args: string[]): CommandResult {
    const commands = this.commandManager.getAllCommands();

    if (args.length > 0) {
      // Show help for specific command
      const commandName = args[0].toLowerCase();
      const command = commands.find((c) => c.handler.name === commandName);

      if (!command) {
        return {
          success: false,
          error: `Command "${commandName}" not found`,
        };
      }

      const handler = command.handler;
      let help = `Command: ${handler.name}\n`;
      if (handler.description) {
        help += `Description: ${handler.description}\n`;
      }
      if (handler.usage) {
        help += `Usage: ${handler.usage}\n`;
      }

      return {
        success: true,
        message: help,
      };
    }

    // Show all commands
    const commandList = commands
      .map((c) => {
        const handler = c.handler;
        let line = `/${handler.name}`;
        if (handler.description) {
          line += ` - ${handler.description}`;
        }
        return line;
      })
      .join('\n');

    return {
      success: true,
      message: `Available commands:\n${commandList}\n\nUse /help <command> for more info`,
    };
  }
}

/**
 * Status command - shows bot status
 */
@Command({
  name: 'status',
  description: 'Show bot status',
  usage: '/status',
  permissions: ['user'], // All users can check status
})
@injectable()
export class StatusCommand implements CommandHandler {
  name = 'status';
  description = 'Show bot status';
  usage = '/status';

  execute(): CommandResult {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const status = `Bot Status:
Uptime: ${hours}h ${minutes}m ${seconds}s
Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;

    return {
      success: true,
      message: status,
    };
  }
}

/**
 * Ping command - responds with pong
 */
@Command({
  name: 'ping',
  description: 'Test bot response',
  usage: '/ping',
  permissions: ['user'], // All users can ping
})
@injectable()
export class PingCommand implements CommandHandler {
  name = 'ping';
  description = 'Test bot response';
  usage = '/ping';

  execute(): CommandResult {
    return {
      success: true,
      message: 'pong',
    };
  }
}

/**
 * Text2Image command - generates image from text prompt
 */
@Command({
  name: 't2i',
  description: 'Generate image from text prompt',
  usage:
    '/t2i <prompt> [--width <width>] [--height <height>] [--steps <steps>] [--seed <seed>] [--guidance <scale>] [--negative <prompt>]',
  permissions: ['user'], // All users can generate images
  aliases: ['text2img', 'img', 'generate', 'draw'],
})
@injectable()
export class Text2ImageCommand implements CommandHandler {
  name = 't2i';
  description = 'Generate image from text prompt';
  usage = '/t2i <prompt> [options]';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Please provide a prompt. Usage: /t2i <prompt> [options]',
      };
    }

    try {
      // Parse arguments
      const { prompt, options } = this.parseArguments(args);

      logger.info(`[Text2ImageCommand] Generating image with prompt: ${prompt.substring(0, 50)}...`);

      // Create hook context for AIService
      const hookContext: HookContext = {
        message: {
          id: `cmd_${Date.now()}`,
          type: 'message',
          timestamp: Date.now(),
          protocol: 'command',
          userId: context.userId,
          groupId: context.groupId,
          messageId: undefined,
          messageType: context.messageType,
          message: prompt,
          segments: [],
        } as NormalizedMessageEvent,
        metadata: new Map([
          ['sessionId', context.groupId ? `group_${context.groupId}` : `user_${context.userId}`],
          ['sessionType', context.messageType],
        ]),
      };

      // Generate image
      const response = await this.aiService.generateImg(hookContext, options);

      if (!response.images || response.images.length === 0) {
        return {
          success: false,
          error: 'No images generated',
        };
      }

      // Build message with images
      const messageBuilder = new MessageBuilder();

      // Add text message if multiple images
      if (response.images.length > 1) {
        messageBuilder.text(`Generated ${response.images.length} images:\n`);
      }

      // Add each image
      for (const image of response.images) {
        if (image.base64) {
          // Convert base64 to data URL for sending
          // Note: Some protocols may require file upload instead
          const dataUrl = `data:image/png;base64,${image.base64}`;
          messageBuilder.image('', dataUrl);
        } else if (image.url) {
          messageBuilder.image('', image.url);
        } else if (image.file) {
          messageBuilder.image(image.file);
        }
      }

      const messageSegments = messageBuilder.build();

      // Send message directly via API
      if (context.messageType === 'private') {
        await this.apiClient.call(
          'send_private_msg',
          {
            user_id: context.userId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for image generation
        );
      } else if (context.groupId) {
        await this.apiClient.call(
          'send_group_msg',
          {
            group_id: context.groupId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for image generation
        );
      }

      return {
        success: true,
        message: `Generated ${response.images.length} image(s)`,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[Text2ImageCommand] Failed to generate image:', err);
      return {
        success: false,
        error: `Failed to generate image: ${err.message}`,
      };
    }
  }

  /**
   * Parse command arguments
   * Supports: /t2i prompt --width 512 --height 512 --steps 50 --seed 123 --guidance 7.5 --negative "bad prompt"
   */
  private parseArguments(args: string[]): {
    prompt: string;
    options: Text2ImageOptions;
  } {
    const options: Text2ImageOptions = {};
    const promptParts: string[] = [];
    let i = 0;

    // Collect prompt text (until we hit an option flag)
    while (i < args.length && !args[i].startsWith('--')) {
      promptParts.push(args[i]);
      i++;
    }

    const prompt = promptParts.join(' ');

    // Parse options
    while (i < args.length) {
      const arg = args[i];
      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const nextArg = args[i + 1];

        switch (optionName) {
          case 'width':
            if (nextArg) {
              options.width = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'height':
            if (nextArg) {
              options.height = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'steps':
            if (nextArg) {
              options.steps = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'seed':
            if (nextArg) {
              options.seed = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'guidance':
            if (nextArg) {
              options.guidance_scale = parseFloat(nextArg);
              i += 2;
            } else {
              i++;
            }
            break;
          case 'negative':
            if (nextArg) {
              options.negative_prompt = nextArg;
              i += 2;
            } else {
              i++;
            }
            break;
          case 'num':
          case 'num_images':
            if (nextArg) {
              options.numImages = parseInt(nextArg, 10);
              i += 2;
            } else {
              i++;
            }
            break;
          default:
            // Unknown option, skip
            i++;
            break;
        }
      } else {
        i++;
      }
    }

    return { prompt, options };
  }
}
