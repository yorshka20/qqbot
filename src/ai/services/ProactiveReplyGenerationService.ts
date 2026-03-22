// Proactive reply generation service — generates proactive replies for group participation.

import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { ProactiveReplyInjectContext } from '@/context/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { PluginManager } from '@/plugins/PluginManager';
import type { WhitelistPlugin } from '@/plugins/plugins/WhitelistPlugin';
import type { ToolManager } from '@/tools/ToolManager';
import type { VisionImage } from '../capabilities/types';
import type { PromptManager } from '../prompt/PromptManager';
import { PromptMessageAssembler } from '../prompt/PromptMessageAssembler';
import { buildSkillUsageInstructions, executeSkillCall, getReplySkillDefinitions } from '../tools/replyTools';
import type { AIGenerateResponse, ChatMessage, ContentPart } from '../types';
import { normalizeVisionImages } from '../utils/imageUtils';
import type { LLMService } from './LLMService';
import type { VisionService } from './VisionService';

/** Proactive reply: max history entries in prompt. */
const PROACTIVE_MAX_HISTORY_ENTRIES = 24;

const PROACTIVE_GEN_OPTIONS = {
  temperature: 0.5,
  maxTokens: 2000,
  maxToolRounds: 10,
} as const;

/**
 * Proactive reply generation service for group participation.
 * Builds prompts from a {@link ProactiveReplyInjectContext} (preference, thread,
 * RAG, memory, history) and calls the LLM with vision/tool support.
 * Constructs a synthetic HookContext for tool execution within the proactive flow.
 */
export class ProactiveReplyGenerationService {
  private readonly messageAssembler = new PromptMessageAssembler();

  constructor(
    private llmService: LLMService,
    private visionService: VisionService,
    private hookManager: HookManager,
    private promptManager: PromptManager,
    private toolManager: ToolManager,
  ) {}

  /**
   * Generate a single proactive reply for group participation.
   * All injectable text (preference, thread, RAG, memory) is provided via context from the context layer.
   */
  async generateProactiveReply(context: ProactiveReplyInjectContext, providerName?: string): Promise<string> {
    const useVision = Boolean(context.messageImages?.length);
    const capabilities = await this.resolveProviderAndCapabilities(context, providerName, useVision);
    const { tools, toolUsageInstructions } = this.getToolsAndInstructions(
      capabilities.canUseToolUse,
      capabilities.nativeWebSearchEnabled,
    );
    const { baseSystemPrompt, proactiveSystemPrompt, finalUserQuery } = this.buildPrompts(
      context,
      toolUsageInstructions,
    );
    const { historyEntries, finalUserBlocks } = this.getHistoryAndUserBlocks(context, finalUserQuery);

    const messages = this.messageAssembler.buildProactiveMessages({
      baseSystem: baseSystemPrompt,
      sceneSystem: proactiveSystemPrompt,
      historyEntries,
      finalUserBlocks,
    });
    const proactiveMessages = useVision
      ? await this.attachVisionImagesToLastUserMessage(messages, context.messageImages ?? [])
      : messages;

    const response = await this.executeLLM(proactiveMessages, context, capabilities, tools, useVision);
    return response.text;
  }

  // ---------------------------------------------------------------------------
  // Provider & capabilities
  // ---------------------------------------------------------------------------

  private async resolveProviderAndCapabilities(
    context: ProactiveReplyInjectContext,
    providerName: string | undefined,
    useVision: boolean,
  ): Promise<{
    effectiveProviderName: string | undefined;
    canUseToolUse: boolean;
    nativeWebSearchEnabled: boolean;
  }> {
    const sessionId = context.sessionId;
    const effectiveProviderName = useVision
      ? ((await this.visionService.getAvailableProviderName(providerName, sessionId)) ?? providerName)
      : providerName;
    const canUseToolUse = useVision
      ? Boolean(effectiveProviderName && (await this.llmService.supportsToolUse(effectiveProviderName, sessionId)))
      : await this.llmService.supportsToolUse(effectiveProviderName, sessionId);
    const nativeWebSearchEnabled = canUseToolUse
      ? await this.llmService.supportsNativeWebSearch(effectiveProviderName, sessionId)
      : false;
    return { effectiveProviderName, canUseToolUse, nativeWebSearchEnabled };
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private getToolsAndInstructions(
    canUseToolUse: boolean,
    nativeWebSearchEnabled: boolean,
  ): { tools: ReturnType<typeof getReplySkillDefinitions>; toolUsageInstructions: string } {
    if (!canUseToolUse) {
      return { tools: [], toolUsageInstructions: '当前没有可用工具，请直接回答。' };
    }
    const tools = getReplySkillDefinitions(this.toolManager, { nativeWebSearchEnabled });
    const toolUsageInstructions = buildSkillUsageInstructions(
      this.toolManager,
      tools,
      { nativeWebSearchEnabled },
      this.promptManager,
    );
    return { tools, toolUsageInstructions };
  }

  // ---------------------------------------------------------------------------
  // Prompt building
  // ---------------------------------------------------------------------------

  private buildPrompts(
    context: ProactiveReplyInjectContext,
    toolUsageInstructions: string,
  ): { baseSystemPrompt: string; proactiveSystemPrompt: string; finalUserQuery: string } {
    let whitelistFragment = '';
    if (context.sessionId) {
      const pluginManager = getContainer().resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
      const whitelistPlugin = pluginManager?.getPluginAs<WhitelistPlugin>('whitelist');
      const caps = whitelistPlugin?.getGroupCapabilities?.(context.sessionId);
      if (caps && caps.length > 0) {
        const rendered = this.promptManager.render('llm.whitelist_limited.system');
        if (rendered?.trim()) {
          whitelistFragment = rendered.trim();
        }
      }
    }
    const baseSystemPrompt = this.promptManager.renderBasePrompt({ whitelistLimitedFragment: whitelistFragment }) ?? '';
    const contextInstruct = this.promptManager.render('llm.context.instruct');
    const toolInstruct = this.promptManager.render('llm.tool.instruct', { toolUsageInstructions });
    const proactiveSystemPrompt = this.promptManager.render('llm.proactive.system', {
      contextInstruct,
      preferenceText: context.preferenceText,
      toolInstruct,
    });
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const finalUserQuery = this.promptManager.render('llm.proactive.user_frame', { lastUserMessage }) ?? '';
    return { baseSystemPrompt, proactiveSystemPrompt, finalUserQuery };
  }

  // ---------------------------------------------------------------------------
  // History & user blocks
  // ---------------------------------------------------------------------------

  private getHistoryAndUserBlocks(
    context: ProactiveReplyInjectContext,
    finalUserQuery: string,
  ): {
    historyEntries: NonNullable<ProactiveReplyInjectContext['historyEntries']>;
    finalUserBlocks: { memoryContext: string; ragContext: string; searchResults: string; currentQuery: string };
  } {
    const rawHistory = context.historyEntries ?? [];
    const historyEntries =
      rawHistory.length <= PROACTIVE_MAX_HISTORY_ENTRIES
        ? rawHistory
        : rawHistory.slice(-PROACTIVE_MAX_HISTORY_ENTRIES);
    const finalUserBlocks = {
      memoryContext: context.memoryContext ?? '',
      ragContext: context.retrievedConversationSection ?? '',
      searchResults: context.retrievedContext ?? '',
      currentQuery: finalUserQuery,
    };
    return { historyEntries, finalUserBlocks };
  }

  // ---------------------------------------------------------------------------
  // LLM execution
  // ---------------------------------------------------------------------------

  private async executeLLM(
    messages: ChatMessage[],
    context: ProactiveReplyInjectContext,
    capabilities: {
      effectiveProviderName: string | undefined;
      canUseToolUse: boolean;
      nativeWebSearchEnabled: boolean;
    },
    tools: ReturnType<typeof getReplySkillDefinitions>,
    useVision: boolean,
  ): Promise<AIGenerateResponse> {
    const { effectiveProviderName, canUseToolUse, nativeWebSearchEnabled } = capabilities;
    const genOptions = {
      ...PROACTIVE_GEN_OPTIONS,
      sessionId: context.sessionId,
    };
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const hookContext = this.buildToolHookContext(context, lastUserMessage);
    const toolExecutor = (call: { name: string; arguments: string }) =>
      executeSkillCall(call, hookContext, this.toolManager, this.hookManager);
    const useTools = canUseToolUse && effectiveProviderName && tools.length > 0;

    if (useVision) {
      if (useTools) {
        const toolUseResponse = await this.llmService.generateWithTools(
          messages,
          tools,
          {
            temperature: genOptions.temperature,
            maxTokens: genOptions.maxTokens,
            maxToolRounds: genOptions.maxToolRounds,
            sessionId: genOptions.sessionId,
            nativeWebSearch: nativeWebSearchEnabled,
            toolExecutor,
          },
          effectiveProviderName,
        );
        return { text: toolUseResponse.text };
      }
      return this.visionService.generateWithVisionMessages(
        messages,
        { temperature: genOptions.temperature, maxTokens: genOptions.maxTokens, sessionId: genOptions.sessionId },
        effectiveProviderName,
      );
    }
    if (useTools) {
      const toolUseResponse = await this.llmService.generateWithTools(
        messages,
        tools,
        {
          temperature: genOptions.temperature,
          maxTokens: genOptions.maxTokens,
          maxToolRounds: genOptions.maxToolRounds,
          sessionId: genOptions.sessionId,
          nativeWebSearch: nativeWebSearchEnabled,
          toolExecutor,
        },
        effectiveProviderName,
      );
      return { text: toolUseResponse.text };
    }
    return this.llmService.generateMessages(messages, genOptions, effectiveProviderName);
  }

  // ---------------------------------------------------------------------------
  // Vision image helpers
  // ---------------------------------------------------------------------------

  private async attachVisionImagesToLastUserMessage(
    messages: ChatMessage[],
    images: VisionImage[],
  ): Promise<ChatMessage[]> {
    if (messages.length === 0 || images.length === 0) {
      return messages;
    }
    const normalized = await normalizeVisionImages(images, {
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
    if (imageParts.length === 0) {
      return messages;
    }
    const last = messages[messages.length - 1];
    const lastContent: ContentPart[] =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }, ...imageParts]
        : [...(last.content ?? []), ...imageParts];
    return [...messages.slice(0, -1), { ...last, content: lastContent }];
  }

  // ---------------------------------------------------------------------------
  // HookContext builder for tool execution in proactive flow
  // ---------------------------------------------------------------------------

  private buildToolHookContext(context: ProactiveReplyInjectContext, lastUserMessage: string) {
    const sessionId = context.sessionId ?? 'group:0';
    const groupId = this.parseGroupIdFromSessionId(sessionId);
    const history = this.mapHistoryToConversationFormat(context.historyEntries);

    return HookContextBuilder.create()
      .withSyntheticMessage({
        userId: 0,
        groupId,
        messageType: 'group',
        message: lastUserMessage,
        segments: [],
        protocol: 'milky',
      })
      .withConversationContext({
        userMessage: lastUserMessage,
        history,
        userId: 0,
        groupId,
        messageType: 'group',
        metadata: new Map(),
      })
      .withMetadata('sessionId', sessionId)
      .withMetadata('sessionType', 'group')
      .withMetadata('contextMode', 'proactive')
      .withMetadata('groupId', groupId)
      .withMetadata('userId', 0)
      .build();
  }

  private parseGroupIdFromSessionId(sessionId: string): number {
    const match = /^group:(\d+)$/.exec(sessionId);
    return match ? parseInt(match[1], 10) : 0;
  }

  private mapHistoryToConversationFormat(
    entries: ProactiveReplyInjectContext['historyEntries'],
  ): Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> {
    const list = entries ?? [];
    return list.map((entry) => ({
      role: entry.isBotReply ? ('assistant' as const) : ('user' as const),
      content: entry.content,
      timestamp: entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt),
    }));
  }
}
