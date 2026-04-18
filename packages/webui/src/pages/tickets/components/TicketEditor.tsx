import { Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RegistryProjectSelect } from '../../../components/RegistryProjectSelect';
import { StatusSelect } from '../../../components/StatusSelect';
import { TemplateSelect } from '../../../components/TemplateSelect';
import type { ClusterTemplatesResponse, ProjectRegistryEntry, TicketStatus } from '../../../types';
import { extractFrontmatter } from '../frontmatter';

/**
 * Resolve the displayed project: respect a non-empty current value
 * verbatim (even if unknown — RegistryProjectSelect shows it as a
 * warning option and `canSave` gates it). Only fall back to
 * initial/default when current is empty.
 */
function resolveRegistryProject(
  current: string,
  registryProjects: ProjectRegistryEntry[],
  initialProject: string,
): string {
  const trimmed = current.trim();
  if (trimmed) return trimmed;
  if (registryProjects.length === 0) return '';
  const aliases = new Set(registryProjects.map((p) => p.alias));
  const fromFm = initialProject.trim() && aliases.has(initialProject.trim()) ? initialProject.trim() : '';
  return fromFm || registryProjects.find((p) => p.isDefault)?.alias || registryProjects[0]?.alias || '';
}

/**
 * Inline editor panel for a single ticket. Used both for "create new"
 * (the `initial` prop has empty id) and "edit existing" — the parent
 * decides which by passing different `initial` shapes.
 *
 * Rendered directly in the right-hand pane of the tickets page (not a
 * modal). Parent controls visibility by conditionally mounting.
 *
 * Markdown body is a plain textarea — no live preview, no syntax
 * highlighting. The body IS the prompt that the worker will receive,
 * and we want what-you-see-is-what-the-agent-gets fidelity.
 *
 * `frontmatter` form fields (title / status / template / project) are
 * lifted out of the body because they have stable schema (dropdowns /
 * lifecycle gates) and need to round-trip through the REST API as
 * structured fields. Everything else is freeform markdown.
 */
export function TicketEditor({
  initial,
  templates,
  registryProjects,
  registryError,
  onCancel,
  onSave,
  saving,
}: {
  initial: {
    id: string; // empty string when creating
    title: string;
    status: TicketStatus;
    template: string; // empty string when unset
    project: string; // empty string when unset
    body: string;
    maxChildren: number | null;
    estimatedComplexity: 'trivial' | 'low' | 'medium' | 'high' | '';
  };
  templates: ClusterTemplatesResponse | null;
  /** From `GET /api/cluster/projects` — project must be one of these aliases. */
  registryProjects: ProjectRegistryEntry[];
  /** When set, registry snapshot failed; save stays disabled. */
  registryError?: string | null;
  onCancel: () => void;
  onSave: (next: {
    title: string;
    status: TicketStatus;
    template: string;
    project: string;
    body: string;
    maxChildren: number | null;
    estimatedComplexity: 'trivial' | 'low' | 'medium' | 'high' | '';
  }) => Promise<void> | void;
  saving: boolean;
}) {
  // Local form state — committed only on Save. TicketsPage remounts this
  // component (`key`) when switching create vs edit or changing ticket id.
  const [title, setTitle] = useState(initial.title);
  const [status, setStatus] = useState<TicketStatus>(initial.status);
  const [template, setTemplate] = useState(initial.template);
  const [project, setProject] = useState(initial.project);
  const [body, setBody] = useState(initial.body);
  // maxChildren stays as a string in form state so the user can clear the
  // input. We coerce to number on save (empty → null = unset).
  const [maxChildrenStr, setMaxChildrenStr] = useState(initial.maxChildren !== null ? String(initial.maxChildren) : '');
  const [estimatedComplexity, setEstimatedComplexity] = useState(initial.estimatedComplexity);
  /**
   * Brief banner shown when a paste lifted frontmatter into the form —
   * gives the user feedback that the header was absorbed instead of
   * silently stripped.
   */
  const [liftedFields, setLiftedFields] = useState<string[] | null>(null);

  /**
   * Body change handler that transparently absorbs any leading YAML
   * frontmatter block into the form fields. This handles the common
   * case where a ticket was generated/pasted with its `---` header
   * inline — the header fields go to form controls, the body textarea
   * keeps only the markdown body. Supports round-trip with the backend
   * serializer (which reassembles the header on save).
   */
  const handleBodyChange = (nextBody: string) => {
    const extracted = extractFrontmatter(nextBody);
    if (!extracted) {
      setBody(nextBody);
      return;
    }
    const fm = extracted.frontmatter;
    const lifted: string[] = [];
    if (fm.title !== undefined) {
      setTitle(fm.title);
      lifted.push('title');
    }
    if (fm.status !== undefined) {
      setStatus(fm.status);
      lifted.push('status');
    }
    if (fm.template !== undefined) {
      setTemplate(fm.template);
      lifted.push('template');
    }
    if (fm.project !== undefined) {
      setProject(fm.project);
      lifted.push('project');
    }
    if (fm.maxChildren !== undefined) {
      setMaxChildrenStr(String(fm.maxChildren));
      lifted.push('maxChildren');
    }
    if (fm.estimatedComplexity !== undefined) {
      setEstimatedComplexity(fm.estimatedComplexity);
      lifted.push('estimatedComplexity');
    }
    setBody(extracted.body);
    if (lifted.length > 0) setLiftedFields(lifted);
  };

  const effectiveProject = useMemo(
    () => resolveRegistryProject(project, registryProjects, initial.project),
    [project, registryProjects, initial.project],
  );

  /**
   * Whether the selected template is planner-role. Planner mode (spawning
   * child executors, maxChildren cap) is derived from this — there's no
   * separate "use planner" toggle.
   */
  const isPlannerTemplate = useMemo(() => {
    const t = template.trim();
    if (!t) return false;
    const entry = templates?.templates.find((x) => x.name === t);
    return entry?.role === 'planner';
  }, [template, templates]);

  const isCreate = initial.id === '';
  const projectListed = registryProjects.some((p) => p.alias === effectiveProject);
  const canSave = !saving && title.trim().length > 0 && projectListed && !registryError;

  const submit = async () => {
    if (!canSave) return;
    const parsedMax = maxChildrenStr.trim() ? Number.parseInt(maxChildrenStr.trim(), 10) : NaN;
    await onSave({
      title: title.trim(),
      status,
      template: template.trim(),
      project: effectiveProject.trim(),
      body,
      maxChildren: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
      estimatedComplexity: estimatedComplexity || '',
    });
  };

  return (
    <div className="h-full flex flex-col rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-hidden text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <div className="shrink-0 px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
        <div className="font-semibold">{isCreate ? 'New ticket' : 'Edit ticket'}</div>
        {!isCreate && <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{initial.id}</div>}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700"
          disabled={saving}
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
        {/* Frontmatter form */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-12">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">title</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
              placeholder='e.g. "Fix Discord emoji rendering"'
              disabled={saving}
            />
          </div>
          <div className="md:col-span-3">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">status</div>
            <StatusSelect value={status} onChange={setStatus} disabled={saving} />
          </div>
          <div className="md:col-span-5">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">template</div>
            <TemplateSelect
              value={template}
              onChange={setTemplate}
              templates={templates?.templates ?? []}
              disabled={saving}
            />
          </div>
          <div className="md:col-span-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">project</div>
            <RegistryProjectSelect
              value={effectiveProject}
              onChange={setProject}
              projects={registryProjects}
              disabled={saving}
            />
            {registryError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{registryError}</div>}
          </div>
          {/* estimatedComplexity + maxChildren. Planner vs executor mode
                is derived from the selected template's role; maxChildren is
                only meaningful for planner templates so it's disabled when
                a non-planner (or no) template is picked. */}
          <div className="md:col-span-6">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">estimatedComplexity</div>
            <select
              value={estimatedComplexity}
              onChange={(e) => setEstimatedComplexity(e.target.value as 'trivial' | 'low' | 'medium' | 'high' | '')}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
              disabled={saving}
            >
              <option value="">(not set)</option>
              <option value="trivial">trivial — single executor task</option>
              <option value="low">low — minimax sufficient</option>
              <option value="medium">medium — normal executor</option>
              <option value="high">high — consider claude-sonnet</option>
            </select>
          </div>
          <div className="md:col-span-6">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
              maxChildren{' '}
              <span className="text-zinc-400 dark:text-zinc-500">
                {isPlannerTemplate ? '(planner only)' : '(pick a planner template to enable)'}
              </span>
            </div>
            <input
              type="number"
              min={1}
              value={maxChildrenStr}
              onChange={(e) => setMaxChildrenStr(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm disabled:opacity-50"
              placeholder="(default 3)"
              disabled={saving || !isPlannerTemplate}
            />
          </div>
        </div>

        {/* Markdown body */}
        <div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-2">
            <span>body (markdown — this is what the worker will see verbatim)</span>
          </div>
          {liftedFields && (
            <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 text-xs text-blue-800 dark:text-blue-200">
              <div>
                粘贴的 frontmatter 已提取到表单字段：
                <span className="font-mono ml-1">{liftedFields.join(', ')}</span>
              </div>
              <button
                type="button"
                onClick={() => setLiftedFields(null)}
                className="text-blue-600 dark:text-blue-300 hover:underline shrink-0"
              >
                dismiss
              </button>
            </div>
          )}
          <textarea
            value={body}
            onChange={(e) => handleBodyChange(e.target.value)}
            className="w-full min-h-[400px] px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono leading-relaxed"
            placeholder="## Goal&#10;&#10;..."
            disabled={saving}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 px-5 py-3 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
