/**
 * Left sidebar: type filter, sort order, group by.
 * Uses lucide-react for icons.
 */

import { Folder, Image, Video, Music, FileText, Layers, ArrowDownUp, Calendar, CalendarRange } from 'lucide-react';
import type { FilterType, GroupBy, SortOrder } from '../utils/fileType';

interface SidebarProps {
  typeFilter: FilterType;
  sortOrder: SortOrder;
  groupBy: GroupBy;
  onTypeFilterChange: (v: FilterType) => void;
  onSortOrderChange: (v: SortOrder) => void;
  onGroupByChange: (v: GroupBy) => void;
}

const FILTER_OPTIONS: { value: FilterType; label: string; icon: React.ReactNode }[] = [
  { value: 'all', label: 'All', icon: <Layers className="w-4 h-4 shrink-0" /> },
  { value: 'folder', label: 'Folders', icon: <Folder className="w-4 h-4 shrink-0" /> },
  { value: 'image', label: 'Images', icon: <Image className="w-4 h-4 shrink-0" /> },
  { value: 'sticker', label: 'Stickers', icon: <Image className="w-4 h-4 shrink-0" /> },
  { value: 'video', label: 'Videos', icon: <Video className="w-4 h-4 shrink-0" /> },
  { value: 'audio', label: 'Audio', icon: <Music className="w-4 h-4 shrink-0" /> },
  { value: 'other', label: 'Other', icon: <FileText className="w-4 h-4 shrink-0" /> },
];

const SORT_OPTIONS: { value: SortOrder; label: string; icon: React.ReactNode }[] = [
  { value: 'dateDesc', label: 'Newest first', icon: <ArrowDownUp className="w-4 h-4 shrink-0" /> },
  { value: 'dateAsc', label: 'Oldest first', icon: <ArrowDownUp className="w-4 h-4 shrink-0" /> },
];

const GROUP_OPTIONS: { value: GroupBy; label: string; icon: React.ReactNode }[] = [
  { value: 'none', label: 'No grouping', icon: <Layers className="w-4 h-4 shrink-0" /> },
  { value: 'date', label: 'By date', icon: <Calendar className="w-4 h-4 shrink-0" /> },
  { value: 'week', label: 'By week', icon: <CalendarRange className="w-4 h-4 shrink-0" /> },
  { value: 'type', label: 'By type', icon: <Layers className="w-4 h-4 shrink-0" /> },
];

export function Sidebar({
  typeFilter,
  sortOrder,
  groupBy,
  onTypeFilterChange,
  onSortOrderChange,
  onGroupByChange,
}: SidebarProps) {
  return (
    <aside
      className="w-52 shrink-0 border-r border-zinc-200 bg-white flex flex-col overflow-hidden"
      aria-label="Filters and view options"
    >
      <div className="p-3 border-b border-zinc-100">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Type</h2>
        <nav className="flex flex-col gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onTypeFilterChange(opt.value)}
              className={`flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                typeFilter === opt.value
                  ? 'bg-zinc-200 text-zinc-900'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="p-3 border-b border-zinc-100">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Sort</h2>
        <div className="flex flex-col gap-0.5">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSortOrderChange(opt.value)}
              className={`flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                sortOrder === opt.value
                  ? 'bg-zinc-200 text-zinc-900'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-3">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Group by</h2>
        <div className="flex flex-col gap-0.5">
          {GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onGroupByChange(opt.value)}
              className={`flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
                groupBy === opt.value
                  ? 'bg-zinc-200 text-zinc-900'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
