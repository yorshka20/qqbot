// AnalyzeVideoToolExecutor - downloads a video and analyzes it via Gemini Video API.
//
// Flow:
//   1. Download video via VideoDownloadService → { buffer, sessionId, tempPath }
//   2. Register tempPath with ResourceCleanupService under sessionId
//   3. Upload video buffer to Gemini File API
//   4. Wait for Gemini to finish processing the video
//   5. Generate analysis text using the uploaded fileUri (avoids double-upload)
//   6. Return structured analysis result
//   finally:
//     - Call ResourceCleanupService.cleanup(sessionId, deleteRemoteFile) to remove local temp files and Gemini files

import { inject, injectable } from 'tsyringe';
import type { AIManager } from '@/ai/AIManager';
import type { GeminiProvider } from '@/ai/providers/GeminiProvider';
import { DITokens } from '@/core/DITokens';
import type { ResourceCleanupService, VideoDownloadService } from '@/services/video';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Max video file size allowed for analysis. */
const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
/** Max video duration allowed for analysis (seconds). */
const MAX_VIDEO_DURATION_SECONDS = 10 * 60; // 10 minutes

@Tool({
  name: 'analyze_video',
  description:
    '下载并分析视频内容（仅供 video_analyzer subagent 使用，由 /video 命令触发）。普通群聊回复 LLM 看到视频链接不要调用此工具——视频分析需用户显式 /video 指令。',
  executor: 'analyze_video',
  // subagent-only: removed reply scope so reply-flow LLM cannot auto-analyze every video URL
  // it sees in chat. Video analysis must be invoked explicitly via the /video command, which
  // routes through VideoAnalyzePlugin → runSubAgent('video_analyzer') → this tool.
  visibility: { subagent: true },
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: '视频的 URL 地址，支持 B站、油管 等常见视频平台链接',
    },
    prompt: {
      type: 'string',
      required: false,
      description: '分析提示词，描述你想从视频中获得什么样的分析结果。如不提供，则进行通用内容总结',
    },
  },
  examples: ['/video https://b23.tv/xxx', '引用视频消息后发送 /video'],
  whenToUse:
    'video_analyzer subagent 收到 /video 任务时调用一次。每个 URL 只调一次，失败立即返回错误，禁止用同一 URL 重试或回退到其他视频工具——错误信息会原样转给用户。',
})
@injectable()
export class AnalyzeVideoToolExecutor extends BaseToolExecutor {
  name = 'analyze_video';

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(DITokens.VIDEO_DOWNLOAD_SERVICE) private videoDownloadService: VideoDownloadService,
    @inject(DITokens.RESOURCE_CLEANUP_SERVICE) private resourceCleanupService: ResourceCleanupService,
  ) {
    super();
  }

  private getGeminiProvider(): GeminiProvider {
    const provider = this.aiManager.getProvider('gemini');
    if (!provider) {
      throw new Error('Gemini provider is not available — please configure gemini in config.json');
    }
    return provider as GeminiProvider;
  }

  /** Probe video duration in seconds using ffprobe. Returns null if ffprobe is unavailable or fails. */
  private async probeVideoDuration(filePath: string): Promise<number | null> {
    try {
      const proc = Bun.spawn({
        cmd: ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) =>
          setTimeout(() => {
            proc.kill();
            reject(new Error('ffprobe timeout'));
          }, 10_000),
        ),
      ]);
      if (exitCode !== 0) return null;
      const stdout = await new Response(proc.stdout).text();
      const seconds = parseFloat(stdout.trim());
      return Number.isFinite(seconds) ? seconds : null;
    } catch {
      logger.debug('[AnalyzeVideoToolExecutor] ffprobe not available or failed, skipping duration check');
      return null;
    }
  }

  /** Infer video MIME type from URL pattern. Falls back to video/mp4. */
  private inferVideoMimeType(url: string): string {
    const lower = url.toLowerCase();
    if (lower.includes('.webm')) {
      return 'video/webm';
    }
    if (lower.includes('.mov')) {
      return 'video/quicktime';
    }
    if (lower.includes('.avi')) {
      return 'video/x-msvideo';
    }
    return 'video/mp4'; // default — covers bilibili, youtube, and generic .mp4
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const url = call.parameters?.url as string | undefined;
    if (!url) {
      return this.error('请提供视频 URL', 'Missing required parameter: url');
    }

    const prompt = (call.parameters?.prompt as string | undefined) ?? '请详细描述这个视频的主题、主要内容和关键亮点。';

    let sessionId: string | undefined;
    let uploadedFileName: string | undefined;

    try {
      // Step 1: Download video
      logger.info(`[AnalyzeVideoToolExecutor] Downloading video from: ${url}`);
      let downloadResult: Awaited<ReturnType<VideoDownloadService['download']>>;
      try {
        downloadResult = await this.videoDownloadService.download(url, {
          timeout: 120_000,
          maxSize: 100 * 1024 * 1024,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Video download failed: ${msg}`);
        return this.error(
          `视频下载失败，请检查链接是否有效：${msg}（不要重试，直接把这条错误转告用户）`,
          `Video download failed: ${msg}. Do not retry.`,
        );
      }

      const cleanupSessionId = downloadResult.sessionId;
      sessionId = cleanupSessionId;

      // Step 1.5: Validate file size and duration before uploading
      const fileSizeMB = (downloadResult.buffer.length / (1024 * 1024)).toFixed(1);
      if (downloadResult.buffer.length > MAX_VIDEO_SIZE_BYTES) {
        logger.warn(
          `[AnalyzeVideoToolExecutor] Video too large: ${fileSizeMB}MB (max ${MAX_VIDEO_SIZE_BYTES / 1024 / 1024}MB)`,
        );
        return this.error(
          `视频文件过大（${fileSizeMB}MB），最大支持 ${MAX_VIDEO_SIZE_BYTES / 1024 / 1024}MB。请尝试较短的视频。`,
          `Video too large: ${fileSizeMB}MB`,
        );
      }

      const duration = await this.probeVideoDuration(downloadResult.tempPath);
      if (duration !== null && duration > MAX_VIDEO_DURATION_SECONDS) {
        const durationMin = (duration / 60).toFixed(1);
        logger.warn(
          `[AnalyzeVideoToolExecutor] Video too long: ${durationMin}min (max ${MAX_VIDEO_DURATION_SECONDS / 60}min)`,
        );
        return this.error(
          `视频时长过长（${durationMin}分钟），最大支持 ${MAX_VIDEO_DURATION_SECONDS / 60} 分钟。请尝试较短的视频。`,
          `Video too long: ${durationMin}min`,
        );
      }
      logger.info(
        `[AnalyzeVideoToolExecutor] Video validated | size=${fileSizeMB}MB | duration=${duration !== null ? `${(duration / 60).toFixed(1)}min` : 'unknown'}`,
      );

      // Step 2: Upload to Gemini File API
      const mimeType = this.inferVideoMimeType(url);
      const gemini = this.getGeminiProvider();
      logger.info('[AnalyzeVideoToolExecutor] Uploading video to Gemini File API...');
      let uploadedFile: Awaited<ReturnType<GeminiProvider['uploadVideoFile']>>;
      try {
        uploadedFile = await gemini.uploadVideoFile(downloadResult.buffer, mimeType);
        const remoteFileName = uploadedFile.name;
        if (!remoteFileName) {
          logger.error('[AnalyzeVideoToolExecutor] Gemini upload returned no file name');
          return this.error('视频上传失败：Gemini 未返回文件名', 'Gemini upload returned no file name');
        }
        uploadedFileName = remoteFileName;
        logger.info(`[AnalyzeVideoToolExecutor] Uploaded file: ${remoteFileName}`);
        this.resourceCleanupService.registerLocalFile(cleanupSessionId, downloadResult.tempPath);
        this.resourceCleanupService.registerRemoteFile(cleanupSessionId, remoteFileName, 'gemini');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini upload failed: ${msg}`);
        return this.error(
          `视频上传失败：${msg}（不要重试，直接把这条错误转告用户）`,
          `Gemini upload failed: ${msg}. Do not retry.`,
        );
      }

      // Step 3: Wait for Gemini to process the video
      let processedFile: Awaited<ReturnType<GeminiProvider['waitForFileProcessing']>>;
      try {
        processedFile = await gemini.waitForFileProcessing(uploadedFileName ?? '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini file processing failed: ${msg}`);
        return this.error(
          `视频处理失败：${msg}（不要重试，直接把这条错误转告用户）`,
          `Gemini file processing failed: ${msg}. Do not retry.`,
        );
      }

      // Step 4: Generate analysis via fileUri (skips re-upload that generateWithVideo would cause)
      const fileUri = processedFile.uri ?? '';
      const fileMime = processedFile.mimeType ?? mimeType;
      logger.info(
        `[AnalyzeVideoToolExecutor] Generating video analysis... | fileUri=${fileUri} | mimeType=${fileMime} | prompt=${prompt.substring(0, 80)}`,
      );
      let analysisText: string;
      try {
        const result = await gemini.generateWithFileUri(prompt, fileUri, fileMime, {
          maxTokens: 2000,
          temperature: 0.5,
        });
        analysisText = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini analysis failed: ${msg}`);
        return this.error(
          `视频分析失败：${msg}（不要重试，直接把这条错误转告用户）`,
          `Gemini analysis failed: ${msg}. Do not retry.`,
        );
      }

      if (!analysisText || analysisText.trim().length === 0) {
        return this.error('视频分析未返回有效内容，可能是视频无法被解析', 'Gemini returned empty analysis');
      }

      logger.info(`[AnalyzeVideoToolExecutor] Analysis complete (${analysisText.length} chars)`);
      return {
        success: true,
        reply: `视频分析完成`,
        data: {
          url,
          prompt,
          analysisText,
          charCount: analysisText.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[AnalyzeVideoToolExecutor] Unexpected error: ${msg}`);
      return this.error(`视频分析异常：${msg}`, `Unexpected error: ${msg}`);
    } finally {
      // Cleanup session resources (temp files and Gemini uploads registered above)
      if (sessionId) {
        await this.resourceCleanupService.cleanup(sessionId);
      }
    }
  }
}
