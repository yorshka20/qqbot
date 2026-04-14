// VideoDownloadService - downloads a video from a URL to an in-memory Buffer and a local temp file.
//
// Responsibilities:
//   1. Download video bytes via ResourceDownloader
//   2. Save a local temp file for session-scoped cleanup
//   3. Return { buffer, sessionId, tempPath } to the caller

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { injectable, singleton } from 'tsyringe';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import { logger } from '@/utils/logger';

/** Directory where temp video files are written. */
const VIDEO_TEMP_DIR = join(process.cwd(), 'output', 'video-analysis');

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

    const base64Data = await ResourceDownloader.downloadToBase64(url, { timeout, maxSize });
    const buffer = Buffer.from(base64Data, 'base64');

    // Persist to a temp file so ResourceCleanupService can delete it later.
    await mkdir(VIDEO_TEMP_DIR, { recursive: true });
    const tempPath = join(VIDEO_TEMP_DIR, `${sessionId}.tmp`);
    await Bun.write(tempPath, buffer);

    logger.debug(`[VideoDownloadService] Saved temp file | path=${tempPath} | size=${buffer.length}`);
    return { buffer, sessionId, tempPath };
  }
}
