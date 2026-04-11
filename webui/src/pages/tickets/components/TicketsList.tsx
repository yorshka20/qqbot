import { Pencil, Send, Trash2 } from 'lucide-react';
import type { TicketFrontmatter } from '../../../types';
import { formatTicketTimestamp, ticketStatusBadgeClass } from '../utils';

/**
 * Pure presentation: ticket list table. Selection drives the editor
 * panel; per-row Edit / Dispatch / Delete action buttons stop event
 * propagation so they don't double-fire selection.
 *
 * "Dispatch" is intentionally only enabled for `status === 'ready'` —
 * draft tickets shouldn't be dispatchable, and dispatched/done/abandoned
 * tickets are already past that lifecycle gate. The whole row is still
 * clickable to view/edit at any state.
 */
export function TicketsList({
  tickets,
  selectedId,
  onSelect,
  onEdit,
  onDispatch,
  onDelete,
}: {
  tickets: TicketFrontmatter[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDispatch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
        No tickets yet. Click "New" above to create one.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
            <th className="text-left py-2 px-2 font-medium">title</th>
            <th className="text-left py-2 px-2 font-medium">status</th>
            <th className="text-left py-2 px-2 font-medium">template</th>
            <th className="text-left py-2 px-2 font-medium">project</th>
            <th className="text-left py-2 px-2 font-medium">updated</th>
            <th className="text-right py-2 px-2 font-medium">actions</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const isSelected = t.id === selectedId;
            const canDispatch = t.status === 'ready';
            return (
              <tr
                key={t.id}
                className={`border-b border-zinc-100 dark:border-zinc-700/50 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/30'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/30'
                }`}
                onClick={() => onSelect(t.id)}
              >
                <td className="py-2 px-2 max-w-md">
                  <div className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {t.title}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate">
                    {t.id}
                  </div>
                </td>
                <td className="py-2 px-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${ticketStatusBadgeClass(t.status)}`}
                  >
                    {t.status}
                  </span>
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {t.template ?? '-'}
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {t.project ?? '-'}
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {formatTicketTimestamp(t.updated)}
                </td>
                <td className="py-2 px-2">
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation wrapper so action button clicks don't double-fire row selection */}
                  <div
                    className="flex items-center justify-end gap-1"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onEdit(t.id)}
                      className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300"
                      title="Edit ticket"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDispatch(t.id)}
                      disabled={!canDispatch}
                      className="p-1.5 rounded hover:bg-blue-100 dark:hover:bg-blue-950/50 text-blue-600 dark:text-blue-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                      title={canDispatch ? 'Dispatch to cluster' : 'Only `ready` tickets can be dispatched'}
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(t.id)}
                      className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                      title="Delete ticket"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
