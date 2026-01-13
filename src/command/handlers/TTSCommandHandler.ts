import { APIClient } from '@/api/APIClient';
import { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { Command } from '../decorators';
import { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * TTS command - converts text to speech using Fish Audio API
 */
@Command({
  name: 'tts',
  description: 'Convert text to speech. Example: /tts 你好世界 -voice=丁真. Use /tts list to see all available voices.',
  usage: '/tts <text> [-voice=<voice>] | /tts list',
  permissions: ['user'], // All users can use TTS
  aliases: ['say', 'speak'],
})
@injectable()
export class TTSCommandHandler implements CommandHandler {
  name = 'tts';
  description =
    'Convert text to speech. Example: /tts 你好世界 -voice=丁真. Use /tts list to see all available voices.';
  usage = '/tts <text> [-voice=<voice>] | /tts list';

  // Fish Audio API URL
  private readonly FISH_API_URL = 'https://api.fish.audio/v1/tts';

  // Voice map: voice name -> reference_id
  private readonly VOICE_MAP: Record<string, string> = {
    蔡徐坤: 'e4642e5edccd4d9ab61a69e82d4f8a14',
    丁真: '54a5170264694bfc8e9ad98df7bd89c3',
    赛马娘: '561fcedfdf0e4e1399d1bc4930d50c0e',
    孙笑川: 'e80ea225770f42f79d50aa98be3cedfc',
    丰川祥子: '8ce20e146c9545619e5f6f4c95564a2d',
    雷军: 'aebaa2305aa2452fbdc8f41eec852a79',
    特朗普: '5196af35f6ff4a0dbf541793fc9f2157',
    日语: 'fbea303b64374bffb8843569404b095e',
  };

  // Default voice: 丁真
  private readonly DEFAULT_VOICE = '丁真';

  // Maximum text length (in characters)
  private readonly MAX_TEXT_LENGTH = 1000;

  constructor(
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.CONFIG) private config: Config,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Check if user wants to list available voices
    if (
      args.length === 0 ||
      (args.length === 1 && (args[0] === 'list' || args[0] === '--list' || args[0] === '-list'))
    ) {
      return {
        success: true,
        message: this.getVoiceList(),
      };
    }

    try {
      // Parse arguments
      const { text, options } = this.parseArguments(args);

      // Validate text length
      if (text.length > this.MAX_TEXT_LENGTH) {
        return {
          success: false,
          error: `Text is too long. Maximum length is ${this.MAX_TEXT_LENGTH} characters, but got ${text.length} characters.`,
        };
      }

      // Check if text is empty after parsing
      if (!text || text.trim().length === 0) {
        return {
          success: false,
          error: 'Text cannot be empty. Please provide text to synthesize.',
        };
      }

      logger.info(`[TTSCommandHandler] Synthesizing speech for text: ${text.substring(0, 50)}...`);

      // Get TTS configuration from config
      const ttsConfig = this.config.getTTSConfig();
      if (!ttsConfig || !ttsConfig.apiKey) {
        return {
          success: false,
          error: 'TTS configuration is missing. Please configure TTS in config file.',
        };
      }

      // Base model for header (s1, speech-1.6, speech-1.5)
      const baseModel = ttsConfig.model || 's1';
      // Audio format
      const format = ttsConfig.format || 'mp3';

      // Determine reference_id: use voice from options, or default voice
      let referenceId: string | undefined;
      if (options.voice) {
        // Check if voice is a key in the voice map
        const voiceKey = options.voice;
        if (this.VOICE_MAP[voiceKey]) {
          referenceId = this.VOICE_MAP[voiceKey];
          logger.info(`[TTSCommandHandler] Using voice: ${voiceKey} (${referenceId})`);
        } else {
          // Voice not found in map, return error with available voices
          const availableVoices = Object.keys(this.VOICE_MAP).join('、');
          return {
            success: false,
            error: `Voice "${voiceKey}" not found. Available voices: ${availableVoices}`,
          };
        }
      } else {
        // Use default voice (丁真)
        referenceId = this.VOICE_MAP[this.DEFAULT_VOICE];
        logger.info(`[TTSCommandHandler] Using default voice: ${this.DEFAULT_VOICE} (${referenceId})`);
      }

      // Build request body
      const requestBody: {
        text: string;
        format: string;
        reference_id?: string;
      } = {
        text: text,
        format: format,
      };

      // Add reference_id
      if (referenceId) {
        requestBody.reference_id = referenceId;
      }

      // Generate speech using Fish Audio API
      const response = await fetch(this.FISH_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ttsConfig.apiKey}`,
          'Content-Type': 'application/json',
          model: baseModel,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fish Audio API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      // Get audio data as ArrayBuffer
      const audioArrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(audioArrayBuffer);

      // Convert Buffer to base64 string
      const base64Audio = audioBuffer.toString('base64');

      // Build message with audio record
      const messageBuilder = new MessageBuilder();
      messageBuilder.record({ data: base64Audio });

      const messageSegments = messageBuilder.build();

      // Send message
      if (context.messageType === 'private') {
        await this.apiClient.call(
          'send_private_msg',
          {
            user_id: context.userId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for TTS generation
        );
      } else if (context.groupId) {
        await this.apiClient.call(
          'send_group_msg',
          {
            group_id: context.groupId,
            message: messageSegments,
          },
          'milky',
          30000, // 30 second timeout for TTS generation
        );
      }

      return {
        success: true,
      };
    } catch (error) {
      // Handle different error types (Error, ErrorEvent, etc.)
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String(error.message);
      } else {
        errorMessage = String(error);
      }

      logger.error('[TTSCommandHandler] Failed to synthesize speech:', error);
      logger.error('[TTSCommandHandler] Error message:', errorMessage);

      return {
        success: false,
        error: `Failed to synthesize speech: ${errorMessage}`,
      };
    }
  }

  /**
   * Parse command arguments
   * Supports:
   * - /tts text -voice=丁真
   * - /tts text --voice 丁真
   * - /tts text [--rate <rate>] [--pitch <pitch>]
   */
  private parseArguments(args: string[]): {
    text: string;
    options: {
      voice?: string;
      rate?: string;
      pitch?: string;
    };
  } {
    const options: {
      voice?: string;
      rate?: string;
      pitch?: string;
    } = {};
    const textParts: string[] = [];
    let i = 0;

    // Collect text (until we hit an option flag)
    while (i < args.length && !args[i].startsWith('-') && !args[i].startsWith('--')) {
      textParts.push(args[i]);
      i++;
    }

    const text = textParts.join(' ');

    // Parse options
    while (i < args.length) {
      const arg = args[i];

      // Handle -voice=key format
      if (arg.startsWith('-voice=')) {
        options.voice = arg.slice(7); // Remove '-voice='
        i++;
        continue;
      }

      // Handle --option format
      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const nextArg = args[i + 1];

        switch (optionName) {
          case 'voice':
            if (nextArg) {
              options.voice = nextArg;
              i += 2;
            } else {
              i++;
            }
            break;
          case 'rate':
            if (nextArg) {
              options.rate = nextArg;
              i += 2;
            } else {
              i++;
            }
            break;
          case 'pitch':
            if (nextArg) {
              options.pitch = nextArg;
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

    return { text, options };
  }

  /**
   * Get formatted list of available voices
   * @returns Formatted string listing all available voices
   */
  private getVoiceList(): string {
    const voices = Object.keys(this.VOICE_MAP);
    const defaultVoice = this.DEFAULT_VOICE;

    let list = '📢 可用的TTS声音列表：\n\n';

    for (const voice of voices) {
      const isDefault = voice === defaultVoice ? ' (默认)' : '';
      list += `• ${voice}${isDefault}\n`;
    }

    list += `\n使用示例：\n`;
    list += `/tts 你好世界                    # 使用默认声音（${defaultVoice}）\n`;
    list += `/tts 你好世界 -voice=${voices[0]}      # 指定声音\n`;
    list += `/tts list                      # 查看此列表\n`;

    return list;
  }
}
