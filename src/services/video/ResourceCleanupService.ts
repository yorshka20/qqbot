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

interface SessionResources {
  localFiles: string[];
  remoteFiles: string[];
}

@injectable()
@singleton()
export class ResourceCleanupService {
  /** Maps sessionId → files to delete on cleanup. */
  private readonly sessions = new Map<string, SessionResources>();

  /**
   * Register a file path under the given session.
   * Calling this multiple times with the same session accumulates paths.
   */
  register(sessionId: string, filePath: string): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.localFiles.push(filePath);
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered | session=${sessionId} | path=${filePath}`);
  }

  /**
   * Register a Gemini file under the given session.
   * Calling this multiple times with the same session accumulates file names.
   */
  registerRemoteFile(sessionId: string, fileName: string): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.remoteFiles.push(fileName);
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered remote file | session=${sessionId} | file=${fileName}`);
  }

  /**
   * Delete all files registered under sessionId, then remove the session entry.
   * Individual deletion failures are logged as warnings (best-effort).
   */
  async cleanup(
    sessionId: string,
    deleteRemoteFile?: (fileName: string) => Promise<void>,
  ): Promise<void> {
    const resources = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (!resources) {
      return;
    }

    for (const filePath of resources.localFiles) {
      try {
        await unlink(filePath);
        logger.debug(`[ResourceCleanupService] Deleted | session=${sessionId} | path=${filePath}`);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to delete | session=${sessionId} | path=${filePath}`);
      }
    }

    if (resources.remoteFiles.length > 0 && !deleteRemoteFile) {
      logger.warn(`[ResourceCleanupService] Skipped remote cleanup | session=${sessionId} | reason=no callback`);
      return;
    }

    for (const fileName of resources.remoteFiles) {
      if (!deleteRemoteFile) {
        continue;
      }

      try {
        await deleteRemoteFile(fileName);
        logger.debug(`[ResourceCleanupService] Deleted remote file | session=${sessionId} | file=${fileName}`);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to delete remote file | session=${sessionId} | file=${fileName}`);
      }
    }
  }

  /**
   * Delete all tracked resources across every session.
   * Individual session failures are logged and ignored so cleanup stays best-effort.
   */
  async cleanupAll(deleteRemoteFile?: (fileName: string) => Promise<void>): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        await this.cleanup(sessionId, deleteRemoteFile);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to cleanup session | session=${sessionId}`);
      }
    }
  }
}
