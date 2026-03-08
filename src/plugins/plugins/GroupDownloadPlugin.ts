// GroupDownload Plugin - automatically downloads images, files, and videos from configured groups to local disk

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { extname, join } from 'path';
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
 * Generate a short hash from string (for short deterministic filename, e.g. sticker dedup).
 */
function hashForFilename(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12);
}

/**
 * Get file extension from URL path (respect source suffix). Returns e.g. ".jpg" or "".
 */
function getExtensionFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').pop() ?? '';
    const e = extname(base);
    return e && /^\.\w+$/.test(e) ? e : '';
  } catch {
    return '';
  }
}

/**
 * Generate a short unique filename (no dedup). ext should include dot, e.g. ".jpg" or "".
 */
function uniqueFilename(prefix: string, ext: string): string {
  const ts = Date.now();
  const r = Math.random().toString(36).slice(2, 8);
  const dotExt = ext?.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return `${prefix}_${ts}_${r}${dotExt}`;
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

      // image: unique short name, no dedup; extension from URL
      if (segType === 'image') {
        await this.downloadSegment(event, data, saveDir, 'image', i, false);
      } else if (segType === 'market_face') {
        // 表情/贴纸: deterministic name + dedup; extension from URL
        await this.downloadSegment(event, data, saveDir, 'sticker', i, false);
      } else if (segType === 'file') {
        await this.downloadSegment(event, data, saveDir, 'file', i, true);
      } else if (segType === 'video') {
        await this.downloadSegment(event, data, saveDir, 'video', i, false);
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
   * Build deterministic filename for sticker dedup only. Extension from URL (respect source suffix).
   */
  private getStickerDedupFilename(data: Record<string, unknown> | undefined, url: string): string {
    const ext = getExtensionFromUrl(url) || '.bin';
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
    index: number,
    isFile: boolean,
  ): Promise<void> {
    const url = await this.resolveUrl(event, data, isFile);
    if (!url) {
      logger.debug(`[GroupDownloadPlugin] No download URL for ${kind} segment index=${index}`);
      return;
    }

    // Respect source file extension: from URL path or from file_name (file segment)
    let filename: string;
    if (kind === 'sticker') {
      filename = this.getStickerDedupFilename(data, url);
      const filePath = join(saveDir, filename);
      if (existsSync(filePath)) {
        logger.debug(`[GroupDownloadPlugin] Skip duplicate sticker (already exists): ${filename}`);
        return;
      }
    } else if (isFile) {
      const name = getDataValue(data, 'file_name', 'file_name');
      const safeName = name ? name.replace(/[^\w.-]/g, '_') || 'file' : '';
      filename = safeName
        ? `${uniqueFilename('f', '')}_${safeName}`
        : uniqueFilename('file', getExtensionFromUrl(url) || '.bin');
    } else {
      const ext = getExtensionFromUrl(url) || '.bin';
      filename = uniqueFilename(kind, ext);
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
