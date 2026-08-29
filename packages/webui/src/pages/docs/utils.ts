import type { FileItem } from '../../types';

export type PreviewMode = 'markdown' | 'text' | 'image' | 'pdf' | 'binary';

/**
 * Newest first, dirs before files. Name-descending as the tiebreak keeps
 * date-named entries (workbook days, dump files) newest-first even when
 * mtimes collapse to one instant (fresh checkout).
 */
export function byNewestFirst(a: FileItem, b: FileItem): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  if (a.mtime !== b.mtime) return (b.mtime ?? 0) - (a.mtime ?? 0);
  return b.name.localeCompare(a.name);
}

export interface SelectedDoc {
  path: string;
  name: string;
}

export function previewMode(contentType: string, filename: string): PreviewMode {
  const lower = filename.toLowerCase();
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('markdown') || lower.endsWith('.md')) return 'markdown';
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('typescript') ||
    ct.includes('javascript') ||
    lower.endsWith('.jsonc')
  ) {
    return 'text';
  }
  return 'binary';
}
