// GenerateImageToolExecutor — lets the reply LLM generate (text2img) or edit (img2img) an image
// from a natural-language description. This is the first-class tool counterpart to the user-facing
// /gpt2 and /banana commands: the LLM no longer has to guess command names through execute_command.
//
// Two modes, chosen from the triggering message plus any cited reference presets:
//   - If the message (or the message it replies to) carries images, or the call cites presets,
//     those references are passed through ImageRequestAssembler and we run img2img. The assembler
//     is provider-neutral: gpt-image and Gemini receive every reference image, NovelAI would use
//     the first. Preset descriptions are appended after the tool prompt, verbatim.
//   - Otherwise we run text2img. The tool prompt is sent to the provider as written.
//     A second LLM pass (text2img.generate_banana) is for user commands such as /banana, not for
//     a prompt the calling model already wrote.
//
// The generated image is sent straight to the originating chat via MessageAPI.sendFromContext
// (the same egress SendSystem uses); the tool then returns a short confirmation so the model can
// add a one-line caption instead of re-describing the picture.

import { inject, injectable } from 'tsyringe';
import type { Image2ImageOptions, Text2ImageOptions } from '@/ai';
import { AIService } from '@/ai/AIService';
import { ImageRequestAssembler } from '@/ai/services/ImageRequestAssembler';
import { extractImagesFromMessageAndReply, visionImageToString } from '@/ai/utils/imageUtils';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { DatabaseManager } from '@/database/DatabaseManager';
import { buildMessageFromResponse } from '@/message/MessageBuilderUtils';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolModelDescription, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

// Maps the user-facing `provider` choice to an AIService provider name + image model.
// gemini routes through the Laozhang relay (Gemini's own image API is too expensive); both
// pin the model explicitly so the tool's quality tier doesn't drift with provider config.
const PROVIDER_MAP = {
  gemini: { providerName: 'laozhang', model: 'gemini-3-pro-image-preview' },
  openai: { providerName: 'openai', model: 'gpt-image-2' },
} as const;

type ProviderKey = keyof typeof PROVIDER_MAP;

/** Live preset catalog for the tool schema. Precise descriptions stay out of this view. */
export function describeGenerateImageForModel(): ToolModelDescription {
  const presets = ImageRequestAssembler.list();
  const empty =
    '本地参考 preset 的 id 列表（image-presets/<id>/preset.json）。当前没有可用 preset。画面需要复用某个常驻角色或元素时才填，openai 与 gemini 共用同一套拼装。';
  if (presets.length === 0) {
    return {
      parameterOverrides: {
        presets: {
          type: 'array',
          required: false,
          items: { type: 'string' },
          description: empty,
        },
      },
    };
  }
  const catalog = presets
    .map((preset) => {
      const aliases = preset.aliases.length > 0 ? `；${preset.aliases.join('、')}` : '';
      return `- ${preset.id}（${preset.name}${aliases}，${preset.imageCount} 张参考图）`;
    })
    .join('\n');
  return {
    parameterOverrides: {
      presets: {
        type: 'array',
        required: false,
        items: { type: 'string', enum: presets.map((preset) => preset.id) },
        description:
          '填入对应 id 的两种情况：用户这句话里出现了下列任一称呼；当前任务明确写出了某个 id（子任务、定时任务点名的 id 同样要填）。可以填多个。系统会附上参考图和精确描述，不要把精确描述抄进 prompt。称呼和任务都没点名就留空。\n' +
          catalog,
      },
    },
  };
}

@Tool({
  name: 'generate_image',
  description:
    '根据自然语言描述生成图片并直接发送给用户。prompt 会原样交给绘图模型，不会再经一轮改写，所以把画面写完整：主体、动作、表情、构图；多格要写明格数、阅读顺序和每一格。消息里带了图，或填了 preset 时，系统另附参考图和外形，不要把外形抄进 prompt。需要复用某个常驻角色或元素时，在 presets 里引用它的 id。支持 openai（默认，gpt-image-2）和 gemini，两边共用同一套参考拼装。',
  executor: 'generate_image',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description:
        '直接交给绘图模型的画面指令（中文即可）。写完整：主体、动作、表情、构图。多格写明格数、阅读顺序和每一格发生的事。有参考图或 preset 时不要写角色的服装、身体、配色。',
    },
    provider: {
      type: 'string',
      required: false,
      enum: ['gemini', 'openai'],
      description: '绘图引擎，默认 openai（gpt-image-2）。用户明确点名 gemini 时才填 gemini。',
    },
    aspect_ratio: {
      type: 'string',
      required: false,
      description:
        '仅 gemini。画面比例，如 "16:9"(横)、"9:16"(竖)、"1:1"(方)。openai 不接受这个参数，改填 size。省略则由系统按内容判断。',
    },
    size: {
      type: 'string',
      required: false,
      enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      description:
        '仅 openai。分辨率，不是比例：方图 "1024x1024"，横图 "1536x1024"，竖图 "1024x1536"，或 "auto"。gemini 不要填。',
    },
    presets: {
      type: 'array',
      required: false,
      items: { type: 'string' },
      description: '本地参考 preset 的 id 列表。画面涉及某个常驻角色或元素时填写，系统会附上它的参考图和精确描述。',
    },
  },
  describeForModel: describeGenerateImageForModel,
  examples: [
    '画一只坐在窗台上的橘猫',
    '生成一张赛博朋克城市夜景的手机壁纸',
    '把这张图改成吉卜力风格',
    '把这两张图合成一张',
  ],
  triggerKeywords: ['画', '生成图', '画图', '绘图', '出图', 'draw', '画个', '画张', '来张图', '改图', 'p图', '合成'],
  whenToUse:
    '当用户希望你创作 / 生成图片，或基于消息里附带的图片做修改 / 合成时调用。prompt 会原样交给绘图模型，把画面写完整。有参考图或 preset 时系统会附上它们，不要把外形抄进 prompt。注意：若用户只是想识别/分析已有图片（而非生成新图），请改用 fetch_image。',
})
@injectable()
export class GenerateImageToolExecutor extends BaseToolExecutor {
  name = 'generate_image';

  constructor(
    @inject(AIService) private aiService: AIService,
    @inject(MessageAPI) private messageAPI: MessageAPI,
    @inject(DatabaseManager) private databaseManager: DatabaseManager,
    @inject(ConversationHistoryService) private conversationHistoryService: ConversationHistoryService,
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

    const providerKey: ProviderKey = call.parameters?.provider === 'gemini' ? 'gemini' : 'openai';
    const { providerName, model } = PROVIDER_MAP[providerKey];
    const frame = readFrame(providerKey, call.parameters?.aspect_ratio, call.parameters?.size);
    const presetIds = readPresetIds(call.parameters?.presets);
    if (typeof presetIds === 'string') {
      return this.error(presetIds, presetIds);
    }

    const messageImages = await this.collectSourceImages(hookContext.message);
    const useReferences = messageImages.length > 0 || presetIds.length > 0;

    let response: Awaited<ReturnType<AIService['generateImg']>>;
    try {
      if (useReferences) {
        // img2img: prompt is the edit instruction, used literally (no scene enrichment).
        // Preset images and descriptions are attached by ImageRequestAssembler inside the facade.
        logger.info(
          `[GenerateImageToolExecutor] img2img | provider=${providerName} messageImages=${messageImages.length} presets=${presetIds.join(',') || '-'} | prompt=${prompt.substring(0, 50)}...`,
        );
        const img2imgOptions: Image2ImageOptions = {
          ...(model ? { model } : {}),
          ...frame,
          ...(presetIds.length > 0 ? { presetIds } : {}),
        };
        response = await this.aiService.generateImageFromImage(
          hookContext,
          messageImages,
          prompt,
          img2imgOptions,
          providerName,
        );
      } else {
        // text2img: the calling model wrote this prompt. Do not run another LLM over it.
        logger.info(
          `[GenerateImageToolExecutor] text2img | provider=${providerName} | prompt=${prompt.substring(0, 50)}...`,
        );
        const text2imgOptions: Text2ImageOptions = {
          prompt,
          ...(model ? { model } : {}),
          ...frame,
        };
        response = await this.aiService.generateImg(hookContext, text2imgOptions, providerName, true);
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
    const sendResult = await this.messageAPI.sendFromContext(segments, hookContext.message, 60000);

    const mode = useReferences ? `图生图（消息图${messageImages.length}张，preset ${presetIds.length}个）` : '文生图';
    logger.info(
      `[GenerateImageToolExecutor] Sent ${response.images.length} image(s) | provider=${providerName} | mode=${mode}`,
    );

    // This send bypasses SendSystem/onMessageSent — persist explicitly so the
    // conversation history keeps a record of the delivered image (as text).
    await this.persistSentImage(hookContext, prompt, mode, sendResult.message_seq);

    return this.success(
      `已用 ${providerKey} 完成${mode}并把图片发给用户了。你只需补一句简短自然的说明即可，不要重复描述画面内容。`,
      {
        provider: providerKey,
        mode,
        sourceImageCount: messageImages.length,
        presetIds,
        imageCount: response.images.length,
      },
    );
  }

  private async persistSentImage(
    hookContext: NonNullable<ToolExecutionContext['hookContext']>,
    prompt: string,
    mode: string,
    messageSeq?: number,
  ): Promise<void> {
    const message = hookContext.message;
    const isGroup = message.messageType === 'group';
    const targetId = isGroup ? message.groupId : message.userId;
    if (targetId == null) return;
    const botSelfId = Number(hookContext.metadata.get('botSelfId'));
    await this.conversationHistoryService.appendBotMessageToSession(
      { sessionType: isGroup ? 'group' : 'user', targetId },
      `[已发送AI生成图片｜${mode}] ${prompt}`,
      message.protocol,
      {
        botUserId: Number.isNaN(botSelfId) ? 0 : botSelfId,
        messageSeq,
        viaTool: 'generate_image',
      },
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

const OPENAI_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);

/** Gemini takes aspect_ratio. OpenAI takes a pixel size and rejects aspect_ratio. */
function readFrame(
  provider: ProviderKey,
  aspectRatio: unknown,
  size: unknown,
): { aspectRatio: string } | { imageSize: string } | Record<string, never> {
  if (provider === 'openai') {
    const value = typeof size === 'string' ? size.trim() : '';
    return OPENAI_SIZES.has(value) ? { imageSize: value } : {};
  }
  const ratio = typeof aspectRatio === 'string' ? aspectRatio.trim() : '';
  return ratio ? { aspectRatio: ratio } : {};
}

/** Returns an error string when the value is present but not a string array. */
function readPresetIds(value: unknown): string[] | string {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return 'presets 必须是字符串 id 数组';
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    const id = entry.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
