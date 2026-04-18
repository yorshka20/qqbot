// Video Knowledge Backend client
// Wraps the HTTP API for submitting video analysis tasks and retrieving results.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectable } from 'tsyringe';
import { HttpClient } from '@/api/http/HttpClient';
import type { VideoKnowledgeConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import type {
  VideoKnowledgeAnalyzeRequest,
  VideoKnowledgeAnalyzeResponse,
  VideoKnowledgeIngestRequest,
  VideoKnowledgeIngestResponse,
  VideoKnowledgePollResult,
  VideoKnowledgeResult,
  VideoKnowledgeTask,
} from './types';

const LOG_TAG = '[VideoKnowledgeClient]';

@injectable()
export class VideoKnowledgeClient {
  private readonly httpClient: HttpClient;
  private readonly dataDir?: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly enabled: boolean;

  constructor(config: VideoKnowledgeConfig) {
    this.enabled = config.enabled;
    this.dataDir = config.dataDir;
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 300_000;

    this.httpClient = new HttpClient({
      baseURL: config.baseURL,
      defaultHeaders: { 'Content-Type': 'application/json' },
      defaultTimeout: 10_000,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Health check — GET /api/v1/health
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.httpClient.get<{ status: string }>('/api/v1/health');
      return res.status === 'ok';
    } catch (err) {
      logger.warn(`${LOG_TAG} Health check failed:`, err);
      return false;
    }
  }

  /**
   * Submit a video analysis task — POST /api/v1/analyze
   */
  async submitAnalysis(videoId: string): Promise<VideoKnowledgeAnalyzeResponse> {
    logger.info(`${LOG_TAG} Submitting analysis for ${videoId}`);
    const body: VideoKnowledgeAnalyzeRequest = {
      platform: 'bilibili',
      video_id: videoId,
    };
    return this.httpClient.post<VideoKnowledgeAnalyzeResponse>('/api/v1/analyze', body);
  }

  /**
   * Push external data and trigger analysis — POST /api/v1/ingest
   */
  async submitIngest(data: VideoKnowledgeIngestRequest): Promise<VideoKnowledgeIngestResponse> {
    logger.info(`${LOG_TAG} Submitting ingest for ${data.video_id}`);
    return this.httpClient.post<VideoKnowledgeIngestResponse>('/api/v1/ingest', data);
  }

  /**
   * Query task status — GET /api/v1/tasks/{id}
   */
  async getTaskStatus(taskId: number): Promise<VideoKnowledgeTask> {
    return this.httpClient.get<VideoKnowledgeTask>(`/api/v1/tasks/${taskId}`);
  }

  /**
   * Poll task until terminal state (done/failed) or timeout.
   */
  async pollTaskResult(taskId: number): Promise<VideoKnowledgePollResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.pollTimeoutMs) {
      try {
        const task = await this.getTaskStatus(taskId);

        if (task.status === 'done') {
          return { success: true, task };
        }
        if (task.status === 'failed') {
          return { success: false, error: task.error_msg || '分析失败', task };
        }

        // queued or claimed — keep polling
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      } catch (err) {
        logger.warn(`${LOG_TAG} Poll error for task ${taskId}:`, err);
        // Continue polling on transient errors
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }

    return { success: false, error: '轮询超时，任务仍在处理中' };
  }

  /**
   * Read analysis result from local filesystem.
   * Searches data/kb/ for a JSON file matching the given video_id.
   * Returns null if dataDir is not configured or file not found.
   */
  readResult(videoId: string): VideoKnowledgeResult | null {
    if (!this.dataDir) {
      logger.debug(`${LOG_TAG} No dataDir configured, cannot read local result`);
      return null;
    }

    const kbDir = resolve(this.dataDir, 'kb');
    if (!existsSync(kbDir)) {
      logger.debug(`${LOG_TAG} KB directory not found: ${kbDir}`);
      return null;
    }

    // Search through creator directories for a matching result
    try {
      const creators = readdirSync(kbDir, { withFileTypes: true });
      for (const creator of creators) {
        if (!creator.isDirectory()) continue;
        const creatorDir = resolve(kbDir, creator.name);
        const files = readdirSync(creatorDir).filter((f) => f.endsWith('.json'));

        for (const file of files) {
          const filePath = resolve(creatorDir, file);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const result = JSON.parse(content) as VideoKnowledgeResult;
            if (result.video_info?.video_id === videoId) {
              logger.info(`${LOG_TAG} Found result for ${videoId} at ${filePath}`);
              return result;
            }
          } catch {
            // Skip files that can't be parsed
          }
        }
      }
    } catch (err) {
      logger.warn(`${LOG_TAG} Error reading results from ${kbDir}:`, err);
    }

    logger.debug(`${LOG_TAG} No result found for ${videoId}`);
    return null;
  }

  /**
   * Format analysis result into a readable message.
   */
  formatResult(result: VideoKnowledgeResult): string {
    const info = result.video_info;
    const lines: string[] = [];

    lines.push(`📺 ${info.title}`);
    lines.push(`👤 ${info.creator.name} | ⏱ ${this.formatDuration(info.duration)}`);

    if (info.stats) {
      lines.push(`👀 ${this.formatCount(info.stats.view_count)} | 👍 ${this.formatCount(info.stats.like_count)}`);
    }
    lines.push('');

    if (result.summary) {
      lines.push('📝 内容摘要:');
      lines.push(result.summary);
      lines.push('');
    }

    if (result.highlights?.length) {
      lines.push('🔥 高光时刻:');
      for (const h of result.highlights) {
        lines.push(`  [${this.formatTime(h.start_sec)}] ${h.title} — ${h.description}`);
      }
      lines.push('');
    }

    if (result.peaks?.length) {
      lines.push('💬 弹幕高能时刻:');
      for (const p of result.peaks.slice(0, 3)) {
        const overlays = p.top_overlays?.slice(0, 3).join('、') || '';
        lines.push(`  [${this.formatTime(p.start_sec)}] ${p.count}条弹幕 — ${overlays}`);
      }
    }

    return lines.join('\n');
  }

  private formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private formatCount(count: number): string {
    if (count >= 100_000_000) {
      return `${(count / 100_000_000).toFixed(1)}亿`;
    }
    if (count >= 10_000) {
      return `${(count / 10_000).toFixed(1)}万`;
    }
    return count.toString();
  }
}
