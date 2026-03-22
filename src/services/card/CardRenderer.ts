// Card renderer — converts card data to PNG images.
// Delegates browser lifecycle to BrowserService.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { BrowserService } from '@/services/browser/BrowserService';
import { logger } from '@/utils/logger';
import { getCardStyles, getProviderTheme } from './cardStyles';
import { renderCardDeck } from './cardTemplates';
import type { CardData } from './cardTypes';

/** Pre-load twemoji JS from local libs/ so it never depends on a CDN at render time. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const TWEMOJI_JS = readFileSync(resolve(__dirname, 'libs/twemoji.min.js'), 'utf-8');

/**
 * Card renderer that converts card data to PNG images.
 * Uses BrowserService for browser access.
 */
export class CardRenderer {
  private static instance: CardRenderer | null = null;

  static getInstance(): CardRenderer {
    if (!CardRenderer.instance) {
      CardRenderer.instance = new CardRenderer();
    }
    return CardRenderer.instance;
  }

  /**
   * Render card(s) to PNG image buffer.
   * Accepts single card or array of cards (deck); multiple cards are laid out in order.
   * @param cardData - Single card or array of cards to render
   * @param options - Provider name (e.g. doubao, claude, deepseek) shown after "AI Assistant" in footer; required on all paths
   */
  async render(cardData: CardData | CardData[], options: { provider: string }): Promise<Buffer> {
    const cards = Array.isArray(cardData) ? cardData : [cardData];
    const cardHTML = renderCardDeck(cards);

    let page: Page | null = null;

    try {
      page = await BrowserService.getInstance().createPage();

      // Footer: use proper display name (e.g. "DeepSeek" not "deepseek")
      const theme = getProviderTheme(options.provider);
      const footerText = `🤖 AI Assistant · ${theme.displayName}`;

      // Build full HTML document (twemoji JS is inlined from local libs/ to avoid CDN timeouts)
      const fullHTML = `
        <!DOCTYPE html>
        <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script>${TWEMOJI_JS}</script>
            <style>${getCardStyles(theme)}</style>
          </head>
          <body>
            <div class="container" data-provider="${theme.displayName}">
              ${cardHTML}
              <div class="footer">${footerText}</div>
            </div>
          </body>
        </html>
      `;

      // Set viewport size (large enough to accommodate content)
      await page.setViewport({
        width: 1000,
        height: 2000,
        deviceScaleFactor: 2, // Higher DPI for better quality
      });

      // Set content — domcontentloaded is enough since the JS is inlined
      await page.setContent(fullHTML, {
        waitUntil: 'domcontentloaded',
      });

      // Parse emojis via twemoji (JS is local; SVG images are best-effort from CDN)
      await page.evaluate(() => {
        if (typeof (window as any).twemoji !== 'undefined') {
          (window as any).twemoji.parse(document.body, {
            folder: 'svg',
            ext: '.svg',
          });
        }
      });

      // Wait for fonts to be ready
      await page.evaluate(() => {
        return document.fonts.ready;
      });

      // Wait a bit for layout to settle
      await new Promise((r) => setTimeout(r, 500));

      // Calculate content bounds to crop to actual content
      const bounds = await page.evaluate(() => {
        const container = document.querySelector('.container');
        if (!container) {
          return null;
        }
        const rect = container.getBoundingClientRect();
        // Add small padding to ensure we capture rounded corners
        return {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });

      if (!bounds) {
        throw new Error('Failed to calculate content bounds');
      }

      logger.debug(
        `[CardRenderer] Content bounds: x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}`,
      );

      // Take screenshot with clipping to content area
      // Use JPEG with quality 85 to reduce file size (PNG can be several MB for tall cards,
      // causing LLBot→QQ upload timeouts)
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 85,
        clip: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        omitBackground: false,
      });

      return screenshot as Buffer;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[CardRenderer] Failed to render card:', err);
      throw err;
    } finally {
      if (page) {
        await page.close().catch((error) => {
          logger.warn('[CardRenderer] Failed to close page:', error);
        });
      }
    }
  }

  /** Cleanup singleton instance (for testing). */
  static async cleanup(): Promise<void> {
    CardRenderer.instance = null;
    await BrowserService.cleanup();
  }
}
