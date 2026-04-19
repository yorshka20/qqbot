// ResourceCleanupService - tracks session-scoped local and remote resources and deletes them on cleanup.
//
// Usage:
//   1. register(sessionId, filePath)      - associate a local file with a session
//   2. registerRemoteFile(sessionId, name) - associate a Gemini file with a session
//   3. cleanup(sessionId, deleteRemoteFile?) - delete all tracked resources for that session
//
// Both success and error paths in the caller must call cleanup() so no temp files are leaked.

import { unlink } from 'node:fs/promises';
import { injectable, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';

interface FileResource {
  fileName: string;
  providerName: string;
}

interface SessionResources {
  localFiles: FileResource[];
  remoteFiles: FileResource[];
}

@injectable()
@singleton()
export class ResourceCleanupService {
  /** Maps sessionId → files to delete on cleanup. */
  private readonly sessions = new Map<string, SessionResources>();
  /** Maps providerName → cleanup function. */
  private readonly cleanupFunctions = new Map<string, (fileName: string) => Promise<void>>();

  /**
   * Register a local file under the given session.
   * Calling this multiple times with the same session accumulates file names.
   */
  registerLocalFile(sessionId: string, filePath: string): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.localFiles.push({ fileName: filePath, providerName: 'local' });
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered local file | session=${sessionId} | file=${filePath}`);
  }

  /**
   * Register a Gemini file under the given session.
   * Calling this multiple times with the same session accumulates file names.
   */
  registerRemoteFile(sessionId: string, fileName: string, providerName: string): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.remoteFiles.push({ fileName, providerName });
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered remote file | session=${sessionId} | file=${fileName}`);
  }

  /**
   * Register a cleanup function for a provider.
   * Calling this multiple times with the same provider accumulates cleanup functions.
   */
  registerFileCleanup(providerName: string, cleanupFunction: (fileName: string) => Promise<void>): void {
    this.cleanupFunctions.set(providerName, cleanupFunction);
    logger.debug(`[ResourceCleanupService] Registered file cleanup | provider=${providerName}`);
  }

  /**
   * Delete all files registered under sessionId, then remove the session entry.
   * Individual deletion failures are logged as warnings (best-effort).
   */
  async cleanup(sessionId: string): Promise<void> {
    const resources = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (!resources) {
      return;
    }

    for (const filePath of resources.localFiles) {
      try {
        await unlink(filePath.fileName);
        logger.debug(`[ResourceCleanupService] Deleted | session=${sessionId} | path=${filePath}`);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to delete | session=${sessionId} | path=${filePath}`);
      }
    }

    for (const fileResource of resources.remoteFiles) {
      const cleanupFunction = this.cleanupFunctions.get(fileResource.providerName);
      if (!cleanupFunction) {
        logger.warn(
          `[ResourceCleanupService] No cleanup function found for provider | session=${sessionId} | provider=${fileResource.providerName}`,
        );
        continue;
      }
      try {
        await cleanupFunction(fileResource.fileName);
        logger.debug(
          `[ResourceCleanupService] Deleted remote file | session=${sessionId} | file=${fileResource.fileName}`,
        );
      } catch {
        logger.warn(
          `[ResourceCleanupService] Failed to delete remote file | session=${sessionId} | file=${fileResource.fileName}`,
        );
      }
    }
  }

  /**
   * Delete all tracked resources across every session.
   * Individual session failures are logged and ignored so cleanup stays best-effort.
   */
  async cleanupAll(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.cleanup(sessionId);
    }
  }
}
