import type { ClusterWorkerTemplate } from '@qqbot/api-types';

export interface TemplateGroups {
  planners: ClusterWorkerTemplate[];
  executors: ClusterWorkerTemplate[];
}

/** Planners and executors apart, each alphabetical: picking one where the other was meant changes what the run is. */
export function groupTemplates(templates: readonly ClusterWorkerTemplate[]): TemplateGroups {
  const byName = [...templates].sort((a, b) => a.name.localeCompare(b.name));
  return {
    planners: byName.filter((t) => t.role === 'planner'),
    executors: byName.filter((t) => t.role !== 'planner'),
  };
}

/** The backend a template runs on, as a short tag: `claude-cli` → `claude`. */
export function providerTag(type: string): string {
  return type.replace(/-cli$/, '');
}
