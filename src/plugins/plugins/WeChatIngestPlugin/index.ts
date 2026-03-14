// WeChat Ingest Plugin — thin wrapper that wires up the WeChat service layer
// All core logic lives in src/services/wechat/

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import type { RetrievalService } from '@/services/retrieval';
import type { WeChatIngestConfig, WeChatRealtimeRule } from '@/services/wechat';
import { resolveConfig, WeChatDatabase, WeChatIngestService, WeChatPadProClient } from '@/services/wechat';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { WechatCommandHandler } from './WechatCommandHandler';

@RegisterPlugin({
  name: 'wechatIngest',
  version: '1.0.0',
  description: 'Receives WeChat messages via webhook and ingests them into the RAG knowledge base',
})
export class WeChatIngestPlugin extends PluginBase {
  private ingestService: WeChatIngestService | null = null;
  private db: WeChatDatabase | null = null;
  private retrieval!: RetrievalService;
  private messageAPI!: MessageAPI;
  private commandManager!: CommandManager;
  private preferredProtocol: string = 'milky';

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);

    this.retrieval = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);

    const raw = config.getPluginConfig('wechatIngest') as WeChatIngestConfig | undefined;
    const resolved = resolveConfig(raw);

    if (!this.retrieval.isRAGEnabled()) {
      logger.warn('[WeChatIngestPlugin] RAG is not enabled — messages will be received but NOT stored to RAG');
    }

    // Init SQLite database
    this.db = new WeChatDatabase();
    await this.db.init();

    this.ingestService = new WeChatIngestService({
      config: resolved,
      retrieval: this.retrieval,
      db: this.db,
      notify: resolved.realtime.enabled ? this.sendRealtimeNotification.bind(this) : undefined,
    });

    // Register /wechat command if padpro config is available
    const padpro = raw?.padpro;
    if (padpro?.apiBase && padpro?.authKey) {
      const padProClient = new WeChatPadProClient({
        apiBase: padpro.apiBase,
        authKey: padpro.authKey,
      });
      const cmdHandler = new WechatCommandHandler(padProClient);
      this.commandManager.register(cmdHandler, this.name);
      logger.info('[WeChatIngestPlugin] Registered /wechat command');
    } else {
      logger.warn('[WeChatIngestPlugin] padpro.apiBase/authKey not configured — /wechat command disabled');
    }

    logger.info('[WeChatIngestPlugin] Initialized');
  }

  async onEnable(): Promise<void> {
    this.enabled = true;
    this.ingestService?.start();
    logger.info('[WeChatIngestPlugin] Enabled — webhook server started');
  }

  async onDisable(): Promise<void> {
    this.enabled = false;
    await this.ingestService?.stop();
    this.db?.close();
    this.db = null;
    logger.info('[WeChatIngestPlugin] Disabled — webhook server stopped');
  }

  // ──────────────────────────────────────────────────
  // Real-time QQ notification
  // ──────────────────────────────────────────────────

  private async sendRealtimeNotification(text: string, rules: WeChatRealtimeRule[]): Promise<void> {
    for (const rule of rules) {
      if (!rule.qqGroupId) continue;

      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        logger.warn(`[WeChatIngestPlugin] Invalid realtime rule pattern: ${rule.pattern}`);
        continue;
      }

      if (!re.test(text)) continue;

      const notice = rule.template.replace('{text}', text).replace('{summary}', text);
      const groupId = Number(rule.qqGroupId);
      if (Number.isNaN(groupId)) continue;

      try {
        await this.messageAPI.sendFromContext(notice, this.buildSyntheticContext(groupId), 10_000);
        logger.info(`[WeChatIngestPlugin] Real-time notification sent to QQ group ${rule.qqGroupId}`);
      } catch (err) {
        logger.error(`[WeChatIngestPlugin] Failed to send notification to ${rule.qqGroupId}:`, err);
      }
    }
  }

  private buildSyntheticContext(groupId: number): NormalizedMessageEvent {
    return {
      id: '',
      type: 'message',
      timestamp: Date.now(),
      protocol: this.preferredProtocol as NormalizedMessageEvent['protocol'],
      userId: 0,
      groupId,
      messageType: 'group',
      message: '',
      segments: [],
    };
  }
}
