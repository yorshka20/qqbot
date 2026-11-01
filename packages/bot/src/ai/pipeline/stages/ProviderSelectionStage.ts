// Provider selection stage — routing, vision/tool capability detection, tool definition assembly.

import { inject, singleton } from 'tsyringe';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import { LLMService } from '@/ai/services/LLMService';
import { VisionService } from '@/ai/services/VisionService';
import { DITokens } from '@/core/DITokens';
import type { PermissionChecker } from '@/permission';
import type { ToolManager } from '@/tools/ToolManager';
import { logger } from '@/utils/logger';
import type { AIProvider } from '../../base/AIProvider';
import type { PromptManager } from '../../prompt/PromptManager';
import { buildSkillUsageInstructions, getReplySkillDefinitions } from '../../tools/replyTools';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 5: provider selection and tool assembly.
 * Provider prefix routing is primarily done in MessageTriggerPlugin (PREPROCESS)
 * and passed via resolvedProviderPrefix metadata. ProviderRouter is kept as a
 * fallback for messages that reach the pipeline without going through the plugin.
 * This stage keeps the turn on the routed provider when it can see the message's
 * images and falls back to the configured vision provider when it cannot, checks
 * tool-use support, and assembles OpenAI-compatible tool definitions.
 */
@singleton()
export class ProviderSelectionStage implements ReplyStage {
  readonly name = 'provider-selection';

  constructor(
    @inject(ProviderRouter) private providerRouter: ProviderRouter,
    @inject(VisionService) private visionService: VisionService,
    @inject(LLMService) private llmService: LLMService,
    @inject(DITokens.TOOL_MANAGER) private toolManager: ToolManager,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
    @inject(DITokens.PERMISSION_CHECKER) private permissionChecker: PermissionChecker,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext } = ctx;
    const sessionId = hookContext.metadata.get('sessionId');

    // Routing: prefer pre-resolved prefix from MessageTriggerPlugin, fallback to ProviderRouter
    const resolvedPrefix = hookContext.metadata.get('resolvedProviderPrefix');
    let providerName: string | undefined;
    let reason: string;
    let confidence: string;
    let usedExplicitProvider: boolean;

    if (resolvedPrefix) {
      providerName = resolvedPrefix.providerName;
      reason = resolvedPrefix.providerName ? 'explicit_prefix' : 'nickname_default';
      confidence = 'high';
      usedExplicitProvider = resolvedPrefix.providerName != null;
    } else {
      // Routes on what the user typed, never on quoted text: a provider prefix is
      // leading, so a quote pasted in front of it would hide it, and a nickname
      // trigger would fire on words the quoted author wrote.
      const result = this.providerRouter.route(hookContext.message.message ?? '');
      providerName = result.providerName ?? undefined;
      reason = result.reason;
      confidence = result.confidence;
      usedExplicitProvider = result.hasExplicitProvider;
    }

    // A routed provider answers on its own configured model.
    ctx.routedTarget = providerName ? { provider: providerName } : undefined;
    ctx.usedExplicitProvider = usedExplicitProvider;

    // The LLM that answers this turn: the routed one, else the session/default LLM. It is
    // resolved once here and the prompt, the effort and the generation all use the result.
    const routed = await this.llmService.resolveTarget(ctx.routedTarget, sessionId);

    const hasImages = ctx.messageImages.length > 0;
    const imageRouting = hasImages
      ? await this.visionService.routeImageTurn(routed?.provider ?? null, providerName, sessionId)
      : null;
    ctx.providerHasVision = imageRouting?.canSeeImages ?? false;

    // A text-only provider hands an image turn to a vision provider, which answers on its own model.
    const visionHandoff = imageRouting?.providerName !== providerName ? imageRouting?.providerName : undefined;
    const answering = visionHandoff
      ? await this.llmService.resolveTarget({ provider: visionHandoff }, sessionId)
      : routed;
    ctx.target = answering?.target;

    // Store the answering provider and model in metadata so prompt producers can inject
    // them into the system prompt for LLM self-identification.
    const resolvedProviderInstance = (answering?.provider ?? null) as unknown as AIProvider | null;
    const resolvedProviderName = ctx.target?.provider ?? 'default';
    ctx.hookContext.metadata.set('promptProviderName', resolvedProviderName);
    if (ctx.target?.model) ctx.hookContext.metadata.set('promptModelName', ctx.target.model);

    // Capabilities of the provider that will actually serve the turn
    const providerCanUseTools = resolvedProviderInstance
      ? this.llmService.providerSupportsToolUse(resolvedProviderName)
      : false;
    const providerCapabilities = resolvedProviderInstance ? resolvedProviderInstance.getCapabilities() : [];
    ctx.providerHasFunctionCalling = providerCapabilities.includes('function_calling');
    ctx.effectiveNativeSearchEnabled = providerCapabilities.includes('native_web_search');

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
      `[ProviderSelectionStage] Provider routing | reason=${reason} | confidence=${confidence} | explicitProvider=${usedExplicitProvider} | provider=${providerName ?? 'default'} | resolved=${resolvedProviderName} | model=${ctx.target?.model ?? '-'} | images=${ctx.messageImages.length}`,
    );
  }
}
