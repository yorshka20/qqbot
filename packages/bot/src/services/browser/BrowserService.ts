// BrowserService — singleton Puppeteer browser lifecycle manager.
// Provides shared Chrome/Chromium access for card rendering, page scraping, etc.

import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { logger } from '@/utils/logger';

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
 * Singleton browser service that manages a shared Puppeteer browser instance.
 * All consumers (card rendering, page scraping, etc.) get pages from here.
 */
export class BrowserService {
  private static instance: BrowserService | null = null;
  private browser: Browser | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  /**
   * Create a new browser page (ensures browser is initialized).
   * Applies stealth patches to evade common automation detection.
   * Caller is responsible for closing the page when done.
   */
  async createPage(): Promise<Page> {
    await this.init();
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    const page = await this.browser.newPage();

    // Stealth: override navigator.webdriver and other automation signals
    await page.evaluateOnNewDocument(() => {
      // Hide webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Fake plugins (headless Chrome has none)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5] as unknown as PluginArray,
      });

      // Fake languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      });

      // Remove automation-related properties from window
      // @ts-expect-error
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      // @ts-expect-error
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      // @ts-expect-error
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

      // Override chrome.runtime to appear as a normal Chrome extension env
      // @ts-expect-error
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };

      // Override permissions query to report 'prompt' for notifications
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
    });

    // Set a realistic user-agent
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );

    return page;
  }

  /** Close browser instance. */
  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        logger.info('[BrowserService] Browser closed');
      } catch (error) {
        logger.warn('[BrowserService] Error closing browser:', error);
      } finally {
        this.browser = null;
        this.isInitializing = false;
        this.initPromise = null;
      }
    }
  }

  /** Cleanup singleton instance (for testing). */
  static async cleanup(): Promise<void> {
    if (BrowserService.instance) {
      await BrowserService.instance.close();
      BrowserService.instance = null;
    }
  }

  // ──────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────

  private async init(): Promise<void> {
    if (this.browser) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        const platform = process.platform;
        logger.info(`[BrowserService] Initializing Puppeteer browser on ${platform}...`);

        const launchArgs = this.getLaunchArgs();
        const executablePath = this.getExecutablePath();
        logger.info(`[BrowserService] Using browser: ${executablePath}`);
        logger.debug(`[BrowserService] Launch args: ${launchArgs.join(' ')}`);

        this.browser = await puppeteer.launch({
          headless: 'new',
          args: launchArgs,
          executablePath,
        });

        logger.info('[BrowserService] Browser initialized successfully');
      } catch (error) {
        this.isInitializing = false;
        this.initPromise = null;
        const err = error instanceof Error ? error : new Error('Unknown error');
        logger.error('[BrowserService] Failed to initialize browser:', {
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
   * Resolve Chrome/Chromium executable path.
   * Uses PUPPETEER_EXECUTABLE_PATH env var, or platform default paths.
   */
  private getExecutablePath(): string {
    const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (fromEnv && fromEnv.length > 0) return fromEnv;

    if (process.platform === 'darwin' && existsSync(MACOS_CHROME_PATH)) return MACOS_CHROME_PATH;

    if (process.platform === 'linux') {
      const found = LINUX_BROWSER_PATHS.find((p) => existsSync(p));
      if (found) return found;
    }

    throw new Error(
      'Browser service requires Chrome/Chromium. Set PUPPETEER_EXECUTABLE_PATH, or install Google Chrome.',
    );
  }

  /** Platform-specific Puppeteer launch arguments. */
  private getLaunchArgs(): string[] {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-web-security',
      // Anti-detection: hide headless Chrome fingerprint
      '--disable-blink-features=AutomationControlled',
    ];

    if (process.platform === 'linux') {
      args.push('--no-zygote', '--single-process');
    }
    if (process.platform === 'darwin') {
      args.push('--disable-gpu-sandbox', '--disable-gpu');
    }

    return args;
  }
}
