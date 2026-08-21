import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createClusterJob, getClusterProjects, getClusterTemplates } from '../../../api';
import { RegistryProjectSelect } from '../../../components/RegistryProjectSelect';
import { TemplateSelect } from '../../../components/TemplateSelect';
import type { ClusterTemplatesResponse, ProjectRegistryEntry } from '../../../types';

export function SubmitTaskCard({ started, onSubmitted }: { started: boolean | null; onSubmitted: () => void }) {
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);
  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(null);

  const [project, setProject] = useState('');
  /**
   * Explicit template override for the submit form. Empty string = "use
   * project default" (projectDefaults[project] from the templates
   * snapshot). We don't auto-update this when `project` changes because
   * the user may deliberately have picked a non-default template that
   * applies to any project — resetting on every project change would
   * throw away their selection.
   */
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getClusterProjects()
      .then((resp) => {
        setProjects(resp.projects);
        if (resp.defaultAlias) {
          setProject(resp.defaultAlias);
        } else if (resp.projects.length > 0) {
          setProject(resp.projects[0].alias);
        }
      })
      .catch((err) => {
        console.warn('[SubmitTaskCard] getClusterProjects failed:', err);
      });
  }, []);

  useEffect(() => {
    if (!started) {
      setTemplates(null);
      return;
    }
    getClusterTemplates()
      .then(setTemplates)
      .catch((err) => {
        console.warn('[SubmitTaskCard] getClusterTemplates failed:', err);
      });
  }, [started]);

  const submit = async () => {
    if (!project.trim() || !desc.trim() || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createClusterJob({
        project: project.trim(),
        description: desc.trim(),
        workerTemplate: selectedTemplate || undefined,
      });
      setDesc('');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Project</div>
          <RegistryProjectSelect value={project} onChange={setProject} projects={projects} />
        </div>
        <div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Template</div>
          <TemplateSelect
            value={selectedTemplate}
            onChange={setSelectedTemplate}
            templates={templates?.templates ?? []}
            disabled={!templates}
            defaultLabel={`(default${
              templates?.projectDefaults?.[project] ? `: ${templates.projectDefaults[project]}` : ''
            })`}
          />
        </div>
      </div>
      <div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Description</div>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={10}
          className="w-full min-h-[220px] px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono leading-relaxed resize-y"
          placeholder='e.g. "fix type errors in cluster api page"'
        />
      </div>
      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="flex items-center gap-3">
        <div className="text-xs text-zinc-400 dark:text-zinc-500">The job appears under Recent jobs once accepted.</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !project.trim() || !desc.trim()}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center gap-2"
        >
          <Send className="w-4 h-4" />
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
