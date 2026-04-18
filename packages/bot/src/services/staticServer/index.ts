/**
 * Local **StaticServer**: one HTTP port, many backends (APIs + optional file routes).
 */

import type { StaticServerConfig } from '@/core/config/types/bot';
import { StaticServer, type StaticServerInitOptions } from './StaticServer';

export { outputPublicFileUrl } from './backends/OutputStaticHost';
export type { StaticServerInitOptions, StaticServerInstance } from './StaticServer';
export { StaticServer } from './StaticServer';

let serverInstance: StaticServer | null = null;

export async function initStaticServer(
  config: StaticServerConfig,
  options?: StaticServerInitOptions,
): Promise<StaticServer> {
  if (serverInstance) {
    return serverInstance;
  }
  serverInstance = new StaticServer(config, options);
  await serverInstance.start();
  return serverInstance;
}

export function getStaticServer(): StaticServer {
  if (!serverInstance) {
    throw new Error('StaticServer not initialized. Call initStaticServer() first.');
  }
  return serverInstance;
}

export function stopStaticServer(): void {
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
  }
}
