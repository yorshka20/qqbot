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

@Tool({
  name: 'analyze_video',
  description: '下载并分析视频内容。使用视频URL调用此工具，获取视频的主题、内容概要和关键亮点等分析结果。',
  executor: 'analyze_video',
  visibility: ['reply', 'subagent'],
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
  examples: ['分析这个视频讲了什么', '帮我看看这个视频的内容'],
  triggerKeywords: ['分析视频', '视频内容', '看视频', '视频说了什么'],
  whenToUse: '当用户发送视频链接并要求分析视频内容时调用。工具会自动下载并分析视频，返回结构化的分析总结。',
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
        return this.error(`视频下载失败，请检查链接是否有效：${msg}`, `Video download failed: ${msg}`);
      }

      const cleanupSessionId = downloadResult.sessionId;
      sessionId = cleanupSessionId;
      // Register temp file for cleanup in finally
      this.resourceCleanupService.register(cleanupSessionId, downloadResult.tempPath);

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
        this.resourceCleanupService.registerRemoteFile(cleanupSessionId, remoteFileName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini upload failed: ${msg}`);
        return this.error(`视频上传失败：${msg}`, `Gemini upload failed: ${msg}`);
      }

      // Step 3: Wait for Gemini to process the video
      let processedFile: Awaited<ReturnType<GeminiProvider['waitForFileProcessing']>>;
      try {
        processedFile = await gemini.waitForFileProcessing(uploadedFileName ?? '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini file processing failed: ${msg}`);
        return this.error(`视频处理失败：${msg}`, `Gemini file processing failed: ${msg}`);
      }

      // Step 4: Generate analysis via fileUri (skips re-upload that generateWithVideo would cause)
      logger.info('[AnalyzeVideoToolExecutor] Generating video analysis...');
      let analysisText: string;
      try {
        const result = await gemini.generateWithFileUri(
          prompt,
          processedFile.uri ?? '',
          processedFile.mimeType ?? mimeType,
          { maxTokens: 2000, temperature: 0.7 },
        );
        analysisText = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[AnalyzeVideoToolExecutor] Gemini analysis failed: ${msg}`);
        return this.error(`视频分析失败：${msg}`, `Gemini analysis failed: ${msg}`);
      }

      if (!analysisText || analysisText.trim().length === 0) {
        return this.error('视频分析未返回有效内容，可能是视频无法被解析', 'Gemini returned empty analysis');
      }

      logger.info(`[AnalyzeVideoToolExecutor] Analysis complete (${analysisText.length} chars)`);
      return {
        success: true,
        reply: `视频分析完成：${analysisText.substring(0, 100)}...`,
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
        await this.resourceCleanupService.cleanup(sessionId, async (fileName) => {
          await this.getGeminiProvider().deleteUploadedFile(fileName);
          logger.debug(`[AnalyzeVideoToolExecutor] Deleted Gemini file: ${fileName}`);
        });
      }
    }
  }
}
