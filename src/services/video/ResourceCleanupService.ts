// ResourceCleanupService - tracks session-scoped file paths and deletes them on cleanup.
//
// Usage:
//   1. register(sessionId, filePath) — associate a local file with a session
//   2. cleanup(sessionId)            — delete all files registered for that session
//
// Both success and error paths in the caller must call cleanup() so no temp files are leaked.

import { unlink } from 'node:fs/promises';
import { injectable, singleton } from 'tsyringe';
import { logger } from '@/utils/logger';

@injectable()
@singleton()
export class ResourceCleanupService {
  /** Maps sessionId → list of absolute file paths to delete on cleanup. */
  private readonly sessions = new Map<string, string[]>();

  /**
   * Register a file path under the given session.
   * Calling this multiple times with the same session accumulates paths.
   */
  register(sessionId: string, filePath: string): void {
    const files = this.sessions.get(sessionId) ?? [];
    files.push(filePath);
    this.sessions.set(sessionId, files);
    logger.debug(`[ResourceCleanupService] Registered | session=${sessionId} | path=${filePath}`);
  }

  /**
   * Delete all files registered under sessionId, then remove the session entry.
   * Individual deletion failures are logged as warnings (best-effort).
   */
  async cleanup(sessionId: string): Promise<void> {
    const files = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    if (!files || files.length === 0) {
      return;
    }

    for (const filePath of files) {
      try {
        await unlink(filePath);
        logger.debug(`[ResourceCleanupService] Deleted | session=${sessionId} | path=${filePath}`);
      } catch {
        logger.warn(`[ResourceCleanupService] Failed to delete | session=${sessionId} | path=${filePath}`);
      }
    }
  }
}
