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

/** Directory where temp video files are written. */
const VIDEO_TEMP_DIR = join(process.cwd(), 'output', 'video-analysis');
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

    logger.info(`[VideoDownloadService] Downloading video | session=${sessionId} | url=${url}`);

    if (this.shouldPreferYtDlp(url)) {
      const ytDlpAvailable = await this.ensureYtDlpAvailability();
      if (ytDlpAvailable) {
        try {
          return await this.downloadWithYtDlp(url, { sessionId, timeout, maxSize });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            `[VideoDownloadService] yt-dlp failed for ${url}; falling back to HTTP download | session=${sessionId} | error=${err.message}`,
          );
        }
      } else {
        this.logYtDlpFallbackOnce(url);
      }
    }

    return this.downloadViaHttp(url, { sessionId, timeout, maxSize });
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

  private logYtDlpFallbackOnce(url: string): void {
    logger.warn(`[VideoDownloadService] yt-dlp is unavailable for ${url}; falling back to HTTP download`);
  }

  private formatMaxFileSize(maxSizeBytes: number): string {
    const boundedSize = Math.min(maxSizeBytes > 0 ? maxSizeBytes : YT_DLP_MAX_FILESIZE_BYTES, YT_DLP_MAX_FILESIZE_BYTES);
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
