// Memory Service - file-based persistence for group and user memories (like prompt templates)

import { logger } from '@/utils/logger';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** User ID used for group-level memory slot (one file per group: _global_.txt). */
export const GROUP_MEMORY_USER_ID = '_global_memory_';

/** Default max length for content to avoid exceeding prompt limits. */
const DEFAULT_MAX_CONTENT_LENGTH = 100_000;

/** Default base directory for memory files (relative to cwd). Overridden by config. */
const DEFAULT_MEMORY_DIR = 'data/memory';

/** Filename for group-level memory inside a group directory. */
const GROUP_MEMORY_FILENAME = '_global_.txt';

export interface MemoryServiceOptions {
  /** Base directory for memory files (resolved with process.cwd()). Default "data/memory". */
  memoryDir?: string;
  /** Max length for memory content (truncate if exceeded). */
  maxContentLength?: number;
}

/**
 * File-backed memory: one directory per groupId, group memory in _global_.txt, user memory in {userId}.txt.
 * No in-memory cache so manual edits to files are visible on next read.
 */
export class MemoryService {
  private readonly basePath: string;
  private readonly maxContentLength: number;

  constructor(options: MemoryServiceOptions = {}) {
    const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;
    this.basePath = join(process.cwd(), memoryDir);
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Resolve file path for a memory slot. Group memory uses _global_.txt; user memory uses {userId}.txt.
   * Sanitizes groupId and userId to avoid path traversal (only alphanumeric and underscore allowed; else replaced with _).
   */
  private getFilePath(groupId: string, userId: string): string {
    const safeGroupId = this.sanitizePathSegment(groupId);
    const filename = userId === GROUP_MEMORY_USER_ID ? GROUP_MEMORY_FILENAME : `${this.sanitizePathSegment(userId)}.txt`;
    return join(this.basePath, safeGroupId, filename);
  }

  /** Allow only alphanumeric and underscore; replace other chars with _. */
  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Get group-level memory text for a group (file: {memoryDir}/{groupId}/_global_.txt).
   */
  getGroupMemoryText(groupId: string): string {
    const path = this.getFilePath(groupId, GROUP_MEMORY_USER_ID);
    try {
      const content = readFileSync(path, 'utf-8');
      return content ?? '';
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ENOENT') {
        return '';
      }
      logger.warn('[MemoryService] getGroupMemoryText read failed:', path, err);
      return '';
    }
  }

  /**
   * Get user-in-group memory text for (groupId, userId).
   */
  getUserMemoryText(groupId: string, userId: string): string {
    const path = this.getFilePath(groupId, userId);
    try {
      const content = readFileSync(path, 'utf-8');
      return content ?? '';
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
      if (code === 'ENOENT') {
        return '';
      }
      logger.warn('[MemoryService] getUserMemoryText read failed:', path, err);
      return '';
    }
  }

  /**
   * Get both group and user memory texts for reply injection.
   * Group memory is always returned; user memory only when userId is provided.
   */
  getMemoryTextForReply(groupId: string, userId?: string): { groupMemoryText: string; userMemoryText: string } {
    const groupMemoryText = this.getGroupMemoryText(groupId);
    const userMemoryText = userId ? this.getUserMemoryText(groupId, userId) : '';
    return { groupMemoryText, userMemoryText };
  }

  /**
   * Truncate content to max length.
   * todo: use llm to summarize.
   */
  private truncate(content: string): string {
    if (content.length <= this.maxContentLength) {
      return content;
    }
    return content.slice(0, this.maxContentLength);
  }

  /**
   * Upsert one memory slot by (groupId, userId). Writes to file; creates directory if needed.
   * Use GROUP_MEMORY_USER_ID for group-level memory.
   * Empty content is written as an empty file so the slot exists and can be edited manually.
   */
  async upsertMemory(groupId: string, userId: string, _isGlobalMemory: boolean, content: string): Promise<void> {
    const trimmed = this.truncate(content.trim());

    const path = this.getFilePath(groupId, userId);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, trimmed, 'utf-8');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown');
      logger.error('[MemoryService] upsertMemory failed:', path, err);
      throw err;
    }
  }
}
