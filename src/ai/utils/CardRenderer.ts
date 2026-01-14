// Card renderer using Puppeteer to convert HTML cards to images

import { logger } from '@/utils/logger';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { cardStyles } from './cardStyles';
import { renderCard } from './cardTemplates';
import type { CardData } from './cardTypes';

/**
 * Card renderer that converts card data to PNG images
 */
export class CardRenderer {
  private static instance: CardRenderer | null = null;
  private browser: Browser | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CardRenderer {
    if (!CardRenderer.instance) {
      CardRenderer.instance = new CardRenderer();
    }
    return CardRenderer.instance;
  }

  /**
   * Initialize browser instance
   */
  private async init(): Promise<void> {
    if (this.browser) {
      return;
    }

    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        logger.info('[CardRenderer] Initializing Puppeteer browser...');
        this.browser = await puppeteer.launch({
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-web-security',
          ],
        });
        logger.info('[CardRenderer] Browser initialized successfully');
      } catch (error) {
        this.isInitializing = false;
        this.initPromise = null;
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error('[CardRenderer] Failed to initialize browser:', err);
        throw err;
      }
      this.isInitializing = false;
    })();

    return this.initPromise;
  }

  /**
   * Render card data to PNG image buffer
   */
  async render(cardData: CardData): Promise<Buffer> {
    await this.init();

    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    let page: Page | null = null;

    try {
      page = await this.browser.newPage();

      // Render card HTML
      const cardHTML = renderCard(cardData);

      // Build full HTML document
      const fullHTML = `
        <!DOCTYPE html>
        <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://unpkg.com/twemoji@latest/dist/twemoji.min.js" crossorigin="anonymous"></script>
            <style>${cardStyles}</style>
          </head>
          <body>
            <div class="container">
              ${cardHTML}
              <div class="footer">🤖 AI Assistant</div>
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

      // Set content and wait for rendering
      await page.setContent(fullHTML, {
        waitUntil: 'networkidle0',
      });

      // wait for twemoji to be parsed
      await Promise.race([
        page.waitForFunction(
          () => {
            // @ts-expect-error - document is available in browser context
            const hasTwemoji = typeof (window as any).twemoji !== 'undefined';
            return !hasTwemoji;
          },
          { timeout: 3000 },
        ),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => {
        logger.warn('[CardRenderer] Twemoji parsing timeout, continuing...');
      });

      // Wait for fonts and images to load
      await page.evaluateHandle(() => {
        // @ts-expect-error - document is available in browser context
        return document.fonts.ready;
      });

      // Wait a bit for layout to settle
      await new Promise((r) => setTimeout(r, 500));

      // Calculate content bounds to crop to actual content
      const bounds = await page.evaluate(() => {
        // @ts-expect-error - document is available in browser context
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
      const screenshot = await page.screenshot({
        type: 'png',
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

  /**
   * Close browser instance
   */
  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        logger.info('[CardRenderer] Browser closed');
      } catch (error) {
        logger.warn('[CardRenderer] Error closing browser:', error);
      } finally {
        this.browser = null;
        this.isInitializing = false;
        this.initPromise = null;
      }
    }
  }

  /**
   * Cleanup singleton instance (for testing)
   */
  static async cleanup(): Promise<void> {
    if (CardRenderer.instance) {
      await CardRenderer.instance.close();
      CardRenderer.instance = null;
    }
  }
}
