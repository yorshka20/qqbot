import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { isLive } from '../lib/stage';

export function ProjectsPage() {
  const { projects, runs, templates } = useCluster();
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-4 md:p-6">
      <div className="max-w-3xl">
        <h1 className="mb-4 text-17 font-medium">项目</h1>
        <ul className="flex flex-col">
          {projects?.projects.map((project) => {
            const own = runs.filter((r) => r.task.project === project.alias);
            const live = own.filter((r) => isLive(r.task)).length;
            return (
              <li key={project.alias}>
                <a
                  href={routeHref({ section: 'runs', project: project.alias })}
                  className="-mx-2 block rounded-ui px-2 py-2 hover:bg-surface-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-15 font-medium">{project.alias}</span>
                    {project.isDefault && <span className="text-13 text-ink-muted">默认</span>}
                    <span className="ml-auto text-13 text-ink-muted">
                      {live > 0 ? `${live} 条在跑` : `${own.length} 条运行`}
                    </span>
                  </div>
                  {project.description && <div className="text-13 text-ink-muted">{project.description}</div>}
                  <div className="font-mono text-13 break-all text-ink-muted">{project.path}</div>
                  {templates?.projectDefaults[project.alias] && (
                    <div className="text-13 text-ink-muted">默认模板 {templates.projectDefaults[project.alias]}</div>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
