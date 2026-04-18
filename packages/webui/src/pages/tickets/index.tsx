/**
 * Cluster Tickets page (route entry).
 *
 * Tickets are markdown files under `tickets/` at the project root,
 * managed via the TicketBackend REST API. The dispatch flow is what
 * connects them to the cluster: this page calls `createClusterJob` (the
 * existing cluster API) with the ticket body as the description, then
 * PUTs the ticket back with status=dispatched + dispatchedJobId.
 *
 * Layout:
 *   - Header: counts + New button + Refresh
 *   - Body: TicketsList (table)
 *   - Modals: TicketEditor (create/edit), DispatchConfirmDialog
 *
 * State sync:
 *   - Manual refresh on action completion (no polling) — tickets are
 *     edited by humans at human pace, no need for the 5s tick that
 *     ClusterPage / LanPage need for live worker state. The Refresh
 *     button is the escape hatch for "I edited a ticket file directly
 *     in VSCode" cases.
 */

import { FileText, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createClusterJob,
  createTicket,
  deleteTicket,
  getClusterProjects,
  getClusterTemplates,
  getTicket,
  getTicketTemplate,
  listTickets,
  updateTicket,
} from '../../api';
import type {
  ClusterTemplatesResponse,
  ProjectRegistryEntry,
  Ticket,
  TicketFrontmatter,
  TicketStatus,
} from '../../types';
import { DispatchConfirmDialog } from './components/DispatchConfirmDialog';
import { TicketDetailPanel } from './components/TicketDetailPanel';
import { TicketEditor } from './components/TicketEditor';
import { TicketProjectFilter } from './components/TicketProjectFilter';
import { TicketStatusFilter } from './components/TicketStatusFilter';
import { TicketsList } from './components/TicketsList';

/**
 * Resolve the role of a named template from a templates snapshot. Returns
 * 'planner' only when the template exists AND its role is explicitly
 * 'planner'. Unknown names (template not in the snapshot) resolve to
 * 'executor' — the scheduler will validate at dispatch time.
 */
function resolveTemplateRole(
  templateName: string | undefined,
  clusterTemplates: ClusterTemplatesResponse | null,
): 'planner' | 'executor' {
  const raw = templateName?.trim();
  if (!raw) return 'executor';
  const entry = clusterTemplates?.templates.find((t) => t.name === raw);
  return entry?.role === 'planner' ? 'planner' : 'executor';
}

/** Newest-first for the list; matches the timestamp shown per row (`updated`). */
function compareTicketsNewestFirst(a: TicketFrontmatter, b: TicketFrontmatter): number {
  const byUpdated = b.updated.localeCompare(a.updated);
  if (byUpdated !== 0) return byUpdated;
  const byCreated = b.created.localeCompare(a.created);
  if (byCreated !== 0) return byCreated;
  return b.id.localeCompare(a.id);
}

interface EditorState {
  // The full Ticket-like shape passed into TicketEditor. id === '' on create.
  id: string;
  title: string;
  status: TicketStatus;
  template: string;
  project: string;
  body: string;
  /** Phase 3: optional max-children cap. null = unset (planner uses default 5). */
  maxChildren: number | null;
  /** Hints for planner executor selection: trivial | low | medium | high. */
  estimatedComplexity: 'trivial' | 'low' | 'medium' | 'high' | '';
}

export function TicketsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tickets, setTickets] = useState<TicketFrontmatter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Full ticket (with body) for the currently-selected row, fetched on
   * demand when `selectedId` changes. The list endpoint only returns
   * frontmatter, so we can't render the detail panel without an extra
   * GET. Refetched after edit / dispatch so the panel reflects fresh state.
   */
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [loadingSelected, setLoadingSelected] = useState(false);

  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(null);
  /** Default ticket body loaded from `GET /api/tickets/template`. Null = not yet fetched. */
  const [ticketTemplateBody, setTicketTemplateBody] = useState<string | null>(null);
  const [registryProjects, setRegistryProjects] = useState<ProjectRegistryEntry[]>([]);
  const [registryDefaultAlias, setRegistryDefaultAlias] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [savingEditor, setSavingEditor] = useState(false);

  const [dispatchTicket, setDispatchTicket] = useState<Ticket | null>(null);
  const [dispatching, setDispatching] = useState(false);
  /**
   * Defers opening the create editor until the template fetch completes.
   * Ref (not state) so setting/clearing it doesn't trigger a render cascade —
   * the effect below already rerenders when `ticketTemplateBody` changes,
   * which is the real trigger we care about.
   */
  const pendingCreateRef = useRef(false);
  /** null = show all projects; string = filter to tickets whose project === this. */
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  /** null = all statuses */
  const [statusFilter, setStatusFilter] = useState<TicketStatus | null>(null);

  // ── Polling / refresh ──────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await listTickets();
      const sorted = [...list].sort(compareTicketsNewestFirst);
      setTickets(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Fetch the full ticket (with body) whenever the selected row changes
  // or its frontmatter timestamp moves. The list endpoint only returns
  // frontmatter, so the detail panel needs an extra GET for the body.
  // The `selectedUpdated` dep makes the effect re-fire when the listing
  // refresh brings a newer `updated` for the selected row (e.g. after
  // dispatch stamps `dispatchedJobId`), so the panel picks it up without
  // an extra round trip.
  const selectedUpdated = tickets.find((t) => t.id === selectedId)?.updated;
  useEffect(() => {
    if (!selectedId) {
      setSelectedTicket(null);
      return;
    }
    let cancelled = false;
    setLoadingSelected(true);
    // Capture the trigger so the static analyzer sees both deps as
    // load-bearing — `selectedUpdated` is the "row changed on server"
    // signal even though we don't pass it to getTicket itself.
    const refetchKey = selectedUpdated ?? '<initial>';
    getTicket(selectedId)
      .then((t) => {
        if (!cancelled) setSelectedTicket(t);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn(`[TicketsPage] getTicket failed for ${selectedId} (refetchKey=${refetchKey}):`, err);
          setSelectedTicket(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSelected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedUpdated]);

  // Templates: fetch once on mount (config-static, doesn't change at runtime
  // unless cluster restarts). Same strategy as ClusterPage.
  useEffect(() => {
    getClusterTemplates()
      .then(setTemplates)
      .catch((err) => {
        // Non-fatal — editor falls back to a "(use project default)"
        // option when templates aren't available. Cluster might just be
        // off; tickets are still editable without a live cluster.
        console.warn('[TicketsPage] getClusterTemplates failed:', err);
      });
  }, []);

  // Ticket body template: fetched once on mount from `prompts/cluster/ticket-template.md`.
  // The template file contains YAML frontmatter + markdown body; only the body
  // portion is pre-filled into the textarea (frontmatter fields are edited via
  // dedicated form controls). If the file is absent (404) the editor starts empty.
  useEffect(() => {
    getTicketTemplate()
      .then((content) => {
        // Strip YAML frontmatter so the textarea gets only the body.
        const lines = content.split('\n');
        const bodyStart = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        const body =
          bodyStart === -1
            ? content
            : lines
                .slice(bodyStart + 1)
                .join('\n')
                .replace(/^\n+/, '');
        setTicketTemplateBody(body);
      })
      .catch((err) => {
        console.warn('[TicketsPage] getTicketTemplate failed (editor starts empty):', err);
        setTicketTemplateBody('');
      });
  }, []);

  // Flush deferred create once the template arrives.
  useEffect(() => {
    if (pendingCreateRef.current && ticketTemplateBody !== null) {
      pendingCreateRef.current = false;
      const aliases = new Set(registryProjects.map((p) => p.alias));
      const last = tickets[0]?.project?.trim() ?? '';
      const lastOk = last && aliases.has(last) ? last : '';
      const fallback =
        (registryDefaultAlias && aliases.has(registryDefaultAlias) ? registryDefaultAlias : null) ??
        registryProjects.find((p) => p.isDefault)?.alias ??
        registryProjects[0]?.alias ??
        '';
      setEditor({
        id: '',
        title: '',
        status: 'draft',
        template: '',
        project: lastOk || fallback,
        body: ticketTemplateBody,
        maxChildren: null,
        estimatedComplexity: '',
      });
    }
  }, [ticketTemplateBody, registryProjects, registryDefaultAlias, tickets]);

  // ProjectRegistry snapshot (always-on route — same source as Cluster page).
  useEffect(() => {
    getClusterProjects()
      .then((resp) => {
        setRegistryProjects(resp.projects);
        setRegistryDefaultAlias(resp.defaultAlias || null);
        setRegistryError(null);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setRegistryProjects([]);
        setRegistryDefaultAlias(null);
        setRegistryError(msg);
        console.warn('[TicketsPage] getClusterProjects failed:', err);
      });
  }, []);

  // ── Open editor ────────────────────────────────────────────────────────

  const openCreate = () => {
    // If the template hasn't loaded yet, defer until it does.
    if (ticketTemplateBody === null) {
      pendingCreateRef.current = true;
      return;
    }
    const aliases = new Set(registryProjects.map((p) => p.alias));
    const last = tickets[0]?.project?.trim() ?? '';
    const lastOk = last && aliases.has(last) ? last : '';
    const fallback =
      (registryDefaultAlias && aliases.has(registryDefaultAlias) ? registryDefaultAlias : null) ??
      registryProjects.find((p) => p.isDefault)?.alias ??
      registryProjects[0]?.alias ??
      '';
    setEditor({
      id: '',
      title: '',
      status: 'draft',
      template: '',
      project: lastOk || fallback,
      body: ticketTemplateBody,
      maxChildren: null,
      estimatedComplexity: '',
    });
  };

  const openEdit = useCallback(async (id: string) => {
    setError(null);
    try {
      const ticket = await getTicket(id);
      setSelectedId(id);
      setEditor({
        id: ticket.id,
        title: ticket.frontmatter.title,
        status: ticket.frontmatter.status,
        template: ticket.frontmatter.template ?? '',
        project: ticket.frontmatter.project ?? '',
        body: ticket.body,
        maxChildren: typeof ticket.frontmatter.maxChildren === 'number' ? ticket.frontmatter.maxChildren : null,
        estimatedComplexity: ticket.frontmatter.estimatedComplexity ?? '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ── Save (create or update) ────────────────────────────────────────────

  const saveEditor = async (next: {
    title: string;
    status: TicketStatus;
    template: string;
    project: string;
    body: string;
    maxChildren: number | null;
    estimatedComplexity: 'trivial' | 'low' | 'medium' | 'high' | '';
  }) => {
    if (!editor) return;
    setSavingEditor(true);
    setError(null);
    try {
      if (editor.id === '') {
        // Create
        const created = await createTicket({
          title: next.title,
          status: next.status,
          template: next.template || undefined,
          project: next.project,
          body: next.body,
          maxChildren: next.maxChildren ?? undefined,
          estimatedComplexity: next.estimatedComplexity || undefined,
        });
        setEditor(null);
        await refresh();
        setSelectedId(created.id);
      } else {
        // Update — pass null for "" to clear nullable fields explicitly,
        // mirroring the backend's "null = clear, undefined = keep" semantics.
        await updateTicket(editor.id, {
          title: next.title,
          status: next.status,
          template: next.template ? next.template : null,
          project: next.project ? next.project : null,
          body: next.body,
          maxChildren: next.maxChildren,
          estimatedComplexity: next.estimatedComplexity ? next.estimatedComplexity : null,
        });
        setEditor(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEditor(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Delete ticket "${id}"? The markdown file will be removed from disk.`)) return;
    try {
      await deleteTicket(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Dispatch ───────────────────────────────────────────────────────────

  const openDispatch = async (id: string) => {
    setError(null);
    try {
      // Always pull the freshest copy — the listing has frontmatter only,
      // we need the body for the prompt preview + the actual cluster job
      // submission.
      const ticket = await getTicket(id);
      setDispatchTicket(ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Build the full prompt sent to the cluster by combining ticket
   * frontmatter metadata (maxChildren, estimatedComplexity) as YAML
   * frontmatter with the markdown body. This keeps the ticket file
   * self-contained while ensuring the cluster/planner receives all
   * metadata needed for executor selection.
   */
  const buildClusterDescription = (ticket: Ticket): string => {
    const fm = ticket.frontmatter;
    const parts: string[] = ['---'];
    if (fm.estimatedComplexity) parts.push(`estimatedComplexity: ${fm.estimatedComplexity}`);
    if (fm.maxChildren) parts.push(`maxChildren: ${fm.maxChildren}`);
    parts.push('---', '');
    parts.push(ticket.body);
    return parts.join('\n');
  };

  const confirmDispatch = async (project: string) => {
    if (!dispatchTicket) return;
    const trimmed = project.trim();
    if (!trimmed || !registryProjects.some((p) => p.alias === trimmed)) {
      return;
    }

    setDispatching(true);
    setError(null);
    try {
      // 1. Create the cluster job — body becomes the worker prompt verbatim.
      // Planner vs executor is derived from the selected template's role:
      // picking a planner-role template sets requirePlannerRole so the
      // scheduler validates it and the job runs in planner mode. No
      // separate usePlanner flag on the ticket anymore.
      let tplSnapshot = templates;
      const pickedTemplate = dispatchTicket.frontmatter.template?.trim();
      if (pickedTemplate && !tplSnapshot) {
        try {
          tplSnapshot = await getClusterTemplates();
          setTemplates(tplSnapshot);
        } catch {
          // Unknown role — pass the template through; server validates.
        }
      }
      const role = resolveTemplateRole(pickedTemplate, tplSnapshot);
      const job = await createClusterJob({
        project: trimmed,
        description: buildClusterDescription(dispatchTicket),
        workerTemplate: pickedTemplate || undefined,
        requirePlannerRole: role === 'planner' ? true : undefined,
        ticketId: dispatchTicket.id,
      });

      // 2. Mark the ticket as dispatched + record the job linkage.
      // `job` is a ClusterTask shape — its `jobId` field is what we want
      // for cross-reference. Fall back to `id` if jobId is missing for
      // any reason (shouldn't happen, but defensive).
      const jobIdRef = (job as { jobId?: string }).jobId ?? job.id;
      await updateTicket(dispatchTicket.id, {
        status: 'dispatched',
        dispatchedJobId: jobIdRef,
        project: trimmed,
      });

      setDispatchTicket(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  // Unique project aliases from the current tickets, used to populate the
  // filter dropdown. Sorted for stable ordering; tickets with no project are
  // grouped under a synthetic "(no project)" sentinel so they're filterable.
  const projectOptions = Array.from(
    new Set(tickets.map((t) => (t.project?.trim() ? t.project.trim() : '__none__'))),
  ).sort();

  const filteredTickets = tickets.filter((t) => {
    if (projectFilter !== null) {
      if (projectFilter === '__none__') {
        if (t.project?.trim()) return false;
      } else if (t.project?.trim() !== projectFilter) {
        return false;
      }
    }
    if (statusFilter !== null && t.status !== statusFilter) return false;
    return true;
  });

  const hasActiveFilter = projectFilter !== null || statusFilter !== null;
  const summary = hasActiveFilter
    ? `${filteredTickets.length} / ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`
    : `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`;

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">Cluster Tickets</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{summary}</div>
            {/* Project filter — null = all; "__none__" sentinel surfaces
                tickets with no project set. Badge-click in the list also
                writes to this state for quick focus on one project. */}
            <TicketProjectFilter value={projectFilter} onChange={setProjectFilter} options={projectOptions} />
            <TicketStatusFilter value={statusFilter} onChange={setStatusFilter} />
            <div className="flex-1" />
            <button
              type="button"
              onClick={openCreate}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New
            </button>
            <button
              type="button"
              onClick={() => refresh()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        {/* Body — split pane: list (left) + detail/editor (right), 1:1. */}
        <div className="flex-1 min-h-0 flex bg-zinc-100 dark:bg-zinc-900">
          {/* Left: ticket list (compact cards, scrolls independently). */}
          <div className="flex-1 min-w-0 basis-1/2 border-r border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-y-auto">
            <TicketsList
              tickets={filteredTickets}
              templates={templates}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onEdit={openEdit}
              onDispatch={openDispatch}
              onDelete={handleDelete}
              onProjectClick={setProjectFilter}
            />
          </div>

          {/* Right: editor if open, else detail for selection, else placeholder.
              Editor takes precedence so the user keeps typing even if they
              click a different ticket row mid-edit — parent ignores row
              selection changes while editor is mounted. */}
          <div className="flex-1 min-w-0 basis-1/2 overflow-y-auto p-4">
            {editor ? (
              <TicketEditor
                key={editor.id || 'new'}
                initial={editor}
                templates={templates}
                registryProjects={registryProjects}
                registryError={registryError}
                onCancel={() => {
                  if (!savingEditor) setEditor(null);
                }}
                onSave={saveEditor}
                saving={savingEditor}
              />
            ) : selectedId && selectedTicket ? (
              <TicketDetailPanel ticket={selectedTicket} onClose={() => setSelectedId(null)} />
            ) : selectedId && loadingSelected ? (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                Loading ticket {selectedId}…
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
                Select a ticket from the list, or click "New" to create one.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dispatch confirm modal */}
      {dispatchTicket && (
        <DispatchConfirmDialog
          key={dispatchTicket.id}
          ticket={dispatchTicket}
          resolvedTemplate={dispatchTicket.frontmatter.template ?? ''}
          isPlannerTemplate={resolveTemplateRole(dispatchTicket.frontmatter.template, templates) === 'planner'}
          registryProjects={registryProjects}
          registryError={registryError}
          submitting={dispatching}
          onCancel={() => {
            if (!dispatching) setDispatchTicket(null);
          }}
          onConfirm={confirmDispatch}
        />
      )}
    </div>
  );
}
