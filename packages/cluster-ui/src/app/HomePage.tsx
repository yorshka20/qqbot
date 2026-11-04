import { Inbox, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { StageBadge } from '../components/StageBadge';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { useIsMobile } from '../hooks/use-mobile';
import { buildHome } from '../lib/home';
import type { InboxItem } from '../lib/inbox';
import { modelShortName } from '../lib/model';
import { inboxPath, settingsPath, taskPath } from '../lib/routes';
import type { Run } from '../lib/runs';
import { spareSlots } from '../lib/slots';
import { STAGE_TONE } from '../lib/stage';
import { pathOfRun, type TaskListItem } from '../lib/taskList';
import { formatAgo, formatSpan, formatWait } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useCluster } from './ClusterData';
import { TaskListPanel } from './TaskListPanel';

function CompactRow({ item, now }: { item: TaskListItem; now: number }) {
  const { root } = item;
  const clock = root.stage === 'running' ? formatSpan(now - root.since) : formatAgo(now - root.since);
  return (
    <Link to={taskPath(root.task.id)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted">
      <StatusDot tone={STAGE_TONE[root.stage]} breathing={root.stage === 'running'} />
      <span className="min-w-0 flex-1 truncate">{root.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {modelShortName(root.task.model)} · {clock}
      </span>
    </Link>
  );
}

function attentionHref(item: InboxItem, runs: Run[]): string {
  if (item.kind === 'ask') {
    return item.run ? pathOfRun(item.run, runs) : inboxPath();
  }
  return pathOfRun(item.run, runs);
}

function AttentionCard({ item, href, now }: { item: InboxItem; href: string; now: number }) {
  const title = item.kind === 'ask' ? (item.run?.title ?? item.help.question) : item.run.title;
  const Icon = item.kind === 'failed' ? TriangleAlert : MessageCircleQuestion;
  const tone = item.kind === 'failed' ? 'text-failed' : 'text-attention';
  return (
    <Link to={href} className="flex items-start gap-3 rounded-lg border bg-card p-3 hover:bg-muted">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {item.kind === 'ask' ? (
          <span className="line-clamp-2 text-sm text-muted-foreground">{item.help.question}</span>
        ) : (
          <span className="block text-sm text-muted-foreground">
            {item.kind === 'failed' ? '运行失败，等你处理' : '已完成，等你查看'}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.kind === 'ask' ? formatWait(now - item.since) : formatAgo(now - item.since)}
      </span>
    </Link>
  );
}

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-2">
      <h2 className="px-3 text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function HomePage() {
  const { runs, help, templates, workers, loaded } = useCluster();
  const now = useNow();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const spare = useMemo(() => spareSlots(templates, workers), [templates, workers]);
  const home = useMemo(() => buildHome(runs, help, spare, now), [runs, help, spare, now]);

  if (!loaded) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const { totals } = home;
  const idle = home.running.length === 0 && home.endedToday.length === 0 && home.attention.length === 0;

  return (
    <div className="mx-auto w-full max-w-measure space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => document.getElementById('home-running')?.scrollIntoView({ block: 'start' })}
        >
          在跑 {totals.running}
        </Button>
        <span className="text-muted-foreground">·</span>
        <Button variant="ghost" size="sm" onClick={() => navigate(inboxPath())}>
          等你 {totals.asking}
        </Button>
        <span className="text-muted-foreground">·</span>
        <Button variant="ghost" size="sm" onClick={() => navigate(settingsPath('concurrency'))}>
          排队 {totals.queued}
        </Button>
        <span className="text-muted-foreground">·</span>
        <Button variant="ghost" size="sm" onClick={() => navigate(settingsPath('concurrency'))}>
          空闲槽 ≤{totals.idle}
        </Button>
      </div>

      {home.attention.length > 0 && (
        <Section title="等你处理">
          <div className="space-y-2">
            {home.attention.map((item) => (
              <AttentionCard key={item.key} item={item} now={now} href={attentionHref(item, runs)} />
            ))}
          </div>
          {home.moreAttention > 0 && (
            <Button variant="outline" size="sm" onClick={() => navigate(inboxPath())}>
              <Inbox />
              查看全部（还有 {home.moreAttention} 条）
            </Button>
          )}
        </Section>
      )}

      {isMobile ? (
        <TaskListPanel keys={false} />
      ) : (
        <>
          {home.running.length > 0 && (
            <Section id="home-running" title="在跑">
              <div>
                {home.running.map((item) => (
                  <CompactRow key={item.root.task.id} item={item} now={now} />
                ))}
              </div>
            </Section>
          )}
          {home.endedToday.length > 0 && (
            <Section title="今天结束">
              <div>
                {home.endedToday.map((item) => (
                  <div key={item.root.task.id} className="flex items-center">
                    <div className="min-w-0 flex-1">
                      <CompactRow item={item} now={now} />
                    </div>
                    <StageBadge stage={item.root.stage} className="mr-3" />
                  </div>
                ))}
              </div>
            </Section>
          )}
          {idle && <p className="px-3 text-sm text-muted-foreground">现在没有在跑的对话，点左侧「新任务」开始。</p>}
        </>
      )}
    </div>
  );
}
