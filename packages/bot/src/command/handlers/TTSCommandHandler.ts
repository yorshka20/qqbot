import type { TTSManager, TTSProvider } from '@qqbot/avatar';
import { inject, injectable } from 'tsyringe';
import type { APIClient } from '@/api/APIClient';
import { FileAPI } from '@/api/methods/FileAPI';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { MessageUtils } from '@/message/MessageUtils';
import { uploadFileBuffer } from '@/utils/fileUpload';
import { logger } from '@/utils/logger';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * TTS command — converts text to speech via the bot-wide `TTSManager`.
 *
 * Provider selection (highest priority first):
 *   1. `--provider=<name>` flag
 *   2. `TTSManager.getDefault()` (driven by `tts.defaultProvider` in config)
 *
 * The handler no longer owns any voice map or API URL — all of that lives
 * inside the provider config. This keeps the command renderer-agnostic and
 * lets new providers (SoVITS, future RVC, etc.) work without handler edits.
 */
@Command({
  name: 'tts',
  description:
    'Convert text to speech. Example: /tts 你好世界 --voice=丁真 --provider=fish-audio. Use /tts list to see providers and voices.',
  usage: '/tts <text> [--voice=<voice>] [--provider=<name>] [--file] | /tts list',
  permissions: ['user'], // All users can use TTS
  aliases: ['say', 'speak'],
})
@injectable()
export class TTSCommandHandler implements CommandHandler {
  name = 'tts';
  description =
    'Convert text to speech. Example: /tts 你好世界 --voice=丁真 --provider=fish-audio. Use /tts list to see providers and voices.';
  usage = '/tts <text> [--voice=<voice>] [--provider=<name>] [--file] | /tts list';

  // Maximum text length (in characters)
  private readonly MAX_TEXT_LENGTH = 1000;

  // Command parameter configuration
  private readonly argsConfig: ParserConfig = {
    options: {
      voice: { property: 'voice', type: 'string' },
      provider: { property: 'provider', type: 'string' },
      rate: { property: 'rate', type: 'string' },
      pitch: { property: 'pitch', type: 'string' },
      file: { property: 'file', type: 'boolean' },
      random: { property: 'random', type: 'boolean' },
    },
  };

  private fileAPI: FileAPI;

  constructor(
    @inject(DITokens.TTS_MANAGER) private ttsManager: TTSManager,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
  ) {
    this.fileAPI = new FileAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Check if user wants to list available providers / voices
    if (
      args.length === 0 ||
      (args.length === 1 && (args[0] === 'list' || args[0] === '--list' || args[0] === '-list'))
    ) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.text(this.getProviderList());
      return {
        success: true,
        segments: messageBuilder.build(),
      };
    }

    try {
      // Parse arguments
      const { text, options } = CommandArgsParser.parse<{
        voice?: string;
        provider?: string;
        rate?: string;
        pitch?: string;
        file?: boolean;
        random?: boolean;
      }>(args, this.argsConfig);

      if (text.length > this.MAX_TEXT_LENGTH) {
        return {
          success: false,
          error: `Text is too long. Maximum length is ${this.MAX_TEXT_LENGTH} characters, but got ${text.length} characters.`,
        };
      }

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

      // ── Select provider ──
      let provider: TTSProvider | null;
      if (options.provider) {
        provider = this.ttsManager.get(options.provider);
        if (!provider) {
          const available =
            this.ttsManager
              .listAll()
              .map((p) => p.name)
              .join(', ') || '(none)';
          return {
            success: false,
            error: `TTS provider "${options.provider}" is not registered. Available: ${available}`,
          };
        }
        if (!provider.isAvailable()) {
          return {
            success: false,
            error: `TTS provider "${options.provider}" is registered but not available (missing API key / endpoint).`,
          };
        }
      } else {
        provider = this.ttsManager.getDefault();
        if (!provider) {
          return {
            success: false,
            error:
              'No TTS provider is configured. Add an entry to `tts.providers[]` and set `tts.defaultProvider` in config.',
          };
        }
      }

      // ── Resolve voice (optional) ──
      let voice: string | undefined = options.voice;
      if (!voice && options.random && provider.listVoices) {
        const list = provider.listVoices();
        if (list.length > 0) {
          voice = list[Math.floor(Math.random() * list.length)];
        }
      }
      if (voice && provider.listVoices) {
        const list = provider.listVoices();
        if (list.length > 0 && !list.includes(voice)) {
          return {
            success: false,
            error: `Voice "${voice}" not available on provider "${provider.name}". Available: ${list.join('、')}`,
          };
        }
      }

      logger.info(
        `[TTSCommandHandler] Synthesizing via provider="${provider.name}" voice="${voice ?? '(default)'}" text="${text.substring(0, 50)}..."`,
      );

      // ── Synthesize ──
      const result = await provider.synthesize(text, { voice });
      const audioBuffer = Buffer.from(result.bytes);
      const format = result.mime === 'audio/wav' ? 'wav' : 'mp3';

      const messageBuilder = new MessageBuilder();
      if (options.file) {
        try {
          const filename = `tts_${Date.now()}.${format}`;
          const fileId = await uploadFileBuffer(this.fileAPI, audioBuffer, filename, context, 30000);
          messageBuilder.file({ file_id: fileId, file_name: filename });
          logger.debug(`[TTSCommandHandler] Built file segment file_id=${fileId} file_name=${filename}`);
        } catch (fileError) {
          logger.error('[TTSCommandHandler] Failed to upload file, falling back to record segment:', fileError);
          messageBuilder.record({ data: audioBuffer.toString('base64') });
        }
      } else {
        messageBuilder.record({ data: audioBuffer.toString('base64') });
      }

      return {
        success: true,
        segments: messageBuilder.build(),
        sentAsForward: false,
      };
    } catch (error) {
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String((error as { message: unknown }).message);
      } else {
        errorMessage = String(error);
      }

      logger.error('[TTSCommandHandler] Failed to synthesize speech:', error);
      return {
        success: false,
        error: `Failed to synthesize speech: ${errorMessage}`,
      };
    }
  }

  /** Render a human-readable summary of registered providers + their voices. */
  private getProviderList(): string {
    const defaultProvider = this.ttsManager.getDefault();
    const all = this.ttsManager.listAll();
    if (all.length === 0) {
      return '❌ 当前没有配置任何 TTS provider。请在 config 的 `tts.providers[]` 里添加一项。';
    }

    const lines: string[] = ['📢 TTS providers:'];
    for (const p of all) {
      const marks: string[] = [];
      if (p.name === defaultProvider?.name) marks.push('默认');
      if (!p.isAvailable()) marks.push('不可用');
      const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
      lines.push(`• ${p.name}${suffix}`);
      const voices = p.listVoices?.();
      if (voices && voices.length > 0) {
        lines.push(`   voices: ${voices.join('、')}`);
      }
    }
    lines.push('');
    lines.push('用法示例：');
    lines.push('/tts 你好世界                          # 默认 provider + 默认 voice');
    lines.push('/tts 你好 --provider=fish-audio        # 指定 provider');
    lines.push('/tts 你好 --voice=丁真                  # 指定 voice');
    lines.push('/tts 你好 --random                      # 当前 provider 随机 voice');
    lines.push('/tts 你好 --file                        # 发送为文件而非语音段');
    lines.push('/tts list                              # 查看此列表');
    return lines.join('\n');
  }
}
