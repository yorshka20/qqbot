// File Read Service - provides safe file/directory access within project root

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { CardRenderer } from '@/ai/utils/CardRenderer';
import type { InfoCardData } from '@/ai/utils/cardTypes';
import type { FileReadServiceConfig } from '@/core/config/types/bot';
import { logger } from '@/utils/logger';

/** Max file content length before truncation (chars) */
const MAX_CONTENT_LENGTH = 15000;

export interface ListDirectoryResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface ReadFileAsImageResult {
  success: boolean;
  imageBase64?: string;
  error?: string;
}

/**
 * File Read Service
 * Provides safe file listing and reading within project root.
 * Used by ReadFileTaskExecutor and ls/cat commands.
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
   * Check if resolved path is within project root (no path traversal)
   */
  isPathSafe(resolvedPath: string, rootPath: string = this.projectRoot): boolean {
    const rel = relative(rootPath, resolvedPath);
    return (
      (!rel || !rel.startsWith('..')) && !isAbsolute(rel) && this.filterPaths.every((filter) => !rel.includes(filter))
    );
  }

  /**
   * Resolve and validate path. Returns null if invalid or unsafe.
   */
  resolvePath(userPath: string): { resolved: string; error?: string } {
    const normalized = normalize(userPath).replace(/^(\.\/)+/, '');
    const resolved = resolve(this.projectRoot, normalized);

    // Check for unavailable path per filters
    if (this.filterPaths.some((filter) => resolved.includes(filter))) {
      return { resolved: '', error: 'unavailable path' };
    }

    // Also filter any path components that are hidden (starts with .)
    // e.g. /foo/.bar/file.txt or .env or .gitignore
    const relFromRoot = relative(this.projectRoot, resolved);
    const relParts = relFromRoot.split(/[\\/]/);
    if (relParts.some((part) => part.startsWith('.') && part.length > 1)) {
      return { resolved: '', error: 'hidden path is not allowed' };
    }

    if (!this.isPathSafe(resolved)) {
      return { resolved: '', error: '路径超出项目根目录' };
    }

    return { resolved };
  }

  /**
   * List directory contents (ls-style output)
   */
  listDirectory(path: string): ListDirectoryResult {
    const { resolved, error } = this.resolvePath(path);
    if (error) {
      return { success: false, error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isDirectory()) {
        return { success: false, error: '路径不是目录' };
      }

      const entries = readdirSync(resolved, { withFileTypes: true });
      const lines = entries
        .filter((e) => !this.filterPaths.some((filter) => e.name.includes(filter)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      const content = lines.length > 0 ? lines.join('\n') : '(空目录)';
      return { success: true, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, error: '路径不存在' };
      }
      logger.warn('[FileReadService] listDirectory failed:', err);
      return { success: false, error: `读取目录失败: ${msg}` };
    }
  }

  /**
   * Read file content and render as card image
   * @param path - File path (within project root)
   * @param providerName - Provider name for card footer; when omitted, uses "system"
   */
  async readFileAsImage(path: string, providerName?: string): Promise<ReadFileAsImageResult> {
    const { resolved, error } = this.resolvePath(path);
    if (error) {
      return { success: false, error };
    }

    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        return { success: false, error: '路径不是文件' };
      }

      const ext = extname(resolved).toLowerCase();
      if (this.filterExtensions.includes(ext)) {
        return { success: false, error: 'unsupported file extension' };
      }

      let content = readFileSync(resolved, 'utf-8');
      let truncated = false;
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + '\n\n...(内容已截断)';
        truncated = true;
      }

      const cardData: InfoCardData = {
        type: 'info',
        title: basename(resolved),
        content: content,
        level: 'info',
      };

      const cardRenderer = CardRenderer.getInstance();
      const provider = providerName ?? 'system';
      const buffer = await cardRenderer.render(cardData, { provider });
      const imageBase64 = buffer.toString('base64');

      logger.info(`[FileReadService] Rendered file as image: ${basename(resolved)}${truncated ? ' (truncated)' : ''}`);

      return { success: true, imageBase64 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { success: false, error: '文件不存在' };
      }
      if (msg.includes('EISDIR')) {
        return { success: false, error: '路径是目录，请使用 ls 查看' };
      }
      logger.warn('[FileReadService] readFileAsImage failed:', err);
      return { success: false, error: `读取文件失败: ${msg}` };
    }
  }
}
