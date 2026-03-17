// WeChat Ingest Plugin — thin wrapper that wires up the WeChat service layer
// All core logic lives in src/services/wechat/

import type { InternalEventBus } from '@/agenda/InternalEventBus';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import type { RetrievalService } from '@/services/retrieval';
import type { WeChatIngestConfig, WeChatRealtimeRule } from '@/services/wechat';
import {
  resolveConfig,
  WeChatDatabase,
  WeChatIngestService,
  WeChatPadProClient,
  WechatDITokens,
  WechatEventBridge,
} from '@/services/wechat';
import { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { WechatReportService } from '@/services/wechat/WechatReportService';
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
  private eventBridge: WechatEventBridge | null = null;
  private digestService: WechatDigestService | null = null;
  private reportService: WechatReportService | null = null;
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

    // Init PadPro client if configured
    const padpro = raw?.padpro;
    let padProClient: WeChatPadProClient | null = null;
    if (padpro?.apiBase && padpro?.authKey) {
      padProClient = new WeChatPadProClient({
        apiBase: padpro.apiBase,
        authKey: padpro.authKey,
      });
    }

    // Group name resolver: DB first, lazy-fetch from PadPro on cache miss
    const db = this.db;
    const padproClient = padProClient;
    const resolveGroupName = async (convId: string): Promise<string | null> => {
      // 1. Try DB cache
      const cached = db.getGroupName(convId);
      if (cached) return cached;

      // 2. No PadPro client — nothing we can do
      if (!padproClient) return null;

      // 3. Fetch from PadPro API and persist to DB
      const chatroomId = convId.endsWith('@chatroom') ? convId : `${convId}@chatroom`;
      try {
        const infos = await padproClient.getChatRoomInfo([chatroomId]);
        const info = infos[0];
        if (info?.NickName) {
          const now = new Date().toISOString();
          db.upsertGroup({
            chatroomId,
            conversationId: convId,
            nickName: info.NickName,
            memberCount: info.MemberCount ?? 0,
            owner: info.Owner ?? '',
            updatedAt: now,
          });
          // Cache group members as contacts
          if (info.MemberList?.length) {
            const contacts: Array<{ wxid: string; nickName: string; remark: string; updatedAt: string }> = [];
            for (const m of info.MemberList) {
              if (m.UserName && m.NickName) {
                contacts.push({ wxid: m.UserName, nickName: m.NickName, remark: '', updatedAt: now });
              }
            }
            if (contacts.length > 0) {
              db.upsertContacts(contacts);
              logger.debug(`[WeChatIngestPlugin] Cached ${contacts.length} contacts from group ${convId}`);
            }
          }
          logger.info(`[WeChatIngestPlugin] Lazy-fetched group info: ${convId} → "${info.NickName}"`);
          return info.NickName;
        }
        logger.warn(`[WeChatIngestPlugin] getChatRoomInfo returned no NickName for ${chatroomId}`);
      } catch (err) {
        logger.warn(`[WeChatIngestPlugin] Failed to fetch group info for ${chatroomId}:`, err);
      }
      return null;
    };

    // CDN image downloader via PadPro API
    const client = padProClient;
    const downloadCdnImage = client
      ? async (aeskey: string, cdnUrl: string): Promise<Buffer | null> => {
          return client.downloadCdnImage(aeskey, cdnUrl);
        }
      : undefined;

    // Create event bridge for publishing WeChat events to InternalEventBus
    // This allows Agenda onEvent rules to subscribe to WeChat messages
    let internalEventBus: InternalEventBus | null = null;
    try {
      internalEventBus = container.resolve<InternalEventBus>(DITokens.INTERNAL_EVENT_BUS);
      this.eventBridge = new WechatEventBridge(internalEventBus);
      container.registerInstance(WechatDITokens.EVENT_BRIDGE, this.eventBridge);
      logger.info('[WeChatIngestPlugin] WechatEventBridge registered');
    } catch (err) {
      logger.warn('[WeChatIngestPlugin] InternalEventBus not available — event bridge disabled');
    }

    // Create digest service for daily summaries
    this.digestService = new WechatDigestService(this.db);
    container.registerInstance(WechatDITokens.DIGEST_SERVICE, this.digestService);
    logger.info('[WeChatIngestPlugin] WechatDigestService registered');

    // Create report service for generating and saving reports
    this.reportService = new WechatReportService(this.digestService);
    container.registerInstance(WechatDITokens.REPORT_SERVICE, this.reportService);
    logger.info('[WeChatIngestPlugin] WechatReportService registered');

    this.ingestService = new WeChatIngestService({
      config: resolved,
      retrieval: this.retrieval,
      db: this.db,
      notify: resolved.realtime.enabled ? this.sendRealtimeNotification.bind(this) : undefined,
      resolveGroupName,
      downloadCdnImage,
      eventBridge: this.eventBridge ?? undefined,
    });

    // Register /wechat command if padpro config is available
    if (padProClient) {
      const cmdHandler = new WechatCommandHandler(padProClient, this.db);
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
