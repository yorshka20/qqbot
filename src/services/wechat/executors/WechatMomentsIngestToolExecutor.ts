// WechatMomentsIngestToolExecutor - fetches own WeChat moments and stores in Qdrant
// Designed for schedule (cron every 3 days) and subagent invocation.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { WechatMomentsIngestService } from '@/services/wechat/moments/WechatMomentsIngestService';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WeChatDatabase } from '@/services/wechat/WeChatDatabase';
import type { WeChatPadProClient } from '@/services/wechat/WeChatPadProClient';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

/**
 * WechatMomentsIngestToolExecutor
 *
 * Fetches own moments from PadPro, parses XML content, downloads images,
 * and upserts to the wechat_moments Qdrant collection.
 *
 * Usage in schedule.md:
 *
 *   ## 朋友圈同步
 *   - 触发: cron 0 8 1,4,7,10,13,16,19,22,25,28 * *
 *
 *   同步我的微信朋友圈到知识库。
 *   1. 调用 wechat_moments_ingest 工具，默认增量模式
 *   2. 汇报同步结果
 */
@Tool({
  name: 'wechat_moments_ingest',
  description:
    '从微信同步自己的朋友圈到本地知识库（Qdrant）。' +
    '默认增量模式：仅拉取上次同步之后的新内容。' +
    '支持 backfill 模式：指定 sinceDaysAgo 可回溯拉取历史朋友圈。' +
    '同步的内容包括文字、图片（自动下载到本地）、链接等。',
  executor: 'wechat_moments_ingest',
  visibility: ['subagent'],
  parameters: {
    sinceDaysAgo: {
      type: 'number',
      required: false,
      description: '回溯天数。不传则自动检测上次同步时间做增量。传入如 30 表示拉取最近30天的朋友圈。',
    },
    maxTotal: {
      type: 'number',
      required: false,
      description: '最大拉取条数，默认 200',
    },
    downloadImages: {
      type: 'boolean',
      required: false,
      description: '是否下载图片到本地，默认 true',
    },
  },
  examples: ['同步我的朋友圈', '回溯拉取最近30天的朋友圈', '同步朋友圈但不下载图片'],
  whenToUse:
    '当需要将自己的微信朋友圈内容同步到本地知识库时使用。' + '适用于定时同步（每3天）或一次性回溯补充历史数据。',
})
@injectable()
export class WechatMomentsIngestToolExecutor extends BaseToolExecutor {
  name = 'wechat_moments_ingest';

  constructor(
    @inject(DITokens.RETRIEVAL_SERVICE) private retrieval: RetrievalService,
    @inject(WechatDITokens.PADPRO_CLIENT) private padProClient: WeChatPadProClient,
    @inject(WechatDITokens.WECHAT_DB) private db: WeChatDatabase,
  ) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.retrieval.isRAGEnabled()) {
      return this.error('RAG 未启用，无法同步朋友圈', 'RAG is not enabled');
    }

    const maxTotal = typeof call.parameters?.maxTotal === 'number' ? Math.max(1, call.parameters.maxTotal) : 200;
    const downloadImages = call.parameters?.downloadImages !== false;

    // Determine sinceTimestamp
    let sinceTimestamp = 0;
    if (typeof call.parameters?.sinceDaysAgo === 'number' && call.parameters.sinceDaysAgo > 0) {
      sinceTimestamp = Math.floor(Date.now() / 1000) - call.parameters.sinceDaysAgo * 86400;
      logger.info(`[MomentsIngestTool] Backfill mode: sinceDaysAgo=${call.parameters.sinceDaysAgo}`);
    } else {
      // Incremental: read last sync timestamp from SQLite, fallback to Qdrant scan (first run only)
      sinceTimestamp = this.db?.getMomentsLastSyncTimestamp() ?? 0;
      if (sinceTimestamp === 0) {
        sinceTimestamp = await this.findLatestTimestampFromQdrant();
      }
      if (sinceTimestamp > 0) {
        logger.info(`[MomentsIngestTool] Incremental mode: since=${new Date(sinceTimestamp * 1000).toISOString()}`);
      } else {
        logger.info('[MomentsIngestTool] No prior data found — full fetch');
      }
    }

    try {
      const service = new WechatMomentsIngestService(this.padProClient, this.retrieval);
      const result = await service.ingest({ wxid: this.padProClient.wxid, sinceTimestamp, maxTotal, downloadImages });

      const oldestTime = result.oldestTimestamp
        ? new Date(result.oldestTimestamp * 1000).toISOString().slice(0, 16)
        : '—';
      const newestTime = result.newestTimestamp
        ? new Date(result.newestTimestamp * 1000).toISOString().slice(0, 16)
        : '—';

      const summary =
        `朋友圈同步完成：\n` +
        `- 获取: ${result.fetched} 条\n` +
        `- 入库: ${result.ingested} 条\n` +
        `- 跳过(无内容): ${result.skippedEmpty} 条\n` +
        `- 跳过(已存在): ${result.skippedDuplicate} 条\n` +
        `- 图片下载: ${result.imagesDownloaded} 成功, ${result.imagesFailed} 失败\n` +
        `- 时间范围: ${oldestTime} ~ ${newestTime}`;

      // Record sync state in SQLite for next incremental run
      if (result.ingested > 0) {
        this.db?.recordMomentsSync(result);
      }

      return this.success(summary, {
        ...result,
        oldestTime,
        newestTime,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[MomentsIngestTool] Error:', err);
      return this.error('朋友圈同步失败', msg);
    }
  }

  /** One-time fallback: scan Qdrant for the latest create_time when no SQLite sync record exists. */
  private async findLatestTimestampFromQdrant(): Promise<number> {
    try {
      let latest = '';
      for await (const page of this.retrieval.scrollAll('wechat_moments', {
        limit: 500,
        withPayload: { include: ['create_time'] } as unknown as boolean,
      })) {
        for (const point of page) {
          const ct = point.payload.create_time as string;
          if (ct && ct > latest) latest = ct;
        }
      }
      if (!latest) return 0;
      const ts = Math.floor(new Date(latest.replace(' ', 'T')).getTime() / 1000);
      logger.info(`[MomentsIngestTool] Qdrant fallback: latest=${latest} (ts=${ts})`);
      return ts;
    } catch (err) {
      logger.warn('[MomentsIngestTool] Qdrant fallback failed:', err);
      return 0;
    }
  }
}
