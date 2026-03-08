/**
 * Static file server service: output directory hosting + file manager backend (API + SPA).
 */

import type { StaticServerConfig } from '@/core/config/types/bot';
import { StaticFileServer } from './StaticFileServer';

export { FileManagerBackend } from './FileManagerBackend';
export { OutputStaticHost } from './OutputStaticHost';
export { resolveSafe } from './pathSafety';
export type { StaticFileServerInstance } from './StaticFileServer';
export { StaticFileServer } from './StaticFileServer';

let serverInstance: StaticFileServer | null = null;

export async function initStaticFileServer(config: StaticServerConfig): Promise<StaticFileServer> {
  if (serverInstance) {
    return serverInstance;
  }
  serverInstance = new StaticFileServer(config);
  await serverInstance.start();
  return serverInstance;
}

export function getStaticFileServer(): StaticFileServer {
  if (!serverInstance) {
    throw new Error('Static file server not initialized. Call initStaticFileServer() first.');
  }
  return serverInstance;
}

export function stopStaticFileServer(): void {
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
  }
}
