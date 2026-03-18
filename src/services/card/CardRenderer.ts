// Card renderer using puppeteer-core + system Chrome/Chromium (no bundled browser)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { logger } from '@/utils/logger';
import { getCardStyles, getProviderTheme } from './cardStyles';
import { renderCardDeck } from './cardTemplates';
import type { CardData } from './cardTypes';

/** Pre-load twemoji JS from local libs/ so it never depends on a CDN at render time. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const TWEMOJI_JS = readFileSync(resolve(__dirname, 'libs/twemoji.min.js'), 'utf-8');

/** Default path to Google Chrome on macOS. */
const MACOS_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Common Chrome/Chromium paths on Linux (first existing wins). */
const LINUX_BROWSER_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * Card renderer that converts card data to PNG images
 */
export class CardRenderer {
  private static instance: CardRenderer | null = null;
  private browser: Browser | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

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
   * Resolve Chrome/Chromium executable path (required for puppeteer-core; no bundled browser).
   * Uses PUPPETEER_EXECUTABLE_PATH, or platform default paths.
   */
  private getExecutablePath(): string {
    const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv;
    }
    if (process.platform === 'darwin' && existsSync(MACOS_CHROME_PATH)) {
      return MACOS_CHROME_PATH;
    }
    if (process.platform === 'linux') {
      const found = LINUX_BROWSER_PATHS.find((p) => existsSync(p));
      if (found) return found;
    }
    throw new Error(
      'Card rendering requires a browser. Set PUPPETEER_EXECUTABLE_PATH to Chrome/Chromium path, or install Google Chrome (macOS: /Applications/Google Chrome.app).',
    );
  }

  /**
   * Get Puppeteer launch arguments based on platform
   * macOS doesn't support --single-process and --no-zygote flags
   */
  private getLaunchArgs(): string[] {
    const platform = process.platform;
    const baseArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-web-security',
    ];

    // --single-process and --no-zygote are Linux-specific and cause issues on macOS
    if (platform === 'linux') {
      baseArgs.push('--no-zygote', '--single-process');
    }

    // macOS: reduce GPU/sandbox issues that cause "UniversalExceptionRaise" / crash info version 7
    if (platform === 'darwin') {
      baseArgs.push('--disable-gpu-sandbox', '--disable-gpu');
    }

    return baseArgs;
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
        const platform = process.platform;
        logger.info(`[CardRenderer] Initializing Puppeteer browser on ${platform}...`);

        const launchArgs = this.getLaunchArgs();
        const executablePath = this.getExecutablePath();
        logger.info(`[CardRenderer] Using browser: ${executablePath}`);
        logger.debug(`[CardRenderer] Launch args: ${launchArgs.join(' ')}`);

        this.browser = await puppeteer.launch({
          headless: 'new',
          args: launchArgs,
          executablePath,
        });

        logger.info('[CardRenderer] Browser initialized successfully');
      } catch (error) {
        this.isInitializing = false;
        this.initPromise = null;
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error('[CardRenderer] Failed to initialize browser:', {
          error: err.message,
          stack: err.stack,
          platform: process.platform,
          arch: process.arch,
        });
        throw err;
      }
      this.isInitializing = false;
    })();

    return this.initPromise;
  }

  /**
   * Render card(s) to PNG image buffer.
   * Accepts single card or array of cards (deck); multiple cards are laid out in order.
   * @param cardData - Single card or array of cards to render
   * @param options - Provider name (e.g. doubao, claude, deepseek) shown after "AI Assistant" in footer; required on all paths
   */
  async render(cardData: CardData | CardData[], options: { provider: string }): Promise<Buffer> {
    await this.init();

    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const cards = Array.isArray(cardData) ? cardData : [cardData];
    const cardHTML = renderCardDeck(cards);

    let page: Page | null = null;

    try {
      page = await this.browser.newPage();

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
