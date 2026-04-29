// GroupDownload Plugin - automatically downloads images, files, and videos from configured groups to local disk

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import type { HookContext } from '@/hooks/types';
import type { FileReadService } from '@/services/file';
import { runDeduplication } from '@/utils/fileDedup';
import { getDefaultExtension, getExtensionFromUrl, hashForFilename, uniqueFilename } from '@/utils/fileNameHelpers';
import { logger } from '@/utils/logger';
import { getDataValue } from '@/utils/segmentData';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Output directory root; files are saved under output/downloads/{groupid} */
const DOWNLOAD_ROOT = 'output/downloads';

export interface GroupDownloadPluginConfig {
  /**
   * List of group IDs to monitor. Messages from these groups will have their
   * images, files, and videos downloaded to output/downloads/{groupid}
   */
  groupIds?: string[];

  /**
   * How often to run content-based deduplication on downloaded files (milliseconds).
   * Example: 3600000 for every hour, 86400000 for every day.
   * Omit or set to 0 to disable scheduled dedup.
   */
  deduplicateIntervalMs?: number;
}

@RegisterPlugin({
  name: 'groupDownload',
  version: '1.0.0',
  description:
    'Downloads images, stickers/表情, files, and videos from configured groups to output/downloads/{groupid}',
})
export class GroupDownloadPlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private fileService: FileReadService | null = null;
  private groupIdSet: Set<string> = new Set();
  private deduplicateTimer: ReturnType<typeof setInterval> | undefined;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (!container.isRegistered(DITokens.MESSAGE_API)) {
      logger.warn('[GroupDownloadPlugin] MESSAGE_API not registered; plugin will not download resources.');
      return;
    }
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    // Resolve FileReadService for scheduled dedup (optional)
    if (container.isRegistered(DITokens.FILE_READ_SERVICE)) {
      this.fileService = container.resolve<FileReadService>(DITokens.FILE_READ_SERVICE);
    }

    try {
      const pluginConfig = this.pluginConfig?.config as GroupDownloadPluginConfig | undefined;
      if (pluginConfig?.groupIds && Array.isArray(pluginConfig.groupIds)) {
        this.groupIdSet = new Set(pluginConfig.groupIds.map((id) => String(id)));
        logger.info(`[GroupDownloadPlugin] Monitoring ${this.groupIdSet.size} group(s) for downloads.`);
      } else {
        logger.info('[GroupDownloadPlugin] No groupIds configured; plugin enabled but will not download.');
      }

      // Start scheduled dedup if configured
      const intervalMs = pluginConfig?.deduplicateIntervalMs ?? 0;
      if (intervalMs > 0 && this.fileService) {
        this.deduplicateTimer = setInterval(() => {
          void this.runScheduledDedup();
        }, intervalMs);
        logger.info(`[GroupDownloadPlugin] Scheduled dedup enabled: every ${Math.round(intervalMs / 60000)} min.`);
      }
    } catch (error) {
      logger.error('[GroupDownloadPlugin] Config error:', error);
    }
  }

  async onDisable(): Promise<void> {
    if (this.deduplicateTimer !== undefined) {
      clearInterval(this.deduplicateTimer);
      this.deduplicateTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduled dedup
  // ---------------------------------------------------------------------------

  private async runScheduledDedup(): Promise<void> {
    if (!this.fileService || this.groupIdSet.size === 0) {
      return;
    }

    const dirs = [...this.groupIdSet].map((id) => join(DOWNLOAD_ROOT, id));

    try {
      await runDeduplication(dirs, this.fileService, false);
    } catch (err) {
      logger.error('[GroupDownloadPlugin] Scheduled dedup failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling & download (runs at COMPLETE stage so it always executes)
  // ---------------------------------------------------------------------------

  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 0,
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  onMessageComplete(context: HookContext): boolean {
    this.handleMessage(context.message);
    return true;
  }

  private async handleMessage(event: NormalizedMessageEvent): Promise<void> {
    if (!this.enabled || this.groupIdSet.size === 0) {
      return;
    }
    if (event.messageType !== 'group' || event.groupId == null) {
      return;
    }
    const groupIdStr = String(event.groupId);
    if (!this.groupIdSet.has(groupIdStr)) {
      return;
    }

    const segments = event.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return;
    }

    const saveDir = join(DOWNLOAD_ROOT, groupIdStr);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segType = segment?.type;
      const data = segment?.data as Record<string, unknown> | undefined;

      // image: unique short name, no dedup; extension from URL
      switch (segType) {
        case 'image':
          await this.downloadSegment(event, data, saveDir, 'image', false);
          break;
        case 'market_face':
          // 表情/贴纸: deterministic name + dedup; extension from URL
          await this.downloadSegment(event, data, saveDir, 'sticker', false);
          break;
        case 'file':
          await this.downloadSegment(event, data, saveDir, 'file', true);
          break;
        case 'video':
          await this.downloadSegment(event, data, saveDir, 'video', false);
          break;
      }
    }
  }

  /**
   * Resolve download URL for a segment (image/file/video/sticker/market_face).
   * Prefers temp_url / uri.
   * For file segments: Milky does not put temp_url on file elements; group attachments must use
   * get_group_file_download_url (file_id + group_id), not get_resource_temp_url.
   * Falls back to getResourceTempUrl for image/video/resource_id-style IDs.
   */
  private async resolveUrl(
    event: NormalizedMessageEvent,
    data: Record<string, unknown> | undefined,
    isFile: boolean,
  ): Promise<string | null> {
    const url = getDataValue(data, 'temp_url', 'uri', 'url');
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return url;
    }

    if (isFile && this.messageAPI) {
      const fileId = getDataValue(data, 'file_id');
      if (fileId) {
        if (event.messageType === 'group' && event.groupId != null) {
          const groupUrl = await this.messageAPI.getGroupFileDownloadUrl(fileId, event);
          if (groupUrl) {
            return groupUrl;
          }
        }
        if (event.messageType === 'private') {
          const fileHash = getDataValue(data, 'file_hash');
          if (fileHash) {
            const privateUrl = await this.messageAPI.getPrivateFileDownloadUrl(fileId, fileHash, event);
            if (privateUrl) {
              return privateUrl;
            }
          }
        }
      }
    }

    const resourceId =
      getDataValue(data, 'resource_id') ??
      getDataValue(data, 'image_id') ??
      (isFile ? getDataValue(data, 'file_id') : undefined);
    if (resourceId && this.messageAPI) {
      try {
        const resolved = await this.messageAPI.getResourceTempUrl(resourceId, event);
        if (resolved) {
          return resolved;
        }
      } catch (err) {
        logger.debug(
          `[GroupDownloadPlugin] getResourceTempUrl failed for ${isFile ? 'file' : 'resource'} | error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  /**
   * Build deterministic filename for sticker dedup only. Extension from URL, fallback to .gif.
   */
  private getStickerDedupFilename(data: Record<string, unknown> | undefined, url: string): string {
    const ext = getExtensionFromUrl(url) || getDefaultExtension('sticker');
    const dotExt = ext.startsWith('.') ? ext : `.${ext}`;
    const resourceId = getDataValue(data, 'resource_id') ?? getDataValue(data, 'image_id');
    const id = resourceId ?? url;
    return `sticker_${hashForFilename(id)}${dotExt}`;
  }

  private async downloadSegment(
    event: NormalizedMessageEvent,
    data: Record<string, unknown> | undefined,
    saveDir: string,
    kind: 'image' | 'file' | 'video' | 'sticker',
    isFile: boolean,
  ): Promise<void> {
    const url = await this.resolveUrl(event, data, isFile);
    if (!url) {
      return;
    }

    // Respect source file extension: from URL path or from file_name (file segment)
    let filename: string;
    if (kind === 'sticker') {
      filename = this.getStickerDedupFilename(data, url);
      const filePath = join(saveDir, filename);
      if (existsSync(filePath)) {
        return;
      }
    } else if (isFile) {
      const name = getDataValue(data, 'file_name', 'file_name');
      const safeName = name ? name.replace(/[^\w.-]/g, '_') || 'file' : '';
      filename = safeName
        ? `${uniqueFilename('f', '')}_${safeName}`
        : uniqueFilename('file', getExtensionFromUrl(url) || getDefaultExtension('file'));
    } else {
      const ext = getExtensionFromUrl(url) || getDefaultExtension(kind);
      filename = uniqueFilename(kind, ext);
    }

    try {
      await ResourceDownloader.downloadToBase64(url, {
        savePath: saveDir,
        filename,
        timeout: 60000,
        maxSize: 0,
      });
    } catch (err) {
      logger.warn(
        `[GroupDownloadPlugin] Failed to download ${kind} | url=${url.slice(0, 60)}... | error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
