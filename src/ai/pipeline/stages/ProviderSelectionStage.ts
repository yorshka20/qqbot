// Provider selection stage — routing, vision/tool capability detection, tool definition assembly.

import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../../prompt/PromptManager';
import type { ProviderRouter } from '../../routing/ProviderRouter';
import type { LLMService } from '../../services/LLMService';
import type { VisionService } from '../../services/VisionService';
import { buildSkillUsageInstructions, getReplySkillDefinitions } from '../../tools/replyTools';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 5: provider selection and tool assembly.
 * Provider prefix routing is primarily done in MessageTriggerPlugin (PREPROCESS)
 * and passed via resolvedProviderPrefix metadata. ProviderRouter is kept as a
 * fallback for messages that reach the pipeline without going through the plugin.
 * This stage resolves vision-capable provider when images are present, checks
 * tool-use support, and assembles OpenAI-compatible tool definitions.
 */
export class ProviderSelectionStage implements ReplyStage {
  readonly name = 'provider-selection';

  constructor(
    private providerRouter: ProviderRouter,
    private visionService: VisionService,
    private llmService: LLMService,
    private toolManager: ToolManager,
    private promptManager: PromptManager,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext } = ctx;
    const sessionId = hookContext.metadata.get('sessionId');

    // Routing: prefer pre-resolved prefix from MessageTriggerPlugin, fallback to ProviderRouter
    const resolvedPrefix = hookContext.metadata.get('resolvedProviderPrefix');
    let providerName: string | undefined;
    let userMessage: string;
    let reason: string;
    let confidence: string;
    let usedExplicitPrefix: boolean;

    if (resolvedPrefix) {
      providerName = resolvedPrefix.providerName;
      userMessage = resolvedPrefix.strippedMessage;
      reason = 'explicit_prefix';
      confidence = 'high';
      usedExplicitPrefix = true;
    } else {
      const rawInput = ctx.userMessageOverride ?? hookContext.message.message ?? '';
      const result = this.providerRouter.routeReplyInput(rawInput);
      providerName = result.providerName;
      userMessage = result.userMessage;
      reason = result.reason;
      confidence = result.confidence;
      usedExplicitPrefix = result.usedExplicitPrefix;
    }

    ctx.providerName = providerName;
    ctx.userMessage = userMessage;

    // Vision and provider
    ctx.useVisionProvider = ctx.messageImages.length > 0;
    ctx.resolvedVisionProviderName = ctx.useVisionProvider
      ? await this.visionService.getAvailableProviderName(providerName, sessionId)
      : null;
    ctx.selectedProviderName = ctx.useVisionProvider ? (ctx.resolvedVisionProviderName ?? providerName) : providerName;

    // Capabilities: check if the effective provider supports tool use
    const effectiveProvider = ctx.selectedProviderName ?? 'default';
    const providerCanUseTools = await this.checkProviderToolUseSupport(effectiveProvider, sessionId);
    ctx.canUseVisionToolUse = ctx.useVisionProvider
      ? Boolean(ctx.resolvedVisionProviderName && providerCanUseTools)
      : false;
    ctx.effectiveNativeSearchEnabled = false;

    // Tools: only inject when the provider actually supports tool use
    ctx.toolDefinitions =
      !providerCanUseTools || (ctx.useVisionProvider && !ctx.canUseVisionToolUse)
        ? []
        : getReplySkillDefinitions(this.toolManager, { nativeWebSearchEnabled: ctx.effectiveNativeSearchEnabled });

    // Tool usage instructions
    ctx.toolUsageInstructions = buildSkillUsageInstructions(
      this.toolManager,
      ctx.toolDefinitions,
      { nativeWebSearchEnabled: ctx.effectiveNativeSearchEnabled },
      this.promptManager,
    );

    // Log
    logger.info(
      `[ProviderSelectionStage] Provider routing | reason=${reason} | confidence=${confidence} | explicitPrefix=${usedExplicitPrefix} | provider=${providerName ?? 'default'}`,
    );
  }

  private async checkProviderToolUseSupport(providerNameOrDefault: string, sessionId?: string): Promise<boolean> {
    const provider = await this.llmService.getAvailableProvider(
      providerNameOrDefault === 'default' ? undefined : providerNameOrDefault,
      sessionId,
    );
    if (!provider) return false;
    const resolvedName = 'name' in provider ? (provider as { name: string }).name : providerNameOrDefault;
    return this.llmService.providerSupportsToolUse(resolvedName);
  }
}
