import { Send, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RegistryProjectSelect } from '../../../components/RegistryProjectSelect';
import type { ProjectRegistryEntry, Ticket } from '../../../types';

/**
 * Confirm dialog before dispatching a ticket as a cluster job. Shows the
 * full prompt the worker will receive (the entire markdown body) so the
 * user can sanity-check before pulling the trigger — and a brief summary
 * of which template/project it'll go to.
 *
 * Why a separate confirm step (vs just sending immediately): once
 * dispatched the ticket switches to `dispatched` status and a real
 * cluster_job is created consuming a worker slot. That's not free,
 * especially if you accidentally hit the wrong row.
 */
export function DispatchConfirmDialog({
  ticket,
  resolvedTemplate,
  registryProjects,
  registryError,
  submitting,
  onCancel,
  onConfirm,
}: {
  ticket: Ticket;
  /** Effective template after applying project default. May still be empty. */
  resolvedTemplate: string;
  /** ProjectRegistry snapshot — dispatch target must be one of these aliases. */
  registryProjects: ProjectRegistryEntry[];
  registryError?: string | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (project: string) => void;
}) {
  const defaultProject = useMemo(() => {
    if (registryProjects.length === 0) return '';
    const aliases = new Set(registryProjects.map((p) => p.alias));
    const raw = ticket.frontmatter.project?.trim() ?? '';
    if (raw && aliases.has(raw)) return raw;
    return registryProjects.find((p) => p.isDefault)?.alias ?? registryProjects[0]?.alias ?? '';
  }, [ticket.frontmatter.project, registryProjects]);

  /** User override; reset when the dialog remounts (`key={ticket.id}` on parent). */
  const [picked, setPicked] = useState<string | null>(null);
  const dispatchProject = picked ?? defaultProject;

  const projectOk = dispatchProject.trim().length > 0 && registryProjects.some((p) => p.alias === dispatchProject);
  const canDispatch = !submitting && projectOk && !registryError && registryProjects.length > 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern, keyboard escape handler attached
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={() => {
        if (!submitting) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !submitting) onCancel();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation wrapper inside modal backdrop */}
      <div
        className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
          <div className="font-semibold">Dispatch ticket</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{ticket.id}</div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700"
            disabled={submitting}
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          <div className="text-sm">
            <div className="font-semibold text-zinc-900 dark:text-zinc-100">{ticket.frontmatter.title}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              template: <span className="font-mono">{resolvedTemplate || '(project default)'}</span>
              {ticket.frontmatter.usePlanner && (
                <>
                  {' · '}
                  <span className="font-mono text-purple-700 dark:text-purple-300">planner mode</span>
                  {ticket.frontmatter.maxChildren && (
                    <span className="font-mono text-zinc-500 dark:text-zinc-400">
                      {' '}
                      (maxChildren={ticket.frontmatter.maxChildren})
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">project</div>
            <RegistryProjectSelect
              value={dispatchProject}
              onChange={(alias) => setPicked(alias)}
              projects={registryProjects}
              disabled={submitting}
            />
            {registryError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{registryError}</div>}
          </div>

          {ticket.frontmatter.usePlanner && (
            <div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 p-3 text-xs text-purple-800 dark:text-purple-300">
              <strong>Planner mode</strong>: dispatch will pick a planner-role worker template (or
              <code className="mx-1">cluster.defaultPlannerTemplate</code> if none is pinned). The planner is expected
              to decompose this ticket and spawn child executor workers via
              <code className="mx-1">hub_spawn</code>. If no planner-role template exists, dispatch will fail.
            </div>
          )}

          {!registryError && registryProjects.length === 0 && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
              Loading registered projects…
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
              Worker prompt preview (full ticket body — sent verbatim)
            </div>
            <pre className="text-xs font-mono bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words">
              {ticket.body}
            </pre>
          </div>
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(dispatchProject)}
            disabled={!canDispatch}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Dispatching…' : 'Dispatch'}
          </button>
        </div>
      </div>
    </div>
  );
}
