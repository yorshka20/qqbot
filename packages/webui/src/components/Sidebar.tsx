/**
 * Left sidebar: type filter, sort order, group by.
 * Uses lucide-react for icons.
 */

import { ArrowDownUp, Calendar, CalendarRange, FileText, Folder, HardDrive, Image, Layers, Music, Video } from 'lucide-react';
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
  { value: 'sizeDesc', label: 'Largest first', icon: <HardDrive className="w-4 h-4 shrink-0" /> },
  { value: 'sizeAsc', label: 'Smallest first', icon: <HardDrive className="w-4 h-4 shrink-0" /> },
];

const GROUP_OPTIONS: { value: GroupBy; label: string; icon: React.ReactNode }[] = [
  { value: 'none', label: 'No grouping', icon: <Layers className="w-4 h-4 shrink-0" /> },
  { value: 'date', label: 'By date', icon: <Calendar className="w-4 h-4 shrink-0" /> },
  { value: 'week', label: 'By week', icon: <CalendarRange className="w-4 h-4 shrink-0" /> },
  { value: 'type', label: 'By type', icon: <Layers className="w-4 h-4 shrink-0" /> },
];

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-3 border-b border-zinc-100 dark:border-zinc-700">
      <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">{title}</h2>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function SidebarButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full ${
        active
          ? 'bg-zinc-200 dark:bg-zinc-600 text-zinc-900 dark:text-zinc-100'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

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
      className="w-52 shrink-0 min-h-0 border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex flex-col overflow-y-auto"
      aria-label="Filters and view options"
    >
      <SidebarSection title="Type">
        <nav className="flex flex-col gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <SidebarButton
              key={opt.value}
              active={typeFilter === opt.value}
              onClick={() => onTypeFilterChange(opt.value)}
              icon={opt.icon}
              label={opt.label}
            />
          ))}
        </nav>
      </SidebarSection>
      <SidebarSection title="Sort">
        {SORT_OPTIONS.map((opt) => (
          <SidebarButton
            key={opt.value}
            active={sortOrder === opt.value}
            onClick={() => onSortOrderChange(opt.value)}
            icon={opt.icon}
            label={opt.label}
          />
        ))}
      </SidebarSection>
      <div className="p-3">
        <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Group by</h2>
        <div className="flex flex-col gap-0.5">
          {GROUP_OPTIONS.map((opt) => (
            <SidebarButton
              key={opt.value}
              active={groupBy === opt.value}
              onClick={() => onGroupByChange(opt.value)}
              icon={opt.icon}
              label={opt.label}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
