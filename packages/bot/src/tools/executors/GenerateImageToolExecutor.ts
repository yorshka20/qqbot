// GenerateImageToolExecutor — lets the reply LLM generate (text2img) or edit (img2img) an image
// from a natural-language description. This is the first-class tool counterpart to the user-facing
// /gpt2 and /banana commands: the LLM no longer has to guess command names through execute_command.
//
// Two modes, chosen automatically from the triggering message:
//   - If the message (or the message it replies to) carries one or more images, those are passed
//     as reference inputs and we run img2img. Multiple images are supported as multi-image
//     reference (compose / combine / edit) on providers that allow it (OpenAI gpt-image, Gemini).
//     The user's prompt is taken literally as the edit instruction — NOT scene-enriched, since the
//     enrichment template rewrites input into a from-scratch scene and would discard the source.
//   - Otherwise we run text2img and enrich the loose description via text2img.generate_banana, which
//     preserves any detail the user already gave and fills in what's missing.
//
// The generated image is sent straight to the originating chat via MessageAPI.sendFromContext
// (the same egress SendSystem uses); the tool then returns a short confirmation so the model can
// add a one-line caption instead of re-describing the picture.

import { inject, injectable } from 'tsyringe';
import type { AIService, Image2ImageOptions, Text2ImageOptions } from '@/ai';
import { extractImagesFromMessageAndReply, visionImageToString } from '@/ai/utils/imageUtils';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { buildMessageFromResponse } from '@/message/MessageBuilderUtils';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const ENRICH_TEMPLATE = 'text2img.generate_banana';

// Maps the user-facing `provider` choice to an AIService provider name + image model.
// gemini routes through the Laozhang relay (Gemini's own image API is too expensive); both
// pin the model explicitly so the tool's quality tier doesn't drift with provider config.
const PROVIDER_MAP = {
  gemini: { providerName: 'laozhang', model: 'gemini-3-pro-image-preview' },
  openai: { providerName: 'openai', model: 'gpt-image-2' },
} as const;

type ProviderKey = keyof typeof PROVIDER_MAP;

@Tool({
  name: 'generate_image',
  description:
    '根据自然语言描述生成图片并直接发送给用户。你只需把用户想要的画面用一句话写进 prompt，系统会自动润色补全细节（无需写长 prompt）。若用户消息里带了图片（或回复了一张带图的消息），系统会自动把这些图作为参考图进行「图生图」（改图/合成/风格迁移），支持多张参考图，你无需自己传图。支持 gemini（默认，画质高、懂中文与文字渲染）和 openai 两种绘图引擎。',
  executor: 'generate_image',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description:
        '画面描述或修改指令（中文即可）。文生图时写想要的画面，如 "一只坐在窗台上的橘猫，午后阳光"；图生图时写要怎么改这些参考图，如 "把这张图改成赛博朋克风格" 或 "把这两个人合成到同一张图里"。无需写成专业 prompt。',
    },
    provider: {
      type: 'string',
      required: false,
      enum: ['gemini', 'openai'],
      description: '绘图引擎，默认 gemini。用户明确点名某个引擎时才填。',
    },
    aspect_ratio: {
      type: 'string',
      required: false,
      description: '画面比例，如 "16:9"(横)、"9:16"(竖/手机壁纸)、"1:1"(方/头像)。省略则由系统按内容判断。',
    },
  },
  examples: [
    '画一只坐在窗台上的橘猫',
    '生成一张赛博朋克城市夜景的手机壁纸',
    '把这张图改成吉卜力风格',
    '把这两张图合成一张',
  ],
  triggerKeywords: ['画', '生成图', '画图', '绘图', '出图', 'draw', '画个', '画张', '来张图', '改图', 'p图', '合成'],
  whenToUse:
    '当用户希望你创作 / 生成图片，或基于消息里附带的图片做修改 / 合成时调用。把用户的意图原样用一句话写进 prompt 即可，不要自己堆砌冗长的英文 prompt——系统会负责润色，也会自动把消息里的图片当参考图。注意：若用户只是想识别/分析已有图片（而非生成新图），请改用 fetch_image。',
})
@injectable()
export class GenerateImageToolExecutor extends BaseToolExecutor {
  name = 'generate_image';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const prompt = (call.parameters?.prompt as string | undefined)?.trim();
    if (!prompt) {
      return this.error('请提供要生成的画面描述 (prompt)', 'Missing required parameter: prompt');
    }

    const hookContext = context.hookContext;
    if (!hookContext?.message) {
      return this.error('缺少上下文信息，无法发送图片', 'Missing hookContext.message');
    }

    const providerKey: ProviderKey = call.parameters?.provider === 'openai' ? 'openai' : 'gemini';
    const { providerName, model } = PROVIDER_MAP[providerKey];
    const aspectRatio = (call.parameters?.aspect_ratio as string | undefined)?.trim();

    const sourceImages = await this.collectSourceImages(hookContext.message);

    let response: Awaited<ReturnType<AIService['generateImg']>>;
    try {
      if (sourceImages.length > 0) {
        // img2img: prompt is the edit instruction, used literally (no scene enrichment).
        logger.info(
          `[GenerateImageToolExecutor] img2img | provider=${providerName} images=${sourceImages.length} | prompt=${prompt.substring(0, 50)}...`,
        );
        const img2imgOptions: Image2ImageOptions = {
          ...(model ? { model } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
        };
        response = await this.aiService.generateImageFromImage(
          hookContext,
          sourceImages,
          prompt,
          img2imgOptions,
          providerName,
        );
      } else {
        // text2img: enrich the user's loose description via the template.
        logger.info(
          `[GenerateImageToolExecutor] text2img | provider=${providerName} | prompt=${prompt.substring(0, 50)}...`,
        );
        const text2imgOptions: Text2ImageOptions = {
          prompt,
          ...(model ? { model } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
        };
        response = await this.aiService.generateImg(hookContext, text2imgOptions, providerName, false, ENRICH_TEMPLATE);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[GenerateImageToolExecutor] Image generation failed:', error);
      return this.error(`图片生成失败：${msg}`, `Image generation failed: ${msg}`);
    }

    if (!response.images || response.images.length === 0) {
      const detail = response.text?.trim();
      return this.error(
        detail ? `未能生成图片：${detail}` : '未能生成图片（引擎未返回任何图像）',
        detail ?? 'No images returned by provider',
      );
    }

    const segments = buildMessageFromResponse(response, '[GenerateImageToolExecutor]').build();
    await this.messageAPI.sendFromContext(segments, hookContext.message, 60000);

    const mode = sourceImages.length > 0 ? `图生图（参考${sourceImages.length}张）` : '文生图';
    logger.info(
      `[GenerateImageToolExecutor] Sent ${response.images.length} image(s) | provider=${providerName} | mode=${mode}`,
    );

    return this.success(
      `已用 ${providerKey} 完成${mode}并把图片发给用户了。你只需补一句简短自然的说明即可，不要重复描述画面内容。`,
      { provider: providerKey, mode, sourceImageCount: sourceImages.length, imageCount: response.images.length },
    );
  }

  /**
   * Extract reference images from the triggering message and any message it replies to.
   * Returns URL/base64/file strings ready for the img2img providers; empty array means text2img.
   */
  private async collectSourceImages(message: HookMessage): Promise<string[]> {
    try {
      const visionImages = await extractImagesFromMessageAndReply(message, this.messageAPI, this.databaseManager);
      return visionImages
        .map((img) => {
          try {
            return visionImageToString(img);
          } catch {
            return '';
          }
        })
        .filter((s): s is string => s.length > 0);
    } catch (error) {
      logger.warn(
        `[GenerateImageToolExecutor] Failed to extract source images: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return [];
    }
  }
}

type HookMessage = Parameters<typeof extractImagesFromMessageAndReply>[0];
