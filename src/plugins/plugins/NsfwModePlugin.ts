// NSFW Mode Plugin - toggle NSFW mode per session; when on, uses fixed reply flow with llm.nsfw_reply template

import type { AIService } from '@/ai/AIService';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { ConversationConfigService } from '@/config/ConversationConfigService';
import { getSessionId, getSessionType } from '@/config/SessionUtils';
import type { ProcessStageInterceptor, ProcessStageInterceptorRegistry } from '@/conversation/ProcessStageInterceptor';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { Plugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import { logger } from '@/utils/logger';

/**
 * NSFW Mode Plugin
 * /nsfw command toggles NSFW mode for the current session.
 * When on, all non-command messages use a fixed reply flow (llm.nsfw_reply template) instead of the normal pipeline.
 */
@Plugin({
  name: 'nsfw',
  version: '1.0.0',
  description: 'Toggle NSFW mode per session; when on, uses fixed reply flow with dedicated prompt',
})
export class NsfwModePlugin extends PluginBase {
  private commandManager!: CommandManager;
  private conversationConfigService!: ConversationConfigService;
  private processStageInterceptorRegistry!: ProcessStageInterceptorRegistry;
  private aiService!: AIService;
  private nsfwInterceptor: ProcessStageInterceptor | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.conversationConfigService = container.resolve<ConversationConfigService>(DITokens.CONVERSATION_CONFIG_SERVICE);
    this.processStageInterceptorRegistry = container.resolve<ProcessStageInterceptorRegistry>(
      DITokens.PROCESS_STAGE_INTERCEPTOR_REGISTRY,
    );
    this.aiService = container.resolve<AIService>(DITokens.AI_SERVICE);

    if (
      !this.commandManager ||
      !this.conversationConfigService ||
      !this.processStageInterceptorRegistry ||
      !this.aiService
    ) {
      throw new Error('[NsfwModePlugin] Required dependencies not found');
    }

    logger.info('[NsfwModePlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    logger.info('[NsfwModePlugin] Enabling NSFW mode plugin');

    const nsfwCommandHandler = new PluginCommandHandler(
      'nsfw',
      'Toggle NSFW mode for this session (on/off). When on, replies use fixed NSFW prompt.',
      '/nsfw [on|off]',
      async (args: string[], context: CommandContext) => {
        return await this.executeNsfwCommand(args, context);
      },
      this.context,
      ['admin'],
    );

    this.commandManager.register(nsfwCommandHandler, this.name);

    this.nsfwInterceptor = {
      shouldIntercept: async (ctx: HookContext): Promise<boolean> => {
        const rawSessionId = ctx.metadata.get('sessionId') as string | undefined;
        const sessionType = ctx.metadata.get('sessionType') as 'user' | 'group' | undefined;
        if (!rawSessionId || !sessionType) {
          return false;
        }
        if (ctx.command) {
          return false;
        }
        // Do not intercept bot's own messages (e.g. echo of "已开启 NSFW 模式")
        const botSelfId = ctx.metadata.get('botSelfId') as string | undefined;
        const messageUserId = ctx.message?.userId?.toString();
        if (botSelfId && messageUserId === botSelfId) {
          logger.debug("[NsfwModePlugin] Bot's own message, skip intercept");
          return false;
        }
        // Pipeline metadata uses prefixed sessionId (e.g. "group:758290153"); ConversationConfigService
        // and /nsfw command use raw id + sessionType (e.g. "758290153", "group"). Normalize so we read
        // the same config that was written by executeNsfwCommand.
        const { sessionId, sessionType: resolvedType } = this.normalizeSessionForConfig(rawSessionId, sessionType);
        const config = await this.conversationConfigService.getConfig(sessionId, resolvedType);
        const intercept = config.nsfwMode === true;
        logger.debug(
          `[NsfwModePlugin] shouldIntercept | rawSessionId=${rawSessionId} | normalized=${sessionId}|${resolvedType} | nsfwMode=${config.nsfwMode} => ${intercept}`,
        );
        if (intercept) {
          logger.info(
            `[NsfwModePlugin] NSFW intercept mode ON | sessionId=${sessionId} | sessionType=${resolvedType} | reply will use Ollama`,
          );
        }
        return intercept;
      },
      handle: async (ctx: HookContext): Promise<void> => {
        logger.info(
          '[NsfwModePlugin] Handling message in NSFW intercept mode | generating reply via Ollama (skip command/task)',
        );
        await this.aiService.generateNsfwReply(ctx);
      },
    };

    this.processStageInterceptorRegistry.register(this.nsfwInterceptor);
    logger.info('[NsfwModePlugin] Registered /nsfw command and process-stage interceptor');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    logger.info('[NsfwModePlugin] Disabling NSFW mode plugin');

    this.commandManager.unregister('nsfw', this.name);
    if (this.nsfwInterceptor) {
      this.processStageInterceptorRegistry.unregister(this.nsfwInterceptor);
      this.nsfwInterceptor = null;
    }
    logger.info('[NsfwModePlugin] Unregistered /nsfw command and interceptor');
  }

  /**
   * Normalize pipeline sessionId (e.g. "group:758290153") to the (sessionId, sessionType) pair
   * used by ConversationConfigService and by /nsfw command (SessionUtils), so interceptor and
   * command read/write the same config.
   */
  private normalizeSessionForConfig(
    rawSessionId: string,
    sessionType: 'user' | 'group',
  ): { sessionId: string; sessionType: 'user' | 'group' } {
    if (rawSessionId.startsWith('group:')) {
      return { sessionId: rawSessionId.slice(6), sessionType: 'group' };
    }
    if (rawSessionId.startsWith('user:')) {
      return { sessionId: rawSessionId.slice(5), sessionType: 'user' };
    }
    return { sessionId: rawSessionId, sessionType };
  }

  /**
   * Execute /nsfw command: toggle or set on/off, then reply with confirmation
   */
  private async executeNsfwCommand(args: string[], context: CommandContext): Promise<CommandResult> {
    const sessionId = getSessionId(context);
    const sessionType = getSessionType(context);

    const firstArg = args[0]?.toLowerCase();
    let nsfwMode: boolean;

    if (firstArg === 'on') {
      nsfwMode = true;
    } else if (firstArg === 'off') {
      nsfwMode = false;
    } else {
      // Toggle: read current config and flip
      const config = await this.conversationConfigService.getConfig(sessionId, sessionType);
      nsfwMode = !config.nsfwMode;
    }

    await this.conversationConfigService.updateConfig(sessionId, sessionType, { nsfwMode });

    // Reply makes it clear which mode is now active so user does not confuse toggle result
    const message = nsfwMode ? '已开启 NSFW 模式' : '已关闭 NSFW 模式';
    const segments = new MessageBuilder().text(message).build();

    return {
      success: true,
      segments,
    };
  }
}
