/**
 * File type / category for filtering and grouping.
 * Shared by Sidebar filters and group-by logic.
 * Uses date-fns for week/date grouping.
 */

import { endOfWeek, format, startOfWeek } from 'date-fns';
import type { FileItem } from '../types';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov']);
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export type FileCategory = 'folder' | 'image' | 'sticker' | 'video' | 'audio' | 'other';

/** Category for filter sidebar: same as FileCategory but "folder" stays as folder. */
export type FilterType = 'all' | 'folder' | 'image' | 'sticker' | 'video' | 'audio' | 'other';

/** Sort order for date. */
export type SortOrder = 'dateDesc' | 'dateAsc';

/** Group by option (Windows-style). */
export type GroupBy = 'none' | 'date' | 'week' | 'type';

export function getFileCategory(item: FileItem): FileCategory {
  if (item.isDir) {
    return 'folder';
  }
  const e = ext(item.name);
  if (IMAGE_EXT.has(e)) {
    const pathLower = item.path.toLowerCase();
    if (pathLower.includes('sticker')) {
      return 'sticker';
    }
    return 'image';
  }
  if (VIDEO_EXT.has(e)) {
    return 'video';
  }
  if (AUDIO_EXT.has(e)) {
    return 'audio';
  }
  return 'other';
}

export function filterByType(items: FileItem[], filter: FilterType): FileItem[] {
  if (filter === 'all') {
    return items;
  }
  return items.filter((item) => getFileCategory(item) === filter);
}

export function sortByDate(items: FileItem[], order: SortOrder): FileItem[] {
  const sorted = [...items].sort((a, b) => {
    const ma = a.mtime ?? 0;
    const mb = b.mtime ?? 0;
    return order === 'dateAsc' ? ma - mb : mb - ma;
  });
  return sorted;
}

export interface FileGroup {
  label: string;
  items: FileItem[];
}

export function groupItems(items: FileItem[], groupBy: GroupBy): FileGroup[] {
  if (groupBy === 'none' || items.length === 0) {
    return [{ label: '', items }];
  }
  if (groupBy === 'type') {
    const map = new Map<FileCategory, FileItem[]>();
    for (const item of items) {
      const cat = getFileCategory(item);
      const list = map.get(cat) ?? [];
      list.push(item);
      map.set(cat, list);
    }
    const order: FileCategory[] = ['folder', 'image', 'sticker', 'video', 'audio', 'other'];
    return order
      .filter((cat) => map.has(cat))
      .map((cat) => ({
        label: categoryLabel(cat),
        items: map.get(cat) ?? [],
      }));
  }
  if (groupBy === 'date' || groupBy === 'week') {
    const map = new Map<string, FileItem[]>();
    for (const item of items) {
      const t = item.mtime != null ? item.mtime : 0;
      const d = new Date(t);
      const key =
        groupBy === 'week' ? format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd') : format(d, 'yyyy-MM-dd');
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    const keys = [...map.keys()].sort((a, b) => b.localeCompare(a));
    return keys.map((key) => ({
      label: groupBy === 'week' ? weekLabel(key) : key,
      items: map.get(key) ?? [],
    }));
  }
  return [{ label: '', items }];
}

function categoryLabel(cat: FileCategory): string {
  const labels: Record<FileCategory, string> = {
    folder: 'Folders',
    image: 'Images',
    sticker: 'Stickers',
    video: 'Videos',
    audio: 'Audio',
    other: 'Other',
  };
  return labels[cat];
}

function weekLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = endOfWeek(start, { weekStartsOn: 1 });
  return `Week of ${format(start, 'yyyy-MM-dd')} – ${format(end, 'yyyy-MM-dd')}`;
}
