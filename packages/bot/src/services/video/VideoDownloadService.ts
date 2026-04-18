// VideoDownloadService - downloads a video from a URL to an in-memory Buffer and a local temp file.
//
// Responsibilities:
//   1. Route known video-platform URLs through yt-dlp when available
//   2. Fall back to the existing HTTP downloader for generic URLs or yt-dlp failures
//   3. Save a local temp file for session-scoped cleanup
//   4. Return { buffer, sessionId, tempPath } to the caller

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { injectable, singleton } from 'tsyringe';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';

/** Directory where temp video files are written. */
const VIDEO_TEMP_DIR = join(getRepoRoot(), 'output', 'video-analysis');
const YT_DLP_TIMEOUT_MS = 10 * 60 * 1000;
const YT_DLP_MAX_FILESIZE_BYTES = 500 * 1024 * 1024;

/** Options forwarded to the underlying HTTP download. */
export interface VideoDownloadOptions {
  /** Request timeout in milliseconds (default 120 000). */
  timeout?: number;
  /** Max allowed file size in bytes (default 100 MB). */
  maxSize?: number;
}

/** Return value of VideoDownloadService.download(). */
export interface VideoDownloadResult {
  /** Raw video bytes. */
  buffer: Buffer;
  /** Unique session identifier for resource-cleanup tracking. */
  sessionId: string;
  /** Absolute path to the local temp file on disk. */
  tempPath: string;
}

@injectable()
@singleton()
export class VideoDownloadService {
  private ytDlpAvailable: boolean | null = null;
  private ytDlpAvailabilityPromise: Promise<boolean>;
  private ytDlpAvailabilityWarned = false;

  constructor() {
    this.ytDlpAvailabilityPromise = this.detectYtDlpAvailability();
  }

  /**
   * Download a video from the given URL, persist it to a local temp file,
   * and return both the raw bytes and the session metadata.
   *
   * @throws Error if download fails or the file exceeds maxSize
   */
  async download(url: string, options?: VideoDownloadOptions): Promise<VideoDownloadResult> {
    const sessionId = `video_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = options?.timeout ?? 120_000;
    const maxSize = options?.maxSize ?? 100 * 1024 * 1024; // 100 MB

    // Resolve short links (b23.tv) to canonical URLs before processing
    const resolvedUrl = await this.resolveShortLink(url);
    if (resolvedUrl !== url) {
      logger.info(`[VideoDownloadService] Resolved short link | ${url} → ${resolvedUrl}`);
    }

    logger.info(`[VideoDownloadService] Downloading video | session=${sessionId} | url=${resolvedUrl}`);

    const isPlatformUrl = this.shouldPreferYtDlp(resolvedUrl);

    if (isPlatformUrl) {
      const ytDlpAvailable = await this.ensureYtDlpAvailability();
      if (ytDlpAvailable) {
        try {
          return await this.downloadWithYtDlp(resolvedUrl, { sessionId, timeout, maxSize });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            `[VideoDownloadService] yt-dlp failed for ${resolvedUrl}; falling back to HTTP download | session=${sessionId} | error=${err.message}`,
          );
        }
      } else {
        // Platform URLs (bilibili, youtube, etc.) CANNOT be downloaded via plain HTTP — they serve HTML pages, not video files
        throw new Error(
          `yt-dlp 未安装或不可用，无法下载平台视频（${new URL(resolvedUrl).hostname}）。请安装 yt-dlp: brew install yt-dlp`,
        );
      }
    }

    return this.downloadViaHttp(resolvedUrl, { sessionId, timeout, maxSize });
  }

  /**
   * Resolve short link URLs (e.g. b23.tv) by following HTTP redirects.
   * Returns the final URL after all redirects, or the original URL if resolution fails.
   */
  private async resolveShortLink(url: string): Promise<string> {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      // Only resolve known short link domains
      if (hostname !== 'b23.tv') {
        return url;
      }
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const finalUrl = response.url;
      // Strip tracking query params for cleaner URLs
      if (finalUrl.includes('bilibili.com')) {
        const parsed = new URL(finalUrl);
        // Keep only the path (e.g., /video/BVxxx)
        return `${parsed.origin}${parsed.pathname}`;
      }
      return finalUrl;
    } catch {
      logger.debug(`[VideoDownloadService] Short link resolution failed for ${url}, using original`);
      return url;
    }
  }

  private async downloadViaHttp(
    url: string,
    options: { sessionId: string; timeout: number; maxSize: number },
  ): Promise<VideoDownloadResult> {
    const base64Data = await ResourceDownloader.downloadToBase64(url, {
      timeout: options.timeout,
      maxSize: options.maxSize,
    });
    const buffer = Buffer.from(base64Data, 'base64');

    await mkdir(VIDEO_TEMP_DIR, { recursive: true });
    const tempPath = join(VIDEO_TEMP_DIR, `${options.sessionId}.tmp`);
    await Bun.write(tempPath, buffer);

    logger.debug(`[VideoDownloadService] Saved temp file | path=${tempPath} | size=${buffer.length}`);
    return { buffer, sessionId: options.sessionId, tempPath };
  }

  private async downloadWithYtDlp(
    url: string,
    options: { sessionId: string; timeout: number; maxSize: number },
  ): Promise<VideoDownloadResult> {
    await mkdir(VIDEO_TEMP_DIR, { recursive: true });

    const tempPath = join(VIDEO_TEMP_DIR, `${options.sessionId}.mp4`);
    const proc = Bun.spawn({
      cmd: [
        'yt-dlp',
        '--no-playlist',
        '--max-filesize',
        this.formatMaxFileSize(options.maxSize),
        '-f',
        'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '--merge-output-format',
        'mp4',
        '-o',
        tempPath,
        url,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await this.waitForProcess(proc, YT_DLP_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(
        `yt-dlp exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : stdout.trim() ? `: ${stdout.trim()}` : ''}`,
      );
    }

    const buffer = await readFile(tempPath);
    logger.debug(`[VideoDownloadService] yt-dlp saved temp file | path=${tempPath} | size=${buffer.length}`);
    return { buffer, sessionId: options.sessionId, tempPath };
  }

  private shouldPreferYtDlp(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return (
        hostname === 'bilibili.com' ||
        hostname.endsWith('.bilibili.com') ||
        hostname === 'b23.tv' ||
        hostname === 'youtube.com' ||
        hostname.endsWith('.youtube.com') ||
        hostname === 'youtu.be'
      );
    } catch {
      return false;
    }
  }

  private async detectYtDlpAvailability(): Promise<boolean> {
    try {
      const proc = Bun.spawn({
        cmd: ['yt-dlp', '--version'],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await this.waitForProcess(proc, 10_000);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const available = exitCode === 0 && stdout.trim().length > 0;

      this.ytDlpAvailable = available;
      if (!available) {
        this.logYtDlpUnavailable(stderr.trim() || stdout.trim() || `exit code ${exitCode}`);
      }

      return available;
    } catch (error) {
      this.ytDlpAvailable = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.logYtDlpUnavailable(err.message);
      return false;
    }
  }

  private async ensureYtDlpAvailability(): Promise<boolean> {
    if (this.ytDlpAvailable !== null) {
      return this.ytDlpAvailable;
    }

    return this.ytDlpAvailabilityPromise;
  }

  private logYtDlpUnavailable(reason: string): void {
    if (this.ytDlpAvailabilityWarned) {
      return;
    }

    this.ytDlpAvailabilityWarned = true;
    logger.warn(`[VideoDownloadService] yt-dlp is unavailable (${reason}); platform video URLs will use HTTP fallback`);
  }

  private formatMaxFileSize(maxSizeBytes: number): string {
    const boundedSize = Math.min(
      maxSizeBytes > 0 ? maxSizeBytes : YT_DLP_MAX_FILESIZE_BYTES,
      YT_DLP_MAX_FILESIZE_BYTES,
    );
    if (boundedSize % (1024 * 1024) === 0) {
      return `${boundedSize / (1024 * 1024)}M`;
    }

    if (boundedSize % 1024 === 0) {
      return `${boundedSize / 1024}K`;
    }

    return String(boundedSize);
  }

  private async waitForProcess(proc: Bun.Subprocess, timeoutMs: number): Promise<number> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutId = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`Process timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      return await Promise.race([proc.exited, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
