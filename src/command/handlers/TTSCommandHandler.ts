import { inject, injectable } from 'tsyringe';
import type { APIClient } from '@/api/APIClient';
import { HttpClient } from '@/api/http/HttpClient';
import { FileAPI } from '@/api/methods/FileAPI';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { MessageUtils } from '@/message/MessageUtils';
import { uploadFileBuffer } from '@/utils/fileUpload';
import { logger } from '@/utils/logger';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * TTS command - converts text to speech using Fish Audio API
 */
@Command({
  name: 'tts',
  description:
    'Convert text to speech. Example: /tts 你好世界 --voice=丁真. Use /tts list to see all available voices.',
  usage: '/tts <text> [--voice=<voice>] [--file] | /tts list',
  permissions: ['user'], // All users can use TTS
  aliases: ['say', 'speak'],
})
@injectable()
export class TTSCommandHandler implements CommandHandler {
  name = 'tts';
  description =
    'Convert text to speech. Example: /tts 你好世界 --voice=丁真. Use /tts list to see all available voices.';
  usage = '/tts <text> [--voice=<voice>] [--file] | /tts list';

  // Fish Audio API URL
  private readonly FISH_API_URL = 'https://api.fish.audio/v1/tts';
  private readonly httpClient: HttpClient;

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

  private readonly DEFAULT_VOICE = '赛马娘';

  // Maximum text length (in characters)
  private readonly MAX_TEXT_LENGTH = 1000;

  // Command parameter configuration
  private readonly argsConfig: ParserConfig = {
    options: {
      voice: { property: 'voice', type: 'string' },
      rate: { property: 'rate', type: 'string' },
      pitch: { property: 'pitch', type: 'string' },
      file: { property: 'file', type: 'boolean' },
      random: { property: 'random', type: 'boolean' },
    },
  };

  private fileAPI: FileAPI;

  constructor(
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) {
    // Configure HttpClient for Fish Audio API
    this.httpClient = new HttpClient({
      baseURL: this.FISH_API_URL,
      defaultTimeout: 30000, // 30 seconds default timeout
    });
    // Initialize FileAPI for uploading files
    this.fileAPI = new FileAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Check if user wants to list available voices
    if (
      args.length === 0 ||
      (args.length === 1 && (args[0] === 'list' || args[0] === '--list' || args[0] === '-list'))
    ) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.text(this.getVoiceList());
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }

    try {
      // Parse arguments using unified parser with command-specific config
      const { text, options } = CommandArgsParser.parse<{
        voice?: string;
        rate?: string;
        pitch?: string;
        file?: boolean;
        random?: boolean;
      }>(args, this.argsConfig);

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

      // TTS only accepts plain text; skip command content (e.g. /tts /i2v xxx)
      const trimmedText = text.trim();
      if (MessageUtils.isCommand(trimmedText)) {
        return {
          success: false,
          error: 'TTS only accepts plain text. Do not use command content as TTS input.',
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
        if (options.random) {
          referenceId =
            this.VOICE_MAP[Object.keys(this.VOICE_MAP)[Math.floor(Math.random() * Object.keys(this.VOICE_MAP).length)]];
        } else {
          // Use default voice (丁真)
          referenceId = this.VOICE_MAP[this.DEFAULT_VOICE];
        }
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
      const audioArrayBuffer = await this.httpClient.post<ArrayBuffer>('', requestBody, {
        headers: {
          Authorization: `Bearer ${ttsConfig.apiKey}`,
          model: baseModel,
          'Content-Type': 'application/json',
        },
        timeout: 30000, // 30 seconds timeout
      });
      // Convert ArrayBuffer to Buffer
      const audioBuffer = Buffer.from(audioArrayBuffer);

      // Build message with audio record
      const messageBuilder = new MessageBuilder();

      // If --file option is provided, upload file and send as file attachment
      if (options.file) {
        try {
          // Generate filename with timestamp
          const timestamp = Date.now();
          const filename = `tts_${timestamp}.${format}`;

          // Upload file using generic upload utility
          // This will upload the file to Milky protocol and return file_id
          const fileId = await uploadFileBuffer(this.fileAPI, audioBuffer, filename, context, 30000);

          // Send as file attachment using file_id (Milky protocol format)
          messageBuilder.file({ file_id: fileId, file_name: filename });
          logger.debug(`[TTSCommandHandler] Built file segment with file_id=${fileId}, file_name=${filename}`);
        } catch (fileError) {
          logger.error('[TTSCommandHandler] Failed to upload file:', fileError);
          // Fallback to sending as base64 audio data if file upload fails
          const base64Audio = audioBuffer.toString('base64');
          messageBuilder.record({ data: base64Audio });
        }
      } else {
        // Default behavior: send as base64 audio data (voice message)
        const base64Audio = audioBuffer.toString('base64');
        messageBuilder.record({ data: base64Audio });
      }

      const messageSegments = messageBuilder.build();

      return {
        success: true,
        segments: messageSegments,
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
    list += `/tts 你好世界 --voice=${voices[0]}      # 指定声音\n`;
    list += `/tts 你好世界 --file              # 发送为mp3文件\n`;
    list += `/tts list                      # 查看此列表\n`;

    return list;
  }
}
