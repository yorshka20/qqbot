// CloudflareWorkerPlugin
// Proxies Doubao (Volcengine Ark) API requests through a Cloudflare Worker
// to route traffic from overseas servers to China-domestic endpoints.

import type { AIManager } from '@/ai/AIManager';
import { HttpClient } from '@/api/http/HttpClient';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HealthCheckManager } from '@/core/health';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { logger } from '@/utils/logger';

interface CloudflareWorkerPluginConfig {
  /** Cloudflare Worker URL, e.g. "https://volcengine-proxy.your-name.workers.dev" */
  workerUrl: string;
  /** Optional X-Proxy-Secret for worker authentication */
  proxySecret?: string;
  /** Provider name to proxy (default: "doubao") */
  targetProvider?: string;
}

@RegisterPlugin({
  name: 'cloudflare-worker-proxy',
  version: '1.0.0',
  description: 'Proxy Doubao/Volcengine API requests through Cloudflare Worker',
})
export class CloudflareWorkerPlugin extends PluginBase {
  private originalHttpClient: HttpClient | null = null;
  private targetProviderName = 'doubao';

  private getConfig(): CloudflareWorkerPluginConfig | null {
    const config = this.pluginConfig?.config as CloudflareWorkerPluginConfig | undefined;
    if (!config?.workerUrl) {
      logger.error('[CloudflareWorkerProxy] Missing workerUrl in plugin config');
      return null;
    }
    return config;
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    const config = this.getConfig();
    if (!config) return;

    this.targetProviderName = config.targetProvider ?? 'doubao';

    const aiManager = getContainer().resolve<AIManager>(DITokens.AI_MANAGER);
    const provider = aiManager.getProvider(this.targetProviderName);
    if (!provider) {
      logger.warn(`[CloudflareWorkerProxy] Provider "${this.targetProviderName}" not found, will not proxy`);
      return;
    }

    // Save original httpClient for restore on disable
    const providerAny = provider as any;
    this.originalHttpClient = providerAny.httpClient;

    // Build new baseURL: workerUrl + original path prefix
    // The worker preserves the path, so we just replace the origin.
    // Original baseURL is like "https://ark.cn-beijing.volces.com/api/v3"
    // Worker URL is like "https://volcengine-proxy.xxx.workers.dev"
    // New baseURL becomes "https://volcengine-proxy.xxx.workers.dev/api/v3"
    const originalBaseURL = (this.originalHttpClient as any)?.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';
    const originalUrl = new URL(originalBaseURL);
    const workerBase = config.workerUrl.replace(/\/+$/, '');
    const newBaseURL = workerBase + originalUrl.pathname;

    // Build headers: keep original auth headers, add proxy secret if configured
    const originalHeaders = (this.originalHttpClient as any)?.defaultHeaders || {};
    const newHeaders: Record<string, string> = { ...originalHeaders };
    if (config.proxySecret) {
      newHeaders['X-Proxy-Secret'] = config.proxySecret;
    }

    // Replace httpClient with one pointing to the worker
    providerAny.httpClient = new HttpClient({
      baseURL: newBaseURL,
      defaultHeaders: newHeaders,
      defaultTimeout: 60000,
      tlsPreCheck: false, // Worker handles TLS to upstream
      connectTimeout: 10000,
    });

    logger.info(`[CloudflareWorkerProxy] Proxying "${this.targetProviderName}" through ${workerBase}`);

    // Re-run health check for this provider so the cached result reflects the proxied endpoint.
    // The startup health check runs before plugins are loaded, so it uses the original httpClient.
    try {
      const healthCheckManager = getContainer().resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER);
      healthCheckManager
        .checkHealth(this.targetProviderName, { force: true })
        .then((result) => {
          logger.info(
            `[CloudflareWorkerProxy] Re-checked health for "${this.targetProviderName}" via worker: ${result.status}`,
          );
        })
        .catch((err) => {
          logger.warn(`[CloudflareWorkerProxy] Health re-check failed:`, err);
        });
    } catch {
      // HealthCheckManager may not be registered yet in some edge cases
    }
  }

  async onDisable(): Promise<void> {
    // Restore original httpClient
    if (this.originalHttpClient) {
      const aiManager = getContainer().resolve<AIManager>(DITokens.AI_MANAGER);
      const provider = aiManager.getProvider(this.targetProviderName);
      if (provider) {
        (provider as any).httpClient = this.originalHttpClient;
        logger.info(`[CloudflareWorkerProxy] Restored original httpClient for "${this.targetProviderName}"`);
      }
      this.originalHttpClient = null;
    }

    await super.onDisable();
  }
}
