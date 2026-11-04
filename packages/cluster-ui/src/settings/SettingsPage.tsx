import { useState } from 'react';
import { pauseCluster, resumeCluster, startCluster, stopCluster } from '../api';
import { useCluster } from '../app/ClusterData';
import { routeHref } from '../app/route';
import { setTheme, type ThemeChoice, useThemeChoice } from '../app/theme';
import { signOut } from '../auth/session';
import { ModelName } from '../runs/RunFacts';
import { Button, ConfirmButton } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Section } from '../ui/Section';
import { SkeletonRows } from '../ui/Skeleton';

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-15">
      <span className="w-24 shrink-0 text-13 break-words text-ink-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function SettingsPage() {
  const { cluster, health, templates, projects, refresh } = useCluster();
  const theme = useThemeChoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const started = cluster?.started === true;
  const paused = cluster?.status.paused === true;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const schedulingState = !started ? '已停止' : paused ? '已暂停' : '运行中';

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface p-5 md:p-8">
      <div className="max-w-3xl">
        <h1 className="mb-6 text-18 font-medium">设置</h1>
        <Section title="调度">
          <Fact label="状态">{schedulingState}</Fact>
          {health && <Fact label="daemon 启动于">{new Date(health.startedAt).toLocaleString('zh-CN')}</Fact>}
          <div className="mt-2 -ml-2.5 flex flex-wrap gap-0.5">
            {started ? (
              <>
                <Button disabled={busy} onClick={() => act(paused ? resumeCluster : pauseCluster)}>
                  {paused ? '恢复调度' : '暂停调度'}
                </Button>
                <ConfirmButton
                  label="停止调度"
                  confirmLabel="确认停止"
                  disabled={busy}
                  onConfirm={() => act(stopCluster)}
                />
              </>
            ) : (
              <Button disabled={busy} onClick={() => act(startCluster)}>
                启动调度
              </Button>
            )}
          </div>
          {error && <p className="mt-1 text-14 text-failed">操作没有成功：{error}。确认 daemon 在线后再试一次。</p>}
        </Section>
        <Section title="项目">
          {!projects ? (
            <SkeletonRows rows={2} />
          ) : projects.projects.length === 0 ? (
            <EmptyState title="还没有配置项目。" />
          ) : (
            projects.projects.map((project) => (
              <Fact key={project.alias} label={project.isDefault ? `${project.alias}（默认）` : project.alias}>
                <span className="font-mono text-13 break-all">{project.path}</span>
              </Fact>
            ))
          )}
          <a href={routeHref({ section: 'projects' })} className="mt-1 inline-block text-13 text-ink-muted underline">
            看各项目的运行
          </a>
        </Section>
        <Section title="模板与并发">
          {!templates ? (
            <SkeletonRows rows={2} />
          ) : templates.templates.length === 0 ? (
            <EmptyState title="还没有配置模板。" />
          ) : (
            templates.templates.map((template) => (
              <Fact key={template.name} label={template.name}>
                <span className="text-13">
                  {template.type} · {template.role === 'planner' ? '规划' : '执行'} · 并发 {template.maxConcurrent} ·
                  成本 {template.costTier}
                </span>
                {template.model && <ModelName id={template.model} className="block text-13 text-ink-muted" />}
              </Fact>
            ))
          )}
        </Section>
        <Section title="外观">
          <div className="-ml-2.5 flex gap-0.5">
            {THEMES.map(({ value, label }) => (
              <Button
                key={value}
                onClick={() => setTheme(value)}
                aria-pressed={theme === value}
                className={theme === value ? 'bg-surface-2' : ''}
              >
                {label}
              </Button>
            ))}
          </div>
        </Section>
        <Section title="这台设备">
          <div className="-ml-2.5">
            <Button onClick={() => signOut()}>退出控制台</Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
