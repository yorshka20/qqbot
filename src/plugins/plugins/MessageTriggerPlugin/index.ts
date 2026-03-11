// MessageTriggerPlugin - unified message trigger entry point
// Decides whether to run the reply pipeline AND optionally spawns background subagents.

import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { parseLlmTrueFalse } from '@/ai/utils/llmJsonExtract';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationConfigService } from '@/conversation/ConversationConfigService';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { ProviderNameMatcher } from './ProviderNameMatcher';
import { SubAgentTriggerHandler } from './SubAgentTriggerHandler';
import type { MessageTriggerPluginConfig, SubAgentTriggerRule } from './types';
import { WakeWordMatcher } from './WakeWordMatcher';

export type { MessageTriggerPluginConfig, SubAgentTriggerRule } from './types';

@RegisterPlugin({
  name: 'messageTrigger',
  version: '1.0.0',
  description:
    'Unified message trigger: decides if message should activate reply pipeline (@bot, reaction, wake words, provider-name prefix). Optionally spawns background subagents for keyword-matched tasks. Trigger only; downstream modules handle behavior.',
})
export class MessageTriggerPlugin extends PluginBase {
  private wakeWordMatcher!: WakeWordMatcher;
  private providerNameMatcher!: ProviderNameMatcher;
  private subAgentTriggerHandler: SubAgentTriggerHandler | null = null;

  private llmService!: LLMService;
  private promptManager!: PromptManager;
  private threadService!: ThreadService;
  private config!: Config;

  /**
   * The faceId (reaction type) configured as "recall" in the messageOperation plugin.
   * When a user reacts to a subagent notification with this reaction, the subagent is cancelled.
   * null = not configured (cancellation via reaction is disabled).
   */
  private cancelReactionId: number | null = null;

  async onInit(): Promise<void> {
    this.enabled = true;
    const container = getContainer();
    this.llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
    this.config = container.resolve<Config>(DITokens.CONFIG);
    const proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );

    const pluginConfig = this.pluginConfig?.config as MessageTriggerPluginConfig | undefined;

    // Wake words
    const globalWakeWords = (pluginConfig?.wakeWords ?? [])
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);

    this.wakeWordMatcher = new WakeWordMatcher(globalWakeWords, this.promptManager, proactiveConversationService);
    this.providerNameMatcher = new ProviderNameMatcher();

    // SubAgent triggers (optional — only instantiated when rules are configured)
    const subAgentRules: SubAgentTriggerRule[] = pluginConfig?.subAgentTriggers ?? [];
    if (subAgentRules.length > 0) {
      const aiService = container.resolve<AIService>(DITokens.AI_SERVICE);
      const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
      const conversationConfigService = container.resolve<ConversationConfigService>(DITokens.CONVERSATION_CONFIG_SERVICE);
      const protocol = this.config.getEnabledProtocols()[0]?.name ?? 'milky';
      const botSelfId = this.config.getBotUserId();
      this.subAgentTriggerHandler = new SubAgentTriggerHandler(
        subAgentRules,
        this.promptManager,
        aiService,
        messageAPI,
        conversationConfigService,
        protocol,
        botSelfId,
      );
      logger.info(`[MessageTriggerPlugin] SubAgent triggers enabled | rules=${subAgentRules.length}`);

      // Discover the recall reaction ID from messageOperation config so we can cancel
      // subagents when the user reacts to the notification message with the same reaction.
      const msgOpConfig = this.config.getPluginConfig('messageOperation') as
        | { reactionOperations?: Record<string, string> }
        | undefined;
      const recallEntry = Object.entries(msgOpConfig?.reactionOperations ?? {}).find(
        ([, op]) => op === 'recall',
      );
      if (recallEntry) {
        this.cancelReactionId = Number(recallEntry[0]);
        logger.info(
          `[MessageTriggerPlugin] Subagent cancellation enabled via reaction faceId=${this.cancelReactionId}`,
        );
      } else {
        logger.debug('[MessageTriggerPlugin] No recall reaction configured; subagent cancellation via reaction disabled');
      }
    }

    logger.info(
      `[MessageTriggerPlugin] Enabled | wakeWords=${globalWakeWords.length} subAgentRules=${subAgentRules.length}`,
    );
  }

  /**
   * One-shot LLM check: whether the user message (which started with a provider prefix) clearly invites a reply.
   * Uses generateLite with config ai.liteLlm when set.
   * @returns true to allow reply, false to skip (fail closed on error or unrecognized response).
   */
  private async checkPrefixInvitation(messageText: string): Promise<boolean> {
    const aiConfig = this.config.getAIConfig();
    const liteProvider = aiConfig?.liteLlm?.provider ?? 'deepseek';
    const liteModel = aiConfig?.liteLlm?.model ?? '';

    try {
      const prompt = this.promptManager.render('analysis.prefix_invitation', { messageText });
      const response = await this.llmService.generateLite(prompt, { maxTokens: 100, model: liteModel }, liteProvider);
      const raw = parseLlmTrueFalse(response.text);
      if (raw === null) {
        logger.warn('[MessageTriggerPlugin] Prefix-invitation LLM response not true/false; treating as no reply');
        return false;
      }
      return raw;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(
        `[MessageTriggerPlugin] Prefix-invitation LLM call failed (provider=${liteProvider}, model=${liteModel}):`,
        err,
      );
      return false;
    }
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGHEST',
    order: -1,
  })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    // Commands are handled by CommandSystem in PROCESS; this plugin only decides reply-pipeline trigger.
    if (context.command) {
      return true;
    }

    const message = context.message;
    const messageType = message.messageType;
    const userId = message.userId.toString();
    const groupId = message.groupId?.toString();
    const botSelfId = context.metadata.get('botSelfId');
    const messageText = message.message;

    // Whitelist is highest constraint: if already set, do not change it
    if (context.metadata.get('postProcessOnly')) {
      return true;
    }

    // Bot self: skip reply pipeline
    if (botSelfId && userId === botSelfId) {
      context.metadata.set('postProcessOnly', true);
      return true;
    }

    // Private: do not set postProcessOnly here; WhitelistPlugin will filter by user whitelist
    if (messageType === 'private') {
      return true;
    }

    // --- Reply pipeline gate ---
    const replyTrigger = context.metadata.get('replyTrigger');
    const isAtBot = MessageUtils.isAtBot(message, botSelfId);
    const strippedText = this.wakeWordMatcher.getTextForMatch(messageText);
    const wakeWordSource = this.wakeWordMatcher.match(groupId, messageText);
    const isWakeWord = wakeWordSource !== null;
    const isProviderNameTrigger = this.providerNameMatcher.matches(strippedText);

    const allowed = replyTrigger === 'reaction' || isAtBot || isWakeWord || isProviderNameTrigger;

    // --- SubAgent triggers ---
    // Runs AFTER the reply gate decision so we know whether the bot will reply (botWillReply = allowed).
    //
    // Whitelist guard: whitelistDenied means this group is not bot-enabled.
    //   Never spawn subagents in non-whitelisted groups to prevent unexpected activity.
    //   WhitelistPlugin sets this flag at onMessageReceived (before onMessagePreprocess), so it is
    //   already available here.
    //
    // Mutual exclusion: when botWillReply=true, same-group rules are skipped inside the handler.
    //   Cross-group rules (rule.targetGroupId → a different group) always fire regardless.
    const isWhitelistDenied = !!context.metadata.get('whitelistDenied');
    if (this.subAgentTriggerHandler && groupId && !isWhitelistDenied) {
      const spawned = this.subAgentTriggerHandler.handleMessage(message, allowed);
      if (spawned > 0) {
        logger.debug(`[MessageTriggerPlugin] Spawned ${spawned} background subagent(s) for group=${groupId}`);
      }
    }

    if (!allowed) {
      context.metadata.set('postProcessOnly', true);
      return true;
    }

    // Provider-name prefix: one-shot LLM confirmation to avoid wasting tokens
    if (isProviderNameTrigger) {
      const shouldReply = await this.checkPrefixInvitation(strippedText);
      if (!shouldReply) {
        logger.debug('[MessageTriggerPlugin] Prefix-invitation check said no reply');
        context.metadata.set('postProcessOnly', true);
        return true;
      }
    }

    // Determine and record trigger type for downstream modules
    let replyTriggerType: 'at' | 'reaction' | 'wakeWordConfig' | 'wakeWordPreference' | 'providerName';
    if (replyTrigger === 'reaction') {
      replyTriggerType = 'reaction';
    } else if (isAtBot) {
      replyTriggerType = 'at';
    } else if (isWakeWord && wakeWordSource) {
      replyTriggerType = wakeWordSource;
    } else if (isProviderNameTrigger) {
      replyTriggerType = 'providerName';
    } else {
      replyTriggerType = 'reaction';
    }

    context.metadata.set('replyTriggerType', replyTriggerType);
    context.metadata.set('contextMode', 'normal');
    if (groupId && this.threadService.hasActiveThread(groupId)) {
      context.metadata.set('inProactiveThread', true);
    }

    return true;
  }

  /**
   * Intercept group_message_reaction notices to cancel in-flight subagents.
   * Runs just before MessageOperationPlugin (NORMAL, order 0) so cancellation is registered
   * before MessageOperation proceeds to recall the notification message.
   */
  @Hook({
    stage: 'onNoticeReceived',
    priority: 'NORMAL',
    order: -1,
  })
  onNoticeReceived(context: HookContext): boolean {
    if (!this.subAgentTriggerHandler || this.cancelReactionId === null) return true;
    if (!context.notice) return true;

    const notice = context.notice;
    if (notice.noticeType !== 'group_message_reaction') return true;
    if (!notice.isAdd) return true;
    if (notice.faceId !== this.cancelReactionId) return true;
    if (notice.messageSeq == null) return true;

    const cancelled = this.subAgentTriggerHandler.handleCancelReaction(notice.messageSeq);
    if (cancelled) {
      logger.info(
        `[MessageTriggerPlugin] Subagent cancelled (notificationSeq=${notice.messageSeq}, faceId=${notice.faceId})`,
      );
    }

    // Always continue — MessageOperationPlugin handles the recall of the notification message
    return true;
  }
}
