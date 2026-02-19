// I2V command - image-to-video via RunPod provider (ComfyUI Wan2.2 I2V)

import type { AIManager } from '@/ai/AIManager';
import type { AIService } from '@/ai/AIService';
import { isImage2VideoCapability } from '@/ai/capabilities/Image2VideoCapability';
import { prepareImageForI2v } from '@/ai/utils/imageResize';
import { extractImagesFromMessageAndReply, visionImageToBuffer } from '@/ai/utils/imageUtils';
import type { APIClient } from '@/api/APIClient';
import { FileAPI } from '@/api/methods/FileAPI';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { getSessionId } from '@/config/SessionUtils';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { MessageBuilder } from '@/message/MessageBuilder';
import { uploadFileBuffer } from '@/utils/fileUpload';
import { logger } from '@/utils/logger';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** Local output directory for saved videos (relative to cwd) */
const OUTPUT_DIR = join(process.cwd(), 'output', 'runpod');

@Command({
  name: 'i2v',
  description: 'Image-to-video: generate video from image using RunPod Serverless ComfyUI (Wan2.2 I2V Remix)',
  usage: '/i2v [prompt] [--seed=<number>] [--duration=<1-30>] (send with one image)',
  permissions: ['user'],
  aliases: ['图生视频'],
})
@injectable()
export class I2vCommandHandler implements CommandHandler {
  name = 'i2v';
  description = 'Image-to-video: generate video from image using RunPod Serverless ComfyUI (Wan2.2 I2V Remix)';
  usage = '/i2v [prompt] [--seed=<number>] [--duration=<1-30>] (send with one image)';

  private readonly argsConfig: ParserConfig = {
    options: {
      seed: { property: 'seed', type: 'number' },
      duration: { property: 'duration', type: 'number' },
    },
  };

  private messageAPI: MessageAPI;
  private fileAPI: FileAPI;

  constructor(
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
  ) {
    this.messageAPI = new MessageAPI(this.apiClient);
    this.fileAPI = new FileAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const i2vProvider = this.aiManager.getProviderForCapability('i2v', 'runpod')
      ?? this.aiManager.getDefaultProvider('i2v');
    if (!i2vProvider?.isAvailable() || !isImage2VideoCapability(i2vProvider)) {
      return {
        success: false,
        error: 'RunPod I2V is not configured. Add runpod provider in ai.providers with endpointId and apiKey.',
      };
    }

    // Extract images from current message and referenced reply
    let images: Awaited<ReturnType<typeof extractImagesFromMessageAndReply>> = [];
    if (context.originalMessage) {
      try {
        images = await extractImagesFromMessageAndReply(context.originalMessage, this.messageAPI, this.databaseManager);
        logger.debug(`[I2vCommandHandler] Extracted ${images.length} image(s) from message`);
      } catch (error) {
        logger.warn(
          `[I2vCommandHandler] Failed to extract images: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    if (images.length === 0) {
      return {
        success: false,
        error:
          'Please send one image (with or without reply). Usage: /i2v [prompt] [--seed=<number>] [--duration=<1-30>]',
      };
    }

    if (images.length > 1) {
      logger.info(`[I2vCommandHandler] Using first of ${images.length} images`);
    }

    try {
      const { text: promptArg, options } = CommandArgsParser.parse<{ seed?: number; duration?: number }>(
        args,
        this.argsConfig,
      );
      const sessionId = getSessionId(context);
      const aiResult = await this.aiService.prepareI2VPrompt(promptArg ?? '', sessionId, 'img2video.generate');

      // User --duration overrides AI duration
      const durationSeconds =
        options.duration != null ? Math.max(1, Math.min(30, Math.round(options.duration))) : aiResult.durationSeconds;

      let imageBuffer = await visionImageToBuffer(images[0]!, { timeout: 30000, maxSize: 10 * 1024 * 1024 });
      logger.info(
        `[I2vCommandHandler] Image fetched: ${imageBuffer.length} bytes, prompt: ${aiResult.prompt}, duration: ${durationSeconds}s`,
      );

      // Scale proportionally to fit within 480×832 / 832×480, file size under 500 KB (keeps aspect ratio)
      imageBuffer = await prepareImageForI2v(imageBuffer);
      logger.info(`[I2vCommandHandler] Image after prepare: ${imageBuffer.length} bytes`);

      const videoBuffer = await i2vProvider.generateVideoFromImage(imageBuffer, aiResult.prompt, {
        seed: options.seed,
        durationSeconds,
        negativePrompt: aiResult.negativePrompt,
      });

      // Save to local output directory
      if (!existsSync(OUTPUT_DIR)) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
      }
      const timestamp = Date.now();
      const localFilename = `i2v_${timestamp}.mp4`;
      const localPath = join(OUTPUT_DIR, localFilename);
      writeFileSync(localPath, videoBuffer);
      logger.info(`[I2vCommandHandler] Saved video to ${localPath}`);

      // Upload and reply via qqbot
      const fileId = await uploadFileBuffer(this.fileAPI, videoBuffer, localFilename, context, 60000);
      const messageBuilder = new MessageBuilder();
      messageBuilder.file({ file_id: fileId, file_name: localFilename });

      return {
        success: true,
        segments: messageBuilder.build(),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[I2vCommandHandler] Failed to generate video:', err);
      return {
        success: false,
        error: `Failed to generate video: ${err.message}`,
      };
    }
  }
}
