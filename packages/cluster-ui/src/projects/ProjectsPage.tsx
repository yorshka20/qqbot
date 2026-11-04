import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { isLive } from '../lib/stage';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';

export function ProjectsPage() {
  const { projects, runs, templates } = useCluster();
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-5 md:p-8">
      <div className="max-w-3xl">
        <h1 className="mb-6 text-18 font-medium">项目</h1>
        {!projects ? (
          <SkeletonRows rows={3} />
        ) : projects.projects.length === 0 ? (
          <EmptyState title="还没有配置项目。" hint="在 daemon 的配置里登记项目后，这里会列出来。" />
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.projects.map((project) => {
              const own = runs.filter((r) => r.task.project === project.alias);
              const live = own.filter((r) => isLive(r.task)).length;
              return (
                <li key={project.alias}>
                  <a
                    href={routeHref({ section: 'runs', project: project.alias })}
                    className="block rounded-ui border border-line bg-surface-2 p-3 hover:border-ink-muted/60"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-16 font-medium">{project.alias}</span>
                      {project.isDefault && (
                        <span className="rounded-ui bg-line/60 px-1.5 py-0.5 text-12 text-ink-muted">默认</span>
                      )}
                      <span className="ml-auto text-13 text-ink-muted">
                        {live > 0 ? `${live} 条在跑` : `${own.length} 条运行`}
                      </span>
                    </div>
                    {project.description && <div className="text-14 text-ink-muted">{project.description}</div>}
                    <div className="font-mono text-13 break-all text-ink-muted">{project.path}</div>
                    {templates?.projectDefaults[project.alias] && (
                      <div className="text-13 text-ink-muted">默认模板 {templates.projectDefaults[project.alias]}</div>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
