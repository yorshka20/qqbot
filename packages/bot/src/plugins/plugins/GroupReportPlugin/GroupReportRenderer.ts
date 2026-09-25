// GroupReportRenderer — renders a finished group daily report as an image and posts it.

import type { Page } from 'puppeteer-core';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProtocolName } from '@/core/config/types/protocol';
import { MessageBuilder } from '@/message/MessageBuilder';
import { BrowserService } from '@/services/browser/BrowserService';
import { logger } from '@/utils/logger';
import { avatarUrl, renderReportHTML } from './renderReportHTML';
import type { GroupReportData } from './types';

/**
 * Group-report images are large base64 payloads. The QQ send API frequently
 * ack-times-out around 10–60 s even though the image actually uploaded
 * successfully, and a retry would post it twice. 180 s gives the ack plenty of room.
 */
const SEND_TIMEOUT_MS = 180_000;
const TIMEOUT_ERROR_PATTERN = /timeout|timed out/i;

export class GroupReportRenderer {
  constructor(private messageAPI: MessageAPI) {}

  /**
   * Render report data as an image and send it to the group. Swallows send-ack timeouts
   * because the image almost certainly arrived.
   */
  async renderAndSend(data: GroupReportData, groupId: string, protocol: ProtocolName): Promise<void> {
    logger.info(`[GroupReportRenderer] Rendering report for group ${groupId}`);
    const imageBuffer = await this.renderToImage(data);
    const base64 = imageBuffer.toString('base64');

    const mb = new MessageBuilder();
    mb.image({ data: base64 });
    const segments = mb.build();

    try {
      await this.messageAPI.sendGroupMessage(Number(groupId), segments, protocol, SEND_TIMEOUT_MS);
      logger.info(`[GroupReportRenderer] Report image sent to group ${groupId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Timeout on send_group_msg almost always means "image uploaded fine, ack was
      // just slow" — a retry re-renders and re-sends, producing a duplicate post.
      // Real failures (auth, format) surface promptly with non-timeout messages.
      if (!TIMEOUT_ERROR_PATTERN.test(errMsg)) {
        throw err;
      }
      logger.warn(`[GroupReportRenderer] send timed out (${errMsg}); assuming image arrived, not retrying`);
    }
  }

  /**
   * Pre-fetch avatar images and convert to base64 data URIs.
   * This avoids relying on Puppeteer's setContent to load external images from about:blank.
   */
  private async prefetchAvatars(data: GroupReportData): Promise<Map<string, string>> {
    const userIds = new Set<string>();
    for (const m of data.memberHighlights) userIds.add(m.userId);
    for (const m of data.featuredMessages) userIds.add(m.userId);

    const avatarMap = new Map<string, string>();
    const TIMEOUT = 5000;

    await Promise.allSettled(
      [...userIds].map(async (userId) => {
        try {
          const url = avatarUrl(userId);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);

          if (!response.ok) return;

          const buffer = await response.arrayBuffer();
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          const base64 = Buffer.from(buffer).toString('base64');
          avatarMap.set(userId, `data:${contentType};base64,${base64}`);
        } catch {
          // Skip failed avatars — the HTML will fall back to the external URL
        }
      }),
    );

    logger.debug(`[GroupReportRenderer] Pre-fetched ${avatarMap.size}/${userIds.size} avatars`);
    return avatarMap;
  }

  private async renderToImage(data: GroupReportData): Promise<Buffer> {
    const avatarMap = await this.prefetchAvatars(data);
    const html = renderReportHTML(data, avatarMap);
    let page: Page | null = null;

    try {
      page = await BrowserService.getInstance().createPage();

      await page.setViewport({
        width: 1000,
        height: 3000,
        deviceScaleFactor: 2,
      });

      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for avatar images to load
      await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return Promise.allSettled(
          images.map(
            (img) =>
              new Promise<void>((resolve) => {
                if (img.complete) return resolve();
                img.onload = () => resolve();
                img.onerror = () => resolve();
                setTimeout(resolve, 5000);
              }),
          ),
        );
      });

      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 500));

      const bounds = await page.evaluate(() => {
        const container = document.querySelector('.report-container');
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });

      if (!bounds) {
        throw new Error('Failed to calculate report content bounds');
      }

      logger.debug(`[GroupReportRenderer] Content bounds: ${bounds.width}x${bounds.height}`);

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 85,
        clip: bounds,
        omitBackground: false,
      });

      return screenshot as Buffer;
    } finally {
      if (page) {
        await page.close().catch((e) => {
          logger.warn('[GroupReportRenderer] Failed to close page:', e);
        });
      }
    }
  }
}
