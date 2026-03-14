// WeChat Ingest Plugin — receives webhook from WeChatPadPro and stores messages into RAG

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import type { WeChatIngestConfig, WeChatRealtimeRule } from './types';
import { resolveConfig } from './types';
import { WeChatIngestService } from './WeChatIngestService';

@RegisterPlugin({
  name: 'wechatIngest',
  version: '1.0.0',
  description: 'Receives WeChat messages via webhook and ingests them into the RAG knowledge base',
})
export class WeChatIngestPlugin extends PluginBase {
  private ingestService: WeChatIngestService | null = null;
  private retrieval!: RetrievalService;
  private messageAPI!: MessageAPI;
  private preferredProtocol: string = 'milky';

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);

    this.retrieval = container.resolve<RetrievalService>(DITokens.RETRIEVAL_SERVICE);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    const raw = config.getPluginConfig('wechatIngest') as WeChatIngestConfig | undefined;
    const resolved = resolveConfig(raw);

    if (!this.retrieval.isRAGEnabled()) {
      logger.warn('[WeChatIngestPlugin] RAG is not enabled — messages will be received but NOT stored to RAG');
    }

    this.ingestService = new WeChatIngestService({
      config: resolved,
      retrieval: this.retrieval,
      notify: resolved.realtime.enabled ? this.sendRealtimeNotification.bind(this) : undefined,
    });

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
