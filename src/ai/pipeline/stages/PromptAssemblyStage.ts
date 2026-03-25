// Prompt assembly stage — builds ChatMessage[] from accumulated context.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationMessageEntry } from '@/conversation/history';
import { NormalEpisodeService } from '@/conversation/history';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import type { VisionImage } from '../../capabilities/types';
import type { PromptManager } from '../../prompt/PromptManager';
import { PromptMessageAssembler } from '../../prompt/PromptMessageAssembler';
import type { ChatMessage, ContentPart } from '../../types';
import { extractImagesFromSegmentsAsync, normalizeVisionImages } from '../../utils/imageUtils';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 6: prompt assembly.
 * Builds the final `ChatMessage[]` from all accumulated context: system prompts
 * (base + scene), conversation history, memory, RAG context, task results, tool
 * instructions, and the current user query. Handles vision ContentPart injection
 * for history images and current message images.
 */
export class PromptAssemblyStage implements ReplyStage {
  readonly name = 'prompt-assembly';

  private readonly messageAssembler = new PromptMessageAssembler();

  constructor(
    private promptManager: PromptManager,
    private messageAPI: MessageAPI,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext } = ctx;

    // When whitelist is not full permissions, inject fragment into base system via variable.
    const groupCaps = hookContext.metadata.get('whitelistGroupCapabilities');
    const whitelistFragment =
      Array.isArray(groupCaps) && groupCaps.length > 0
        ? (this.promptManager.render('llm.whitelist_limited.system') ?? '').trim()
        : '';
    const baseSystemPrompt = this.promptManager.renderBasePrompt({
      whitelistLimitedFragment: whitelistFragment,
    });
    const contextInstruct = this.promptManager.render('llm.context.instruct');
    const toolInstruct = this.promptManager.render('llm.tool.instruct', {
      toolUsageInstructions: ctx.toolUsageInstructions,
    });

    const sceneSystemPrompt = this.promptManager.render('llm.reply.system', {
      contextInstruct,
      toolInstruct,
    });
    const sender = hookContext.message?.sender;
    const senderNickname = sender?.nickname ?? sender?.card ?? '';
    const senderUserId = hookContext.message?.userId ?? '';
    const senderIdentity = senderNickname ? `[speaker:${senderUserId}:${senderNickname}]` : `[speaker:${senderUserId}]`;

    const frameCurrentQuery = this.promptManager.render('llm.reply.user_frame', {
      userMessage: ctx.userMessage,
      senderIdentity,
    });
    const finalUserBlocks = {
      memoryContext: ctx.memoryContextText,
      ragContext: ctx.retrievedConversationSection,
      currentQuery: frameCurrentQuery,
    };

    const messages = this.messageAssembler.buildNormalMessages({
      baseSystem: baseSystemPrompt,
      sceneSystem: sceneSystemPrompt,
      historyEntries: ctx.historyEntries,
      finalUserBlocks,
    });

    // When selected provider has vision, replace history entries that contain images with ContentPart[] (text + base64 image_url).
    if (ctx.providerHasVision && ctx.historyEntries.length > 0) {
      const getResourceUrl = (resourceId: string) =>
        this.messageAPI.getResourceTempUrl(resourceId, hookContext.message);
      const systemCount = 2; // baseSystem + sceneSystem
      for (let i = 0; i < ctx.historyEntries.length; i++) {
        const entry = ctx.historyEntries[i];
        const hasImage = entry.segments?.some((s) => s.type === 'image');
        if (!hasImage || !entry.segments?.length) {
          continue;
        }
        try {
          const visionImages = await extractImagesFromSegmentsAsync(entry.segments, getResourceUrl);
          if (visionImages.length === 0) {
            continue;
          }
          const normalized = await normalizeVisionImages(visionImages, {
            timeout: 15000,
            maxSize: 5 * 1024 * 1024,
          });
          const parts = this.buildContentPartsForEntry(entry, normalized);
          const msgIndex = systemCount + i;
          if (msgIndex < messages.length) {
            messages[msgIndex] = { ...messages[msgIndex], content: parts };
          }
        } catch (err) {
          logger.warn(
            `[PromptAssemblyStage] Failed to resolve history images for entry ${entry.messageId}, keeping text placeholder:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // When selected provider has vision and current message has images, attach to last user message.
    if (ctx.providerHasVision && ctx.messageImages.length > 0) {
      const normalized = await normalizeVisionImages(ctx.messageImages, {
        timeout: 30000,
        maxSize: 10 * 1024 * 1024,
      });
      const imageParts: ContentPart[] = normalized
        .filter((img) => img.base64 || img.url)
        .map((img) => ({
          type: 'image_url' as const,
          image_url: {
            url: img.base64 ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` : (img.url ?? ''),
          },
        }));
      const last = messages[messages.length - 1];
      const lastContent: ContentPart[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, ...imageParts]
          : [...(last.content as ContentPart[]), ...imageParts];
      messages[messages.length - 1] = { ...last, content: lastContent };
    }

    this.messageHashCheck(messages);

    ctx.messages = messages;

    const maxTokens = ctx.toolDefinitions.length > 0 ? 4000 : 2000;
    ctx.genOptions = {
      temperature: 0.7,
      maxTokens,
      sessionId: ctx.sessionId,
      reasoningEffort: 'medium' as const,
      episodeKey: ctx.episodeKey,
    };

    // Debug log
    logger.debug(
      `[PromptAssemblyStage] Raw messages sent to provider (provider=${ctx.selectedProviderName ?? 'default'}):\n${JSON.stringify(
        messages,
        (_, v) => (typeof v === 'string' && v.startsWith('data:') && v.includes('base64,') ? '[base64 omitted]' : v),
        2,
      )}`,
    );
  }

  /** Build ContentPart[] for one history entry when provider has vision: text + image_url (data URL). */
  private buildContentPartsForEntry(entry: ConversationMessageEntry, normalizedImages: VisionImage[]): ContentPart[] {
    const textFromSegments = entry.segments
      ?.filter((s): s is MessageSegment & { type: 'text' } => s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
      .trim();
    const textContent = textFromSegments || entry.content || '';
    const prefix = entry.isBotReply ? '' : `[speaker:${entry.userId}:${entry.nickname ?? ''}] `;
    const parts: ContentPart[] = [{ type: 'text', text: prefix + textContent || '(no text)' }];
    for (const img of normalizedImages) {
      const mime = img.mimeType || 'image/jpeg';
      const url = img.base64 ? `data:${mime};base64,${img.base64}` : img.url;
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    return parts;
  }

  private messageHashCheck(messages: ChatMessage[]) {
    return new Promise(() => {
      const serialized = this.messageAssembler.serializeForFingerprint(messages);
      const fingerprint = NormalEpisodeService.hashMessages(serialized);
      logger.info(`[PromptAssemblyStage] Prompt fingerprint=${fingerprint} | messageCount=${messages.length}`);
    });
  }
}
