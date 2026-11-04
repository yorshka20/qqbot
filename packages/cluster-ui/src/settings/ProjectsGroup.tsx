import { useCluster } from '../app/ClusterData';
import { Badge } from '../components/ui/badge';
import { isLive } from '../lib/stage';

export function ProjectsGroup() {
  const { projects, runs, templates } = useCluster();
  if (!projects) {
    return <p className="text-sm text-muted-foreground">正在读取项目…</p>;
  }
  if (projects.projects.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有配置项目。在 daemon 的配置里登记后会列在这里。</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {projects.projects.map((project) => {
        const own = runs.filter((r) => r.task.project === project.alias);
        const live = own.filter((r) => isLive(r.task)).length;
        const defaultTemplate = templates?.projectDefaults[project.alias];
        return (
          <li key={project.alias} className="min-w-0 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{project.alias}</span>
              {project.isDefault && <Badge variant="secondary">默认</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                在跑 {live} · 共 {own.length} 条运行
              </span>
            </div>
            {project.description && <p className="text-sm text-muted-foreground">{project.description}</p>}
            <p className="font-mono text-xs break-all text-muted-foreground">{project.path}</p>
            {defaultTemplate && <p className="text-xs text-muted-foreground">默认模板 {defaultTemplate}</p>}
          </li>
        );
      })}
    </ul>
  );
}
