import type {
  ClusterDaemonHealthResponse,
  ClusterStatusResponse,
  ClusterTemplatesResponse,
  ProjectsResponse,
} from '@qqbot/api-types';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getClusterProjects,
  getClusterStatus,
  getClusterTemplates,
  getDaemonHealth,
  pauseCluster,
  resumeCluster,
  startCluster,
  stopCluster,
} from '../../api';
import { signOut } from '../../auth/session';
import { type ClusterLifecycleAction, LifecycleControls } from '../execution/cluster/components/LifecycleControls';
import { formatTimestamp } from '../execution/cluster/utils';

const LIFECYCLE: Record<ClusterLifecycleAction, () => Promise<unknown>> = {
  start: startCluster,
  stop: stopCluster,
  pause: pauseCluster,
  resume: resumeCluster,
};

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <div className="flex-1" />
        {action}
      </div>
      <div className="p-4 overflow-x-auto">{children}</div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<{ key: string; cells: ReactNode[] }> }) {
  return (
    <table className="w-full text-xs text-left">
      <thead>
        <tr className="text-zinc-500 dark:text-zinc-400">
          {head.map((h) => (
            <th key={h} className="pr-4 pb-1.5 font-medium whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="font-mono text-zinc-800 dark:text-zinc-200">
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-zinc-100 dark:border-zinc-700/60">
            {row.cells.map((cell, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed and never reorder
              <td key={i} className="pr-4 py-1.5 align-top">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function clusterState(cluster: ClusterStatusResponse): string {
  if (!cluster.started) {
    return 'stopped';
  }
  return cluster.status.paused ? 'paused' : 'running';
}

export function SettingsPage() {
  const [cluster, setCluster] = useState<ClusterStatusResponse | null>(null);
  const [health, setHealth] = useState<ClusterDaemonHealthResponse | null>(null);
  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(null);
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, h, t, p] = await Promise.all([
        getClusterStatus(),
        getDaemonHealth(),
        getClusterTemplates(),
        getClusterProjects(),
      ]);
      setCluster(c);
      setHealth(h);
      setTemplates(t);
      setProjects(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const lifecycle = async (action: ClusterLifecycleAction) => {
    try {
      await LIFECYCLE[action]();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-zinc-100 dark:bg-zinc-900">
      <div className="max-w-5xl mx-auto p-4 flex flex-col gap-4">
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

        <Card
          title="Cluster"
          action={
            <LifecycleControls
              started={cluster?.started ?? null}
              paused={cluster?.status.paused ?? false}
              onAction={lifecycle}
            />
          }
        >
          <div className="text-xs font-mono text-zinc-600 dark:text-zinc-300 flex flex-wrap gap-x-6 gap-y-1">
            <span>state {cluster ? clusterState(cluster) : '-'}</span>
            <span>daemon started {formatTimestamp(health?.startedAt)}</span>
          </div>
        </Card>

        <Card title="Worker templates">
          <Table
            head={['name', 'type', 'role', 'command', 'max', 'capabilities', 'cost']}
            rows={(templates?.templates ?? []).map((t) => ({
              key: t.name,
              cells: [t.name, t.type, t.role ?? '-', t.command, t.maxConcurrent, t.capabilities.join(', '), t.costTier],
            }))}
          />
        </Card>

        <Card title="Projects">
          <Table
            head={['alias', 'path', 'type', 'default template', 'description']}
            rows={(projects?.projects ?? []).map((p) => ({
              key: p.alias,
              cells: [
                `${p.alias}${p.isDefault ? ' (default)' : ''}`,
                p.path,
                p.type ?? '-',
                templates?.projectDefaults[p.alias] ?? '-',
                p.description ?? '-',
              ],
            }))}
          />
        </Card>

        <Card
          title="Console"
          action={
            <button
              type="button"
              onClick={() => signOut()}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
            >
              <KeyRound className="w-3.5 h-3.5" />
              更换 token
            </button>
          }
        >
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Token 只存在这个浏览器的 localStorage 里。其余配置在 daemon 的 cluster.jsonc，此处只读。
          </div>
        </Card>
      </div>
    </div>
  );
}
