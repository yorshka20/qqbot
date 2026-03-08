// GroupDownload Plugin - automatically downloads images, files, and videos from configured groups to local disk

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Output directory root; files are saved under output/downloads/{groupid} */
const DOWNLOAD_ROOT = 'output/downloads';

export interface GroupDownloadPluginConfig {
  /**
   * List of group IDs to monitor. Messages from these groups will have their
   * images, files, and videos downloaded to output/downloads/{groupid}
   */
  groupIds?: string[];
}

/**
 * Get a value from segment data supporting both camelCase and snake_case keys.
 */
function getDataValue(data: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' && v) {
      return v;
    }
  }
  return undefined;
}

/**
 * Sanitize string for use as filename (remove path and invalid chars).
 */
function sanitizeForFilename(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 200) || 'file';
}

/**
 * Generate a short hash from string (for deterministic filename when no resource_id).
 */
function hashForFilename(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 16);
}

@RegisterPlugin({
  name: 'groupDownload',
  version: '1.0.0',
  description:
    'Downloads images, stickers/表情, files, and videos from configured groups to output/downloads/{groupid}',
})
export class GroupDownloadPlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private groupIdSet: Set<string> = new Set();

  async onInit(): Promise<void> {
    if (!getContainer().isRegistered(DITokens.MESSAGE_API)) {
      logger.warn('[GroupDownloadPlugin] MESSAGE_API not registered; plugin will not download resources.');
      return;
    }
    this.messageAPI = getContainer().resolve<MessageAPI>(DITokens.MESSAGE_API);

    try {
      const pluginConfig = this.pluginConfig?.config as GroupDownloadPluginConfig | undefined;
      if (pluginConfig?.groupIds && Array.isArray(pluginConfig.groupIds)) {
        this.groupIdSet = new Set(pluginConfig.groupIds.map((id) => String(id)));
        logger.info(`[GroupDownloadPlugin] Monitoring ${this.groupIdSet.size} group(s) for downloads.`);
      } else {
        logger.info('[GroupDownloadPlugin] No groupIds configured; plugin enabled but will not download.');
      }
    } catch (error) {
      logger.error('[GroupDownloadPlugin] Config error:', error);
    }

    this.on('message', this.handleMessage.bind(this));
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

      // image: includes normal images and stickers/表情 (e.g. 动画表情; may have sub_type 'sticker' or summary like "[动画表情]")
      if (segType === 'image') {
        await this.downloadSegment(event, data, saveDir, 'image', i, ['.jpg', '.png', '.gif', '.webp'], false, true);
      } else if (segType === 'market_face') {
        // 表情/贴纸 may also be sent as market_face segment (same resource/URL fields as image)
        await this.downloadSegment(event, data, saveDir, 'sticker', i, ['.gif', '.png', '.webp'], false, true);
      } else if (segType === 'file') {
        await this.downloadSegment(event, data, saveDir, 'file', i, [], true, false);
      } else if (segType === 'video') {
        await this.downloadSegment(event, data, saveDir, 'video', i, ['.mp4', '.webm', '.mov'], false, false);
      }
    }
  }

  /**
   * Resolve download URL for a segment (image/file/video/sticker/market_face).
   * Prefers temp_url / uri; falls back to getResourceTempUrl(resource_id or file_id) for Milky.
   * For image/sticker, also tries image_id in case protocol uses it for 表情.
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
   * Build deterministic filename for dedup: same resource_id / file_name / URL → same filename so we can skip if exists.
   */
  private getDeterministicFilename(
    data: Record<string, unknown> | undefined,
    url: string,
    kind: 'image' | 'file' | 'video' | 'sticker',
    defaultExts: string[],
    isFile: boolean,
    isImageOrSticker: boolean,
  ): string {
    const ext = defaultExts[0] ?? (isFile ? '.bin' : '.png');
    const dotExt = ext.startsWith('.') ? ext : `.${ext}`;

    if (isFile) {
      const name = getDataValue(data, 'file_name', 'file_name');
      if (name) {
        const safeName = name.replace(/[^\w.\-]/g, '_') || 'file';
        return safeName;
      }
    }

    const resourceId =
      getDataValue(data, 'resource_id') ??
      getDataValue(data, 'image_id') ??
      (isFile ? getDataValue(data, 'file_id') : undefined);
    if (resourceId) {
      const prefix =
        isImageOrSticker &&
        (getDataValue(data, 'sub_type', 'sub_type') === 'sticker' ||
          /表情|贴纸|sticker/i.test(getDataValue(data, 'summary', 'summary') ?? ''))
          ? 'sticker'
          : kind;
      return `${prefix}_${sanitizeForFilename(resourceId)}${dotExt}`;
    }

    return `${kind}_${hashForFilename(url)}${dotExt}`;
  }

  private async downloadSegment(
    event: NormalizedMessageEvent,
    data: Record<string, unknown> | undefined,
    saveDir: string,
    kind: 'image' | 'file' | 'video' | 'sticker',
    index: number,
    defaultExts: string[],
    isFile = false,
    isImageOrSticker = false,
  ): Promise<void> {
    const url = await this.resolveUrl(event, data, isFile);
    if (!url) {
      logger.debug(`[GroupDownloadPlugin] No download URL for ${kind} segment index=${index}`);
      return;
    }

    const filename = this.getDeterministicFilename(
      data,
      url,
      kind,
      defaultExts,
      isFile,
      isImageOrSticker,
    );
    const filePath = join(saveDir, filename);
    if (existsSync(filePath)) {
      logger.debug(`[GroupDownloadPlugin] Skip duplicate (already exists): ${filename}`);
      return;
    }

    try {
      await ResourceDownloader.downloadToBase64(url, {
        savePath: saveDir,
        filename,
        timeout: 60000,
        maxSize: 0,
      });
      logger.info(`[GroupDownloadPlugin] Saved ${kind} to ${saveDir}/${filename}`);
    } catch (err) {
      logger.warn(
        `[GroupDownloadPlugin] Failed to download ${kind} | url=${url.slice(0, 60)}... | error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
