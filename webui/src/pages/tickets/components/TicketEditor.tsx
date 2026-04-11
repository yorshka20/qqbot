import { Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ClusterTemplatesResponse, TicketStatus } from "../../../types";

/**
 * Modal editor for a single ticket. Used both for "create new" (the
 * `initial` prop has empty id) and "edit existing" — the parent decides
 * which by passing different `initial` shapes.
 *
 * Markdown body is a plain textarea — no live preview, no syntax
 * highlighting. The body IS the prompt that the worker will receive,
 * and we want what-you-see-is-what-the-agent-gets fidelity. If you
 * want preview, edit the file directly with VSCode + open it in any
 * markdown viewer.
 *
 * `frontmatter` form fields (title / status / template / project) are
 * lifted out of the body because they have stable schema (dropdowns /
 * lifecycle gates) and need to round-trip through the REST API as
 * structured fields. Everything else is freeform markdown.
 *
 * Cancel discards changes silently. Save calls onSave with the patch.
 * Click-outside / Escape both close — but only when not currently
 * saving (avoid losing the user's work mid-flight).
 */
export function TicketEditor({
  initial,
  templates,
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
    usePlanner: boolean;
    maxChildren: number | null;
  };
  templates: ClusterTemplatesResponse | null;
  onCancel: () => void;
  onSave: (next: {
    title: string;
    status: TicketStatus;
    template: string;
    project: string;
    body: string;
    usePlanner: boolean;
    maxChildren: number | null;
  }) => Promise<void> | void;
  saving: boolean;
}) {
  // Local form state — committed only on Save. Re-initialized when the
  // `initial` reference changes so re-opening the editor on a different
  // ticket actually shows the new ticket's content.
  const [title, setTitle] = useState(initial.title);
  const [status, setStatus] = useState<TicketStatus>(initial.status);
  const [template, setTemplate] = useState(initial.template);
  const [project, setProject] = useState(initial.project);
  const [body, setBody] = useState(initial.body);
  const [usePlanner, setUsePlanner] = useState(initial.usePlanner);
  // maxChildren stays as a string in form state so the user can clear the
  // input. We coerce to number on save (empty → null = unset).
  const [maxChildrenStr, setMaxChildrenStr] = useState(
    initial.maxChildren !== null ? String(initial.maxChildren) : "",
  );

  useEffect(() => {
    setTitle(initial.title);
    setStatus(initial.status);
    setTemplate(initial.template);
    setProject(initial.project);
    setBody(initial.body);
    setUsePlanner(initial.usePlanner);
    setMaxChildrenStr(
      initial.maxChildren !== null ? String(initial.maxChildren) : "",
    );
  }, [initial]);

  const isCreate = initial.id === "";
  const canSave = !saving && title.trim().length > 0;

  const submit = async () => {
    if (!canSave) return;
    const parsedMax = maxChildrenStr.trim()
      ? Number.parseInt(maxChildrenStr.trim(), 10)
      : NaN;
    await onSave({
      title: title.trim(),
      status,
      template: template.trim(),
      project: project.trim(),
      body,
      usePlanner,
      maxChildren:
        Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
    });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern, keyboard escape handler attached
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={() => {
        if (!saving) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) onCancel();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation wrapper inside modal backdrop */}
      <div
        className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
          <div className="font-semibold">
            {isCreate ? "New ticket" : "Edit ticket"}
          </div>
          {!isCreate && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              {initial.id}
            </div>
          )}
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
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                title
              </div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                placeholder='e.g. "Fix Discord emoji rendering"'
                disabled={saving}
              />
            </div>
            <div className="md:col-span-3">
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                status
              </div>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TicketStatus)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                disabled={saving}
              >
                <option value="draft">draft</option>
                <option value="ready">ready</option>
                <option value="dispatched">dispatched</option>
                <option value="done">done</option>
                <option value="abandoned">abandoned</option>
              </select>
            </div>
            <div className="md:col-span-5">
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                template
              </div>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                disabled={saving}
              >
                <option value="">(use project default)</option>
                {templates?.templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} · {t.type} · {t.costTier}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-4">
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                project
              </div>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                placeholder="qqbot"
                disabled={saving}
              />
            </div>
            {/* Phase 3: planner mode toggle. usePlanner forces dispatch to
                pick a planner-role worker template. maxChildren is a soft
                cap surfaced to the planner via prompt — empty/0 = no cap. */}
            <div className="md:col-span-4 flex items-center gap-2 pt-5">
              <input
                id="ticket-use-planner"
                type="checkbox"
                checked={usePlanner}
                onChange={(e) => setUsePlanner(e.target.checked)}
                disabled={saving}
                className="w-4 h-4"
              />
              <label
                htmlFor="ticket-use-planner"
                className="text-xs text-zinc-700 dark:text-zinc-300 select-none"
              >
                use planner (multi-agent decomposition)
              </label>
            </div>
            <div className="md:col-span-3">
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                maxChildren (planner only)
              </div>
              <input
                type="number"
                min={1}
                value={maxChildrenStr}
                onChange={(e) => setMaxChildrenStr(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm disabled:opacity-50"
                placeholder="(default 3)"
                disabled={saving || !usePlanner}
              />
            </div>
          </div>

          {/* Markdown body */}
          <div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-2">
              <span>
                body (markdown — this is what the worker will see verbatim)
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
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
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
