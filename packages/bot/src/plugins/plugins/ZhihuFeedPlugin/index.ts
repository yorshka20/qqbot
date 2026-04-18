// Zhihu Feed Plugin — wires up the Zhihu service layer for feed polling.
// Digest generation is handled by AgentLoop via schedule.md, not by this plugin.
// All core logic lives in src/services/zhihu/

import type { ScheduledTask } from 'node-cron';
import { schedule } from 'node-cron';
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
import { ZhihuFeedService } from '@/services/zhihu/ZhihuFeedService';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { ZhihuCommandHandler } from './ZhihuCommandHandler';

@RegisterPlugin({
  name: 'zhihuFeed',
  version: '2.0.0',
  description: 'Polls Zhihu feed (关注动态), stores to SQLite with full content. Digest generation via AgentLoop.',
})
export class ZhihuFeedPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private db: ZhihuDatabase | null = null;
  private feedService: ZhihuFeedService | null = null;
  private pollTask: ScheduledTask | null = null;
  private resolvedConfig = {
    ...DEFAULT_ZHIHU_CONFIG,
    cookie: '',
  };

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);

    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);

    const raw = config.getPluginConfig('zhihuFeed') ?? DEFAULT_ZHIHU_CONFIG;
    if (!raw.cookie) {
      logger.warn('[ZhihuFeedPlugin] No config found, plugin will not function');
      return;
    }

    this.resolvedConfig = {
      ...DEFAULT_ZHIHU_CONFIG,
      ...raw,
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

    // Init feed service
    this.feedService = new ZhihuFeedService(client, parser, this.db, {
      maxPagesPerPoll: this.resolvedConfig.maxPagesPerPoll,
    });
    container.registerInstance(ZhihuDITokens.ZHIHU_FEED_SERVICE, this.feedService);

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

    // Digest scheduling is handled by schedule.md → AgentLoop (not this plugin)

    logger.info('[ZhihuFeedPlugin] Enabled');
  }

  async onDisable(): Promise<void> {
    this.enabled = false;
    this.pollTask?.stop();
    this.pollTask = null;
    this.db?.close();
    this.db = null;
    logger.info('[ZhihuFeedPlugin] Disabled');
  }
}
