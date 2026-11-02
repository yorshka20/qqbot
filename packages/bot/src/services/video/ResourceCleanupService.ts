// ResourceCleanupService - tracks session-scoped local and remote resources and deletes them on cleanup.
//
// Usage:
//   1. register(sessionId, filePath)      - associate a local file with a session
//   2. registerRemoteFile(sessionId, name, deleteFile) - associate a remote (e.g. Gemini File API) file with a session
//   3. cleanup(sessionId, deleteRemoteFile?) - delete all tracked resources for that session
//
// Both success and error paths in the caller must call cleanup() so no temp files are leaked.

import { unlink } from 'node:fs/promises';
import { logger } from '@qqbot/shared';
import { singleton } from 'tsyringe';

interface RemoteFileResource {
  fileName: string;
  deleteFile: (fileName: string) => Promise<void>;
}

interface SessionResources {
  localFiles: string[];
  remoteFiles: RemoteFileResource[];
}

@singleton()
export class ResourceCleanupService {
  /** Maps sessionId → files to delete on cleanup. */
  private readonly sessions = new Map<string, SessionResources>();

  /**
   * Register a local file under the given session.
   * Calling this multiple times with the same session accumulates file names.
   */
  registerLocalFile(sessionId: string, filePath: string): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.localFiles.push(filePath);
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered local file | session=${sessionId} | file=${filePath}`);
  }

  /**
   * Register a remote file under the given session, with the call that deletes it.
   * Calling this multiple times with the same session accumulates file names.
   */
  registerRemoteFile(sessionId: string, fileName: string, deleteFile: (fileName: string) => Promise<void>): void {
    const resources = this.sessions.get(sessionId) ?? { localFiles: [], remoteFiles: [] };
    resources.remoteFiles.push({ fileName, deleteFile });
    this.sessions.set(sessionId, resources);
    logger.debug(`[ResourceCleanupService] Registered remote file | session=${sessionId} | file=${fileName}`);
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
        await unlink(filePath);
        logger.debug(`[ResourceCleanupService] Deleted | session=${sessionId} | path=${filePath}`);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to delete | session=${sessionId} | path=${filePath}`);
      }
    }

    for (const fileResource of resources.remoteFiles) {
      try {
        await fileResource.deleteFile(fileResource.fileName);
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
