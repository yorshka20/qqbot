import { Send, Skull } from 'lucide-react';
import type { LanClientSnapshot } from '../../../types';
import { formatDuration } from '../utils';

/**
 * Connected-client table. Selecting a row sets the active client (used by
 * the reports panel); the per-row Dispatch / Kick action buttons stop
 * propagation so they don't double-fire selection.
 *
 * Pure presentation: all state ownership stays in `LanPage`. The component
 * receives `Date.now()` as `now` from the parent so the parent's 1s tick
 * causes uptime/lastSeen labels to re-render — see the `tickKey` effect in
 * `pages/lan/index.tsx`.
 */
export function ClientsTable({
  clients,
  selectedClientId,
  onSelect,
  onDispatch,
  onKick,
  now,
}: {
  clients: LanClientSnapshot[];
  selectedClientId: string | null;
  onSelect: (clientId: string) => void;
  onDispatch: (clientId: string) => void;
  onKick: (clientId: string) => void;
  now: number;
}) {
  if (clients.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
        No clients connected.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
            <th className="text-left py-2 px-2 font-medium">clientId</th>
            <th className="text-left py-2 px-2 font-medium">lan</th>
            <th className="text-left py-2 px-2 font-medium">uptime</th>
            <th className="text-left py-2 px-2 font-medium">lastSeen</th>
            <th className="text-right py-2 px-2 font-medium">actions</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const isSelected = c.clientId === selectedClientId;
            return (
              <tr
                key={c.clientId}
                className={`border-b border-zinc-100 dark:border-zinc-700/50 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/30'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/30'
                }`}
                onClick={() => onSelect(c.clientId)}
              >
                <td className="py-2 px-2 font-mono text-xs">
                  <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {c.clientId}
                  </div>
                  {c.label && (
                    <div className="text-zinc-500 dark:text-zinc-400">{c.label}</div>
                  )}
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {c.lanAddress}
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {formatDuration(now - c.startedAt)}
                </td>
                <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {formatDuration(now - c.lastSeenAt)} ago
                </td>
                <td className="py-2 px-2">
                  {/* stopPropagation: action button clicks shouldn't also
                      trigger row selection. */}
                  <div
                    className="flex items-center justify-end gap-1"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onDispatch(c.clientId)}
                      className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300"
                      title="Dispatch command"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onKick(c.clientId)}
                      className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                      title="Kick client"
                    >
                      <Skull className="w-3.5 h-3.5" />
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
