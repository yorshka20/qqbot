// Provider selection stage — routing, vision/tool capability detection, tool definition assembly.

import type { PermissionChecker } from '@/command/CommandManager';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { AIProvider } from '../../base/AIProvider';
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
    private permissionChecker: PermissionChecker,
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
    let usedExplicitProvider: boolean;

    if (resolvedPrefix) {
      providerName = resolvedPrefix.providerName;
      userMessage = resolvedPrefix.strippedMessage;
      reason = resolvedPrefix.providerName ? 'explicit_prefix' : 'nickname_default';
      confidence = 'high';
      usedExplicitProvider = resolvedPrefix.providerName != null;
    } else {
      // Routes on what the user typed, never on quoted text: a provider prefix is
      // leading, so a quote pasted in front of it would hide it, and a nickname
      // trigger would fire on words the quoted author wrote.
      const result = this.providerRouter.routeReplyInput(hookContext.message.message ?? '');
      providerName = result.providerName;
      userMessage = result.userMessage;
      reason = result.reason;
      confidence = result.confidence;
      usedExplicitProvider = result.usedExplicitProvider;
    }

    ctx.providerName = providerName;
    ctx.userMessage = userMessage;
    ctx.usedExplicitProvider = usedExplicitProvider;

    // When images are present, prefer a vision-capable provider; otherwise use the routed provider.
    const hasImages = ctx.messageImages.length > 0;
    if (hasImages) {
      const visionProvider = await this.visionService.getAvailableProviderName(providerName, sessionId);
      ctx.selectedProviderName = visionProvider ?? providerName;
      ctx.providerHasVision = !!visionProvider;
    } else {
      ctx.selectedProviderName = providerName;
      ctx.providerHasVision = false;
    }

    // Capabilities: check if the effective provider supports tool use
    const effectiveProvider = ctx.selectedProviderName ?? 'default';
    const providerCanUseTools = await this.checkProviderToolUseSupport(effectiveProvider, sessionId);

    // Detect native function-calling + native web search support for toolList suppression
    const resolvedProvider = await this.llmService.getAvailableProvider(
      effectiveProvider === 'default' ? undefined : effectiveProvider,
      sessionId,
    );
    const providerCapabilities = resolvedProvider ? (resolvedProvider as unknown as AIProvider).getCapabilities() : [];
    ctx.providerHasFunctionCalling = providerCapabilities.includes('function_calling');
    ctx.effectiveNativeSearchEnabled = providerCapabilities.includes('native_web_search');

    // Store resolved provider name and model in metadata so prompt producers can inject
    // them into the system prompt for LLM self-identification.
    const resolvedProviderInstance = resolvedProvider as unknown as AIProvider | null;
    const resolvedProviderName = resolvedProviderInstance?.name ?? effectiveProvider;
    const resolvedModel = resolvedProviderInstance?.getDefaultModel?.();
    ctx.hookContext.metadata.set('promptProviderName', resolvedProviderName);
    if (resolvedModel) ctx.hookContext.metadata.set('promptModelName', resolvedModel);

    // Resolve source and admin status for tool catalog filtering
    const source = hookContext.source;
    const userId = hookContext.message.userId;
    const messageType = hookContext.message.messageType ?? 'private';
    const protocol = hookContext.message.protocol as string | undefined;
    const senderRole = hookContext.metadata.get('senderRole') as string | undefined;
    const isAdmin = this.permissionChecker.checkPermission(userId, messageType, ['admin'], senderRole, protocol);

    // Tools: only inject when the provider actually supports tool use
    ctx.toolDefinitions = !providerCanUseTools
      ? []
      : getReplySkillDefinitions(this.toolManager, source, isAdmin, {
          nativeWebSearchEnabled: ctx.effectiveNativeSearchEnabled,
        });

    // Tool usage instructions
    ctx.toolUsageInstructions = buildSkillUsageInstructions(
      ctx.toolDefinitions,
      { nativeWebSearchEnabled: ctx.effectiveNativeSearchEnabled },
      this.promptManager,
      ctx.providerHasFunctionCalling,
    );
    // Mirror into hookContext.metadata so ToolInstructProducer can read it
    // without depending on ReplyPipelineContext directly.
    ctx.hookContext.metadata.set('toolUsageInstructions', ctx.toolUsageInstructions);

    logger.debug(
      `[ProviderSelectionStage] reply tool catalog | source=${source} | isAdmin=${isAdmin} | toolCount=${ctx.toolDefinitions.length}`,
    );

    // Log
    logger.info(
      `[ProviderSelectionStage] Provider routing | reason=${reason} | confidence=${confidence} | explicitProvider=${usedExplicitProvider} | provider=${providerName ?? 'default'}`,
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
