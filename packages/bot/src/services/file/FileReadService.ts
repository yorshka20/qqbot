// File Read Service - provides safe file/directory access within project root

import {
  appendFileSync,
  closeSync,
  existsSync,
  futimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { FileReadServiceConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';

/** Max file content length before truncation (chars) */
const MAX_CONTENT_LENGTH = 15000;

export interface ListDirectoryResult {
  success: boolean;
  content: string;
  error?: string;
}

export interface ReadFileResult {
  success: boolean;
  content: string;
  error?: string;
}

/** Raw file entry for programmatic directory scanning */
export interface RawFileEntry {
  /** Absolute path to the file */
  path: string;
  /** Filename only */
  name: string;
  /** File size in bytes */
  size: number;
  /** Last-modified timestamp in ms */
  mtimeMs: number;
}

export interface ScanDirectoryResult {
  success: boolean;
  entries: RawFileEntry[];
  error?: string;
}

export interface DeleteFileResult {
  success: boolean;
  error?: string;
}

export interface WriteFileResult {
  success: boolean;
  error?: string;
}

export interface ReadFileBinaryResult {
  success: boolean;
  data?: Buffer;
  error?: string;
}

/**
 * File Service
 * Provides safe file listing, reading, writing, and deletion within project root.
 * Used by ReadFileToolExecutor, DeduplicateFilesToolExecutor, and ls/cat commands.
 */
export class FileReadService {
  private readonly projectRoot: string;
  private readonly filterPaths: string[];
  private readonly filterExtensions: string[];

  constructor(config?: FileReadServiceConfig) {
    this.projectRoot = resolve(config?.root ?? process.cwd());
    this.filterPaths = config?.filterPaths ?? [];
    this.filterExtensions = config?.filterExtensions ?? [];
  }

  /**
   * Check if resolved path is within project root (no path traversal).
   * When noCheck is true, only traversal is checked; filterPaths are skipped (caller must restrict who uses noCheck).
   */
  isPathSafe(resolvedPath: string, rootPath: string = this.projectRoot, noCheck = false): boolean {
    if (noCheck) {
      return true;
    }
    const rel = relative(rootPath, resolvedPath);
    const withinRoot = (!rel || !rel.startsWith('..')) && !isAbsolute(rel);
    return withinRoot && this.filterPaths.every((filter) => !rel.includes(filter));
  }

  /**
   * Resolve and validate path. Returns null if invalid or unsafe.
   * Accepts both relative paths (from project root) and absolute paths (within project root).
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  resolvePath(userPath: string, noCheck = false): { resolved: string; error?: string } {
    const normalized = normalize(userPath).replace(/^(\.\/)+/, '');
    const resolved = noCheck && isAbsolute(normalized) ? resolve(normalized) : resolve(this.projectRoot, normalized);
    const relFromRoot = relative(this.projectRoot, resolved);

    // Check for unavailable path per filters (skip when noCheck)
    if (!noCheck && this.filterPaths.some((filter) => resolved.includes(filter))) {
      return { resolved: '', error: 'unavailable path' };
    }

    // Also filter any path components that are hidden (starts with .)
    // e.g. /foo/.bar/file.txt or .env or .gitignore
    // Skip when noCheck (privileged access)
    if (!noCheck) {
      const relParts = relFromRoot.split(/[\\/]/);
      if (relParts.some((part) => part.startsWith('.') && part.length > 1)) {
        return { resolved: '', error: 'hidden path is not allowed' };
      }
    }

    if (!this.isPathSafe(resolved, this.projectRoot, noCheck)) {
      return { resolved: '', error: '路径超出项目根目录' };
    }

    return { resolved };
  }

  /**
   * List directory contents (ls-style output)
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  listDirectory(path: string, noCheck = false): ListDirectoryResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, content: '', error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        return { success: false, content: '', error: '路径不是目录' };
      }

      const entries = readdirSync(resolved, { withFileTypes: true });
      const lines = entries
        .filter((e) => noCheck || !this.filterPaths.some((filter) => e.name.includes(filter)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      const content = lines.length > 0 ? lines.join('\n') : '(空目录)';
      return { success: true, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, content: '', error: '路径不存在' };
      }
      logger.warn('[FileReadService] listDirectory failed:', err);
      return { success: false, content: '', error: `读取目录失败: ${msg}` };
    }
  }

  /**
   * Scan a directory returning raw file entries for programmatic use.
   * Non-hidden files only; honors filterPaths unless noCheck is true (caller must restrict who uses noCheck).
   * Accepts both relative (from project root) and absolute paths within project root.
   */
  scanDirectory(dirPath: string, noCheck = false): ScanDirectoryResult {
    const { resolved, error } = this.resolvePath(dirPath, noCheck);
    if (error) {
      return { success: false, entries: [], error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        return { success: false, entries: [], error: '路径不是目录' };
      }

      const names = readdirSync(resolved);
      const entries: RawFileEntry[] = [];

      for (const name of names) {
        if (name.startsWith('.')) continue; // skip hidden files
        const full = join(resolved, name);
        try {
          const st = statSync(full);
          if (st.isFile()) {
            entries.push({ path: full, name, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {
          // skip inaccessible files
        }
      }

      return { success: true, entries };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, entries: [], error: '路径不存在' };
      }
      logger.warn('[FileReadService] scanDirectory failed:', err);
      return { success: false, entries: [], error: `扫描目录失败: ${msg}` };
    }
  }

  /**
   * Read file content only (no card render). Use for read_file task; caller may render as card if needed.
   * @param path - File path (within project root)
   * When noCheck is true, filterPaths and hidden-path checks are skipped (caller must restrict who uses noCheck).
   */
  readFile(path: string, noCheck = false): ReadFileResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, content: '', error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        return { success: false, content: '', error: '路径不是文件' };
      }

      const ext = extname(resolved).toLowerCase();
      if (this.filterExtensions.includes(ext)) {
        return { success: false, content: '', error: 'unsupported file extension' };
      }

      let content = readFileSync(resolved, 'utf-8');
      if (content.length > MAX_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n...(内容已截断)`;
      }

      return { success: true, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, content: '', error: '文件不存在' };
      }
      if (msg.includes('EISDIR')) {
        return { success: false, content: '', error: '路径是目录，请使用 ls 查看' };
      }
      logger.warn('[FileReadService] readFile failed:', err);
      return { success: false, content: '', error: `读取文件失败: ${msg}` };
    }
  }

  /**
   * Read file content as binary Buffer.
   * Suitable for hashing or binary processing. No size limit applied.
   * Accepts both relative (from project root) and absolute paths within project root.
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  readFileBinary(path: string, noCheck = false): ReadFileBinaryResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        return { success: false, error: '路径不是文件' };
      }

      const data = readFileSync(resolved);
      return { success: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, error: '文件不存在' };
      }
      logger.warn('[FileReadService] readFileBinary failed:', err);
      return { success: false, error: `读取文件失败: ${msg}` };
    }
  }

  /**
   * Write text content to a file within the project root.
   * Creates parent directories if needed.
   */
  writeFile(path: string, content: string): WriteFileResult {
    const { resolved, error } = this.resolvePath(path);
    if (error) {
      return { success: false, error };
    }

    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[FileReadService] writeFile failed:', err);
      return { success: false, error: `写入文件失败: ${msg}` };
    }
  }

  /**
   * Append text content to a file within the project root.
   * Creates parent directories and the file itself if needed.
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  appendFile(path: string, content: string, noCheck = false): WriteFileResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, error };
    }

    try {
      // Reject if target exists but is not a regular file (avoid appending to dirs/sockets/etc.)
      if (existsSync(resolved)) {
        const stat = statSync(resolved);
        if (!stat.isFile()) {
          return { success: false, error: '路径不是文件' };
        }
      }
      mkdirSync(dirname(resolved), { recursive: true });
      appendFileSync(resolved, content, 'utf-8');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[FileReadService] appendFile failed:', err);
      return { success: false, error: `追加文件失败: ${msg}` };
    }
  }

  /**
   * Touch a file: create it (empty) if missing, otherwise update its access/modification time.
   * Creates parent directories if needed.
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  touchFile(path: string, noCheck = false): WriteFileResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, error };
    }

    try {
      if (existsSync(resolved)) {
        const stat = statSync(resolved);
        if (!stat.isFile()) {
          return { success: false, error: '路径不是文件' };
        }
        const now = new Date();
        const fd = openSync(resolved, 'r');
        try {
          futimesSync(fd, now, now);
        } finally {
          closeSync(fd);
        }
      } else {
        mkdirSync(dirname(resolved), { recursive: true });
        // 'wx' flag would error if exists; we already checked existsSync above
        const fd = openSync(resolved, 'w');
        closeSync(fd);
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[FileReadService] touchFile failed:', err);
      return { success: false, error: `创建文件失败: ${msg}` };
    }
  }

  /**
   * Delete a file within the project root.
   * Accepts both relative (from project root) and absolute paths within project root.
   * When noCheck is true, filterPaths are skipped (caller must restrict who uses noCheck).
   */
  deleteFile(path: string, noCheck = false): DeleteFileResult {
    const { resolved, error } = this.resolvePath(path, noCheck);
    if (error) {
      return { success: false, error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        return { success: false, error: '路径不是文件' };
      }

      unlinkSync(resolved);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, error: '文件不存在' };
      }
      logger.warn('[FileReadService] deleteFile failed:', err);
      return { success: false, error: `删除文件失败: ${msg}` };
    }
  }
}
