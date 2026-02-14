// I2V command - image-to-video via RunPod ComfyUI (Wan2.2 I2V workflow)

import type { AIService } from '@/ai/AIService';
import { extractImagesFromMessageAndReply, visionImageToBuffer } from '@/ai/utils/imageUtils';
import type { APIClient } from '@/api/APIClient';
import { FileAPI } from '@/api/methods/FileAPI';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { getSessionId } from '@/config/SessionUtils';
import { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { MessageBuilder } from '@/message/MessageBuilder';
import { ComfyUIClient } from '@/runpod';
import { uploadFileBuffer } from '@/utils/fileUpload';
import { logger } from '@/utils/logger';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inject, injectable } from 'tsyringe';
import { CommandArgsParser, type ParserConfig } from '../CommandArgsParser';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/** Poll interval for ComfyUI history (5 seconds as requested) */
const POLL_INTERVAL_MS = 5_000;

/** Local output directory for saved videos (relative to cwd) */
const OUTPUT_DIR = join(process.cwd(), 'output', 'runpod');

@Command({
  name: 'i2v',
  description: 'Image-to-video: generate video from image using RunPod ComfyUI (Wan2.2 I2V)',
  usage: '/i2v [prompt] [--seed=<number>] (send with one image)',
  permissions: ['user'],
  aliases: ['图生视频'],
})
@injectable()
export class I2vCommandHandler implements CommandHandler {
  name = 'i2v';
  description = 'Image-to-video: generate video from image using RunPod ComfyUI (Wan2.2 I2V)';
  usage = '/i2v [prompt] [--seed=<number>] (send with one image)';

  private readonly argsConfig: ParserConfig = {
    options: {
      seed: { property: 'seed', type: 'number' },
    },
  };

  private messageAPI: MessageAPI;
  private fileAPI: FileAPI;

  constructor(
    @inject(DITokens.CONFIG) private config: Config,
    @inject(DITokens.API_CLIENT) private apiClient: APIClient,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
  ) {
    this.messageAPI = new MessageAPI(this.apiClient);
    this.fileAPI = new FileAPI(this.apiClient);
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const runpodConfig = this.config.getRunpodConfig();
    if (!runpodConfig?.comfyUiBaseUrl) {
      return {
        success: false,
        error: 'RunPod ComfyUI is not configured. Add "runpod.comfyUiBaseUrl" in config.',
      };
    }

    // Extract images from current message and referenced reply
    let images: Awaited<ReturnType<typeof extractImagesFromMessageAndReply>> = [];
    if (context.originalMessage) {
      try {
        images = await extractImagesFromMessageAndReply(
          context.originalMessage,
          this.messageAPI,
          this.databaseManager,
        );
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
        error: 'Please send one image (with or without reply). Usage: /i2v [prompt] [--seed=<number>]',
      };
    }

    if (images.length > 1) {
      logger.info(`[I2vCommandHandler] Using first of ${images.length} images`);
    }

    try {
      const { text: promptArg, options } = CommandArgsParser.parse<{ seed?: number }>(args, this.argsConfig);
      const sessionId = getSessionId(context);
      const processedPrompt = await this.aiService.prepareI2VPrompt(promptArg ?? '', sessionId, 'img2video.generate');

      const imageBuffer = await visionImageToBuffer(images[0]!, { timeout: 30000, maxSize: 10 * 1024 * 1024 });
      logger.info(`[I2vCommandHandler] Image size: ${imageBuffer.length} bytes, prompt: ${processedPrompt.substring(0, 50)}...`);

      const client = new ComfyUIClient(runpodConfig.comfyUiBaseUrl, {
        pollIntervalMs: POLL_INTERVAL_MS,
        timeoutMs: 600_000,
      });

      const videoBuffer = await client.animateImage(
        imageBuffer,
        processedPrompt,
        options.seed !== undefined ? { seed: options.seed } : undefined,
      );

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
