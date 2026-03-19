// Zhihu Feed Plugin — wires up the Zhihu service layer for feed polling + digest
// All core logic lives in src/services/zhihu/

import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
import type { LLMService } from '@/ai/services/LLMService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ZhihuDITokens } from '@/services/zhihu/tokens';
import type { ZhihuConfig } from '@/services/zhihu/types';
import { DEFAULT_ZHIHU_CONFIG } from '@/services/zhihu/types';
import { ZhihuClient } from '@/services/zhihu/ZhihuClient';
import { ZhihuContentParser } from '@/services/zhihu/ZhihuContentParser';
import { ZhihuDatabase } from '@/services/zhihu/ZhihuDatabase';
import { ZhihuDigestService } from '@/services/zhihu/ZhihuDigestService';
import { ZhihuFeedService } from '@/services/zhihu/ZhihuFeedService';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { ZhihuCommandHandler } from './ZhihuCommandHandler';

@RegisterPlugin({
  name: 'zhihuFeed',
  version: '2.0.0',
  description: 'Polls Zhihu feed (关注动态), stores to SQLite with full content, and pushes digests to QQ groups',
})
export class ZhihuFeedPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private db: ZhihuDatabase | null = null;
  private feedService: ZhihuFeedService | null = null;
  private digestService: ZhihuDigestService | null = null;
  private pollTask: ScheduledTask | null = null;
  private digestTask: ScheduledTask | null = null;
  /** Timestamp of last owner notification (to avoid spam). */
  private lastOwnerNotifyTime = 0;
  private static readonly NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
  private resolvedConfig = {
    cookie: '',
    pollIntervalCron: DEFAULT_ZHIHU_CONFIG.pollIntervalCron as string,
    digestCron: DEFAULT_ZHIHU_CONFIG.digestCron as string,
    digestGroupIds: [...DEFAULT_ZHIHU_CONFIG.digestGroupIds] as string[],
    requestIntervalMs: DEFAULT_ZHIHU_CONFIG.requestIntervalMs as number,
    maxPagesPerPoll: DEFAULT_ZHIHU_CONFIG.maxPagesPerPoll as number,
    digestHoursBack: DEFAULT_ZHIHU_CONFIG.digestHoursBack as number,
    digestProvider: DEFAULT_ZHIHU_CONFIG.digestProvider as string,
    verbFilter: [...DEFAULT_ZHIHU_CONFIG.verbFilter] as string[],
  };

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);

    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);

    const raw = config.getPluginConfig('zhihuFeed') as ZhihuConfig | undefined;
    if (!raw?.cookie) {
      logger.warn('[ZhihuFeedPlugin] No cookie configured, plugin will not function');
    }

    this.resolvedConfig = {
      cookie: raw?.cookie ?? '',
      pollIntervalCron: raw?.pollIntervalCron ?? DEFAULT_ZHIHU_CONFIG.pollIntervalCron,
      digestCron: raw?.digestCron ?? DEFAULT_ZHIHU_CONFIG.digestCron,
      digestGroupIds: raw?.digestGroupIds ?? [...DEFAULT_ZHIHU_CONFIG.digestGroupIds],
      requestIntervalMs: raw?.requestIntervalMs ?? DEFAULT_ZHIHU_CONFIG.requestIntervalMs,
      maxPagesPerPoll: raw?.maxPagesPerPoll ?? DEFAULT_ZHIHU_CONFIG.maxPagesPerPoll,
      digestHoursBack: raw?.digestHoursBack ?? DEFAULT_ZHIHU_CONFIG.digestHoursBack,
      digestProvider: raw?.digestProvider ?? DEFAULT_ZHIHU_CONFIG.digestProvider,
      verbFilter: raw?.verbFilter ?? [...DEFAULT_ZHIHU_CONFIG.verbFilter],
    };

    // Init database
    this.db = new ZhihuDatabase();
    await this.db.init();
    container.registerInstance(ZhihuDITokens.ZHIHU_DB, this.db);

    // Init client
    const client = new ZhihuClient({
      cookie: this.resolvedConfig.cookie,
      requestIntervalMs: this.resolvedConfig.requestIntervalMs,
    });
    container.registerInstance(ZhihuDITokens.ZHIHU_CLIENT, client);

    // Init parser
    const parser = new ZhihuContentParser({
      verbFilter: this.resolvedConfig.verbFilter ? [...this.resolvedConfig.verbFilter] : undefined,
    });

    // Init feed service — notify owner when all content strategies fail
    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    const preferredProtocol = config.getEnabledProtocols()[0]?.name ?? 'milky';
    const ownerId = Number(config.getConfig().bot.owner);

    this.feedService = new ZhihuFeedService(client, parser, this.db, {
      maxPagesPerPoll: this.resolvedConfig.maxPagesPerPoll,
      onContentFetchFailed: (_item, reason) => {
        if (!ownerId) return;
        const now = Date.now();
        if (now - this.lastOwnerNotifyTime < ZhihuFeedPlugin.NOTIFY_COOLDOWN_MS) return;
        this.lastOwnerNotifyTime = now;

        logger.warn(`[ZhihuFeedPlugin] Content fetch failed, notifying owner: ${reason}`);
        messageAPI
          .sendPrivateMessage(
            ownerId,
            `[知乎插件] 内容获取全部失败，可能需要更新 Cookie 或解除验证码。\n原因: ${reason}`,
            preferredProtocol,
          )
          .catch((err) => logger.error('[ZhihuFeedPlugin] Failed to notify owner:', err));
      },
    });
    container.registerInstance(ZhihuDITokens.ZHIHU_FEED_SERVICE, this.feedService);

    // Init digest service
    const llmService = container.resolve<LLMService>(DITokens.LLM_SERVICE);

    this.digestService = new ZhihuDigestService(this.feedService, llmService, messageAPI, {
      digestProvider: this.resolvedConfig.digestProvider,
      digestHoursBack: this.resolvedConfig.digestHoursBack,
      preferredProtocol,
    });
    container.registerInstance(ZhihuDITokens.ZHIHU_DIGEST_SERVICE, this.digestService);

    // Register /zhihu command
    const cmdHandler = new ZhihuCommandHandler(this.feedService, this.db);
    this.commandManager.register(cmdHandler, this.name);
    logger.info('[ZhihuFeedPlugin] Registered /zhihu command');

    logger.info('[ZhihuFeedPlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    this.enabled = true;

    // Schedule feed polling
    if (this.feedService && this.resolvedConfig.cookie) {
      this.pollTask = schedule(this.resolvedConfig.pollIntervalCron, async () => {
        try {
          const result = await this.feedService?.pollFeed();
          if (!result) return;
          if (result.newCount > 0 || result.contentCount > 0) {
            logger.info(`[ZhihuFeedPlugin] Poll: ${result.newCount} new items, ${result.contentCount} content fetched`);
          }
        } catch (err) {
          logger.error('[ZhihuFeedPlugin] Poll cron error:', err);
        }
      });
      logger.info(`[ZhihuFeedPlugin] Feed poll scheduled: ${this.resolvedConfig.pollIntervalCron}`);

      // Run initial poll
      this.feedService.pollFeed().catch((err) => {
        logger.error('[ZhihuFeedPlugin] Initial poll error:', err);
      });
    }

    // Schedule digest push
    const digestGroupIds = this.resolvedConfig.digestGroupIds;
    if (this.digestService && digestGroupIds && digestGroupIds.length > 0) {
      this.digestTask = schedule(this.resolvedConfig.digestCron, async () => {
        for (const groupId of digestGroupIds) {
          try {
            await this.digestService?.generateAndPushDigest(groupId);
          } catch (err) {
            logger.error(`[ZhihuFeedPlugin] Digest cron error for group ${groupId}:`, err);
          }
        }
      });
      logger.info(
        `[ZhihuFeedPlugin] Digest scheduled: ${this.resolvedConfig.digestCron} → groups ${digestGroupIds.join(', ')}`,
      );
    }

    logger.info('[ZhihuFeedPlugin] Enabled');
  }

  async onDisable(): Promise<void> {
    this.enabled = false;
    this.pollTask?.stop();
    this.pollTask = null;
    this.digestTask?.stop();
    this.digestTask = null;
    this.db?.close();
    this.db = null;
    logger.info('[ZhihuFeedPlugin] Disabled');
  }
}
