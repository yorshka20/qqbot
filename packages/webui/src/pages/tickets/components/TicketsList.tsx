import { Pencil, Send, Trash2 } from 'lucide-react';
import type { ClusterTemplatesResponse, TicketFrontmatter } from '../../../types';
import { formatTicketTimestamp, projectBadgeClass, templateRoleBadgeClass, ticketStatusBadgeClass } from '../utils';

/**
 * Compact card-style list used in the left pane. Clicking a card selects
 * the ticket; clicking a project badge filters the list by that project
 * so the user can focus on one project's tickets quickly.
 *
 * Standard ticket fields are surfaced as colored badges rather than
 * plain mono text:
 *   - status: existing status tone
 *   - project: stable-hash color, so same project reads the same across rows
 *   - template: role-colored (planner=violet, executor=sky), matching the
 *     editor's TemplateSelect palette. Template role is looked up from the
 *     cluster templates snapshot; unknown templates render neutral.
 *
 * Action icons (Edit / Dispatch / Delete) sit in a dedicated bottom strip
 * so they never steal width from the content rows. "Dispatch" is only
 * enabled for `status === 'ready'`.
 */
export function TicketsList({
  tickets,
  templates,
  selectedId,
  onSelect,
  onEdit,
  onDispatch,
  onDelete,
  onProjectClick,
}: {
  tickets: TicketFrontmatter[];
  templates: ClusterTemplatesResponse | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDispatch: (id: string) => void;
  onDelete: (id: string) => void;
  /** Called when the user clicks a project badge — parent uses it to set the project filter. */
  onProjectClick?: (project: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <div className="text-sm text-zinc-500 dark:text-zinc-400 py-8 text-center px-4">
        No tickets match the current filter.
      </div>
    );
  }

  const templateIndex = new Map<string, 'planner' | 'executor'>();
  for (const t of templates?.templates ?? []) {
    templateIndex.set(t.name, t.role === 'planner' ? 'planner' : 'executor');
  }

  return (
    <div className="flex flex-col">
      {tickets.map((t) => {
        const isSelected = t.id === selectedId;
        const canDispatch = t.status === 'ready';
        const templateRole = t.template ? templateIndex.get(t.template) : undefined;
        return (
          // biome-ignore lint/a11y/useSemanticElements: <button> would nest action buttons inside it (invalid HTML); div+role=button is the intentional workaround
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(t.id);
              }
            }}
            role="button"
            tabIndex={0}
            className={`cursor-pointer border-b border-zinc-100 dark:border-zinc-700/50 transition-colors ${
              isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/30'
            }`}
          >
            <div className="px-3 pt-2.5 pb-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate flex-1 min-w-0">
                  {t.title}
                </div>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium shrink-0 ${ticketStatusBadgeClass(t.status)}`}
                >
                  {t.status}
                </span>
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate">{t.id}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {t.project ? (
                  <span
                    role={onProjectClick ? 'button' : undefined}
                    tabIndex={onProjectClick ? 0 : undefined}
                    onClick={(e) => {
                      if (!onProjectClick) return;
                      e.stopPropagation();
                      onProjectClick(t.project as string);
                    }}
                    onKeyDown={(e) => {
                      if (!onProjectClick) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onProjectClick(t.project as string);
                      }
                    }}
                    title={onProjectClick ? `Filter by project: ${t.project}` : t.project}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium font-mono ${projectBadgeClass(t.project)} ${onProjectClick ? 'cursor-pointer hover:ring-1 hover:ring-current/30' : ''}`}
                  >
                    {t.project}
                  </span>
                ) : (
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 italic">no project</span>
                )}
                {t.template ? (
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium font-mono ${
                      templateRole
                        ? templateRoleBadgeClass(templateRole)
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                    title={templateRole ? `${t.template} (${templateRole})` : t.template}
                  >
                    {templateRole && (
                      <span className="uppercase tracking-wide text-[9px] font-semibold opacity-80">
                        {templateRole === 'planner' ? 'P' : 'E'}
                      </span>
                    )}
                    {t.template}
                  </span>
                ) : null}
                <span className="ml-auto text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
                  {formatTicketTimestamp(t.updated)}
                </span>
              </div>
            </div>
            <div
              className="px-2 pb-1.5 flex items-center justify-end gap-0.5"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => onEdit(t.id)}
                className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                title="Edit ticket"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDispatch(t.id)}
                disabled={!canDispatch}
                className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-950/50 text-blue-600 dark:text-blue-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                title={canDispatch ? 'Dispatch to cluster' : 'Only `ready` tickets can be dispatched'}
              >
                <Send className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDelete(t.id)}
                className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-500 dark:text-red-400"
                title="Delete ticket"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
