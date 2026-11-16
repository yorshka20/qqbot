// Video Knowledge Backend client
// Submits video analyses to video-knowledge-backend and waits for their results on the task's
// SSE stream. Everything goes over HTTP; the backend's filesystem is never read.

import { setTimeout as sleep } from 'node:timers/promises';
import { HttpClient, HttpClientError, logger, readSSE } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import type { Config, VideoKnowledgeConfig } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { VKBTokenManager } from '@/services/vkb/VKBTokenManager';
import type {
  VideoKnowledgeAnalysis,
  VideoKnowledgeAnalyzeRequest,
  VideoKnowledgeAnalyzeResponse,
  VideoKnowledgeCompleteEvent,
  VideoKnowledgeFatalErrorEvent,
  VideoKnowledgeIngestRequest,
  VideoKnowledgeIngestResponse,
  VideoKnowledgeResult,
  VideoKnowledgeSubmitOutcome,
  VideoKnowledgeTask,
  VideoKnowledgeTaskOutcome,
} from './types';

const LOG_TAG = '[VideoKnowledgeClient]';

const DEFAULT_BASE_URL = 'http://localhost:8090';
const DEFAULT_WAIT_TIMEOUT_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Delay before reconnecting after the n-th consecutive stream failure. The first retry is
// immediate: reconnecting is always safe, since the backend replays a finished task's
// terminal event from its task record.
const RECONNECT_DELAYS_MS = [0, 1000, 2000, 5000, 10_000, 30_000];

/** How one connection to a task's event stream ended. */
type StreamEnd = { kind: 'terminal'; outcome: VideoKnowledgeTaskOutcome } | { kind: 'timeout' } | { kind: 'dropped' };

@singleton()
export class VideoKnowledgeClient {
  private readonly httpClient: HttpClient;
  private readonly tokenManager: VKBTokenManager;
  private readonly waitTimeoutMs: number;
  private readonly enabled: boolean;

  constructor(@inject(DITokens.CONFIG) botConfig: Config) {
    const config: VideoKnowledgeConfig = botConfig.getVideoKnowledgeConfig() ?? {
      enabled: false,
      baseURL: DEFAULT_BASE_URL,
    };
    this.enabled = config.enabled;
    this.waitTimeoutMs = config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

    this.httpClient = new HttpClient({
      baseURL: config.baseURL,
      defaultHeaders: { 'Content-Type': 'application/json' },
      defaultTimeout: REQUEST_TIMEOUT_MS,
    });
    this.tokenManager = new VKBTokenManager({
      httpClient: this.httpClient,
      password: config.authPassword,
      staticToken: config.authToken,
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Health check — GET /api/v1/health (no auth)
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
   * Submit a video for analysis — POST /api/v1/analyze with the user's raw input. The backend
   * resolves the video (URLs, short links, BV / av ids, even inside other text) and analyzes each
   * video once: an analyzed video answers with its existing analysis instead of a new task.
   */
  async submitAnalysis(input: string): Promise<VideoKnowledgeSubmitOutcome> {
    logger.info(`${LOG_TAG} Submitting analysis for input: ${input}`);
    const body: VideoKnowledgeAnalyzeRequest = { url: input };
    try {
      const res = await this.withAuth((headers) =>
        this.httpClient.post<VideoKnowledgeAnalyzeResponse>('/api/v1/analyze', body, { headers }),
      );
      logger.info(`${LOG_TAG} Analysis of ${res.video_id}: ${res.status} (task ${res.task_id})`);
      return res;
    } catch (err) {
      if (err instanceof HttpClientError && err.status === 400) {
        return { status: 'unresolvable', error: err.message };
      }
      throw err;
    }
  }

  /**
   * Push external data and trigger analysis — POST /api/v1/ingest
   */
  async submitIngest(data: VideoKnowledgeIngestRequest): Promise<VideoKnowledgeIngestResponse> {
    logger.info(`${LOG_TAG} Submitting ingest for ${data.video_id}`);
    return this.withAuth((headers) =>
      this.httpClient.post<VideoKnowledgeIngestResponse>('/api/v1/ingest', data, { headers }),
    );
  }

  /**
   * Query task status — GET /api/v1/tasks/{id}
   */
  async getTaskStatus(taskId: number): Promise<VideoKnowledgeTask> {
    return this.withAuth((headers) => this.httpClient.get<VideoKnowledgeTask>(`/api/v1/tasks/${taskId}`, { headers }));
  }

  /**
   * Wait for a task to end by following GET /api/v1/tasks/{id}/stream: `complete` and
   * `fatal_error` end the wait, everything else is progress. A dropped connection or the stream's
   * own `timeout` reconnects until `waitTimeoutMs` (or the shorter `options.timeoutMs`) runs out
   * or `options.signal` aborts, which both end in `{ status: 'timeout' }`. Throws when the backend
   * refuses the stream (auth, bad task id) or sends an event it cannot parse.
   */
  async waitForTask(
    taskId: number,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<VideoKnowledgeTaskOutcome> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.waitTimeoutMs, this.waitTimeoutMs);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    let failures = 0;
    while (!signal.aborted) {
      let end: StreamEnd;
      try {
        end = await this.followTaskStream(taskId, signal);
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        if (!isTransient(err)) {
          throw err;
        }
        end = { kind: 'dropped' };
        logger.warn(`${LOG_TAG} Stream for task ${taskId} failed:`, err);
      }

      if (end.kind === 'terminal') {
        return end.outcome;
      }
      if (signal.aborted) {
        break;
      }
      if (end.kind === 'timeout') {
        failures = 0;
        continue;
      }
      failures++;
      const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length) - 1];
      logger.info(`${LOG_TAG} Stream for task ${taskId} ended early; reconnecting in ${delay}ms`);
      await sleep(delay, undefined, { signal }).catch(() => {});
    }

    if (deadline.aborted) {
      logger.warn(`${LOG_TAG} Gave up waiting for task ${taskId} after ${timeoutMs}ms`);
    } else {
      logger.info(`${LOG_TAG} Stopped waiting for task ${taskId}: the caller aborted`);
    }
    return { status: 'timeout' };
  }

  /**
   * Format an analysis (the analyze `analyzed` response or a stream `complete` event) into a
   * readable message.
   */
  formatAnalysis(analysis: VideoKnowledgeAnalysis): string {
    if (analysis.status === 'ready' && analysis.result) {
      return this.formatResult(analysis.result);
    }
    switch (analysis.status) {
      case 'processing':
        return `⏳ 视频 ${analysis.video_id} 仍在分析中`;
      case 'failed':
        return `❌ 视频 ${analysis.video_id} 分析失败${analysis.progress?.error_msg ? `: ${analysis.progress.error_msg}` : ''}`;
      default:
        return `视频 ${analysis.video_id} 已分析入库，但没有可展示的报告`;
    }
  }

  private formatResult(result: VideoKnowledgeResult): string {
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

    return lines.join('\n').trimEnd();
  }

  /** Read one connection of a task's event stream until a terminal event, `timeout`, or the end. */
  private async followTaskStream(taskId: number, signal: AbortSignal): Promise<StreamEnd> {
    const body = await this.withAuth((headers) =>
      this.httpClient.stream(`/api/v1/tasks/${taskId}/stream`, {
        headers: { ...headers, Accept: 'text/event-stream' },
        signal,
      }),
    );

    for await (const message of readSSE(body, signal)) {
      switch (message.event) {
        case 'complete': {
          const data = JSON.parse(message.data) as VideoKnowledgeCompleteEvent;
          return {
            kind: 'terminal',
            outcome: { status: 'complete', analysis: data.analysis, alreadyAnalyzed: data.already_analyzed === true },
          };
        }
        case 'fatal_error': {
          const data = JSON.parse(message.data) as VideoKnowledgeFatalErrorEvent;
          return { kind: 'terminal', outcome: { status: 'failed', error: data.error || '分析失败' } };
        }
        case 'timeout':
          return { kind: 'timeout' };
        case 'retrying':
          logger.info(`${LOG_TAG} Task ${taskId} retrying: ${message.data}`);
          break;
        default:
          logger.debug(`${LOG_TAG} Task ${taskId} ${message.event}: ${message.data}`);
      }
    }
    return { kind: 'dropped' };
  }

  /**
   * Send a request with the current bearer token. On 401 — the token expired, or the backend
   * restarted with a new auth secret — drop the cached token and retry once with a fresh one.
   */
  private async withAuth<T>(send: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      return await send(await this.authHeaders());
    } catch (err) {
      if (err instanceof HttpClientError && err.status === 401 && this.tokenManager.canRefresh) {
        this.tokenManager.invalidate();
        return send(await this.authHeaders());
      }
      throw err;
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenManager.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
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

/** A 4xx answer (auth, bad task id) will not change on reconnect; network errors and 5xx may. */
function isTransient(err: unknown): boolean {
  if (err instanceof HttpClientError) {
    return err.status === undefined || err.status >= 500;
  }
  return !(err instanceof SyntaxError);
}
