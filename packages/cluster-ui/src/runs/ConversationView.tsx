import type { ClusterEventEntry, ClusterTask } from '@qqbot/api-types';
import { MessageCircleQuestion } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCluster } from '../app/ClusterData';
import {
  buildConversation,
  type ConversationEntry,
  type ConversationItem,
  foldConversation,
} from '../lib/conversation';
import { TONE_BG, TONE_TEXT, type Tone } from '../lib/stage';
import { formatClock } from '../lib/time';
import type { EndState, ReportStats } from '../lib/timeline';
import { Button } from '../ui/Button';
import { StatePill } from '../ui/StatePill';
import { StatusDot } from '../ui/StatusDot';
import { AnswerBox } from './AnswerBox';
import { MessageBox } from './MessageBox';

const END: Record<EndState, { label: string; tone: Tone }> = {
  completed: { label: '完成', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
  blocked: { label: '受阻', tone: 'failed' },
  cancelled: { label: '已终止', tone: 'muted' },
};

const END_BORDER: Record<Tone, string> = {
  attention: 'border-attention',
  working: 'border-working',
  done: 'border-done',
  failed: 'border-failed',
  muted: 'border-line',
};

const FILES_SHOWN = 3;

function FileList({ files }: { files: string[] }) {
  if (files.length === 0) {
    return null;
  }
  const rest = files.length - FILES_SHOWN;
  return (
    <p className="truncate font-mono text-13 text-ink-muted">
      文件：{files.slice(0, FILES_SHOWN).join('、')}
      {rest > 0 && ` 等 ${files.length} 个`}
    </p>
  );
}

function StatsLine({ stats }: { stats?: ReportStats }) {
  if (!stats) {
    return null;
  }
  return (
    <p className="flex gap-3 text-13 text-ink-muted tabular-nums">
      {stats.linesAdded !== undefined && <span className="text-done">+{stats.linesAdded}</span>}
      {stats.linesRemoved !== undefined && <span className="text-failed">-{stats.linesRemoved}</span>}
      {stats.testsRan !== undefined && (
        <span>
          测试 {stats.testsPassed ?? 0}/{stats.testsRan}
        </span>
      )}
    </p>
  );
}

function Stamp({ at, now }: { at: number; now: number }) {
  return <span className="font-mono text-12 text-ink-muted">{formatClock(at, now)}</span>;
}

function Entry({ entry, now }: { entry: ConversationEntry; now: number }) {
  switch (entry.kind) {
    case 'owner':
      return (
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-2">
            <Stamp at={entry.at} now={now} />
            <span className="text-12 text-ink-muted">我</span>
          </div>
          <p className="max-w-[85%] rounded-ui bg-surface-2 px-3 py-2 text-15 whitespace-pre-wrap break-words">
            {entry.text}
          </p>
        </div>
      );
    case 'report':
      return (
        <div className="flex gap-2">
          <span className="mt-2 shrink-0">
            <StatusDot tone="working" />
          </span>
          <div className="min-w-0 flex-1">
            <Stamp at={entry.at} now={now} />
            <p className="text-15 whitespace-pre-wrap break-words">{entry.summary}</p>
            {entry.nextSteps && (
              <p className="text-14 whitespace-pre-wrap break-words text-ink-muted">→ {entry.nextSteps}</p>
            )}
            <FileList files={entry.files} />
            <StatsLine stats={entry.stats} />
          </div>
        </div>
      );
    case 'question':
      return (
        <div
          className={`rounded-ui border p-3 ${entry.pending ? 'border-attention/35 bg-attention/8' : 'border-line bg-surface-2'}`}
        >
          <div className="flex items-center gap-2">
            <StatePill tone={entry.pending ? 'attention' : 'muted'} label="提问" icon={MessageCircleQuestion} />
            <Stamp at={entry.at} now={now} />
          </div>
          <p className="mt-2 text-15 whitespace-pre-wrap break-words">{entry.question}</p>
          {entry.context && (
            <p className="mt-1 text-14 whitespace-pre-wrap break-words text-ink-muted">{entry.context}</p>
          )}
          {entry.pending ? (
            <div className="pt-2">
              <AnswerBox askId={entry.askId} options={entry.options} />
            </div>
          ) : (
            <p className="mt-2 text-14 whitespace-pre-wrap break-words">
              <span className="text-ink-muted">
                {[entry.answeredBy, entry.answeredAt !== undefined && formatClock(entry.answeredAt, now)]
                  .filter(Boolean)
                  .join(' · ') || '已回答'}{' '}
                回答：
              </span>
              {entry.answer}
            </p>
          )}
        </div>
      );
    case 'end': {
      const { label, tone } = END[entry.state];
      return (
        <div className={`rounded-ui border-l-2 bg-surface-2 p-3 ${END_BORDER[tone]}`}>
          <div className="flex items-center gap-2">
            <span className={`text-16 font-medium ${TONE_TEXT[tone]}`}>{label}</span>
            <Stamp at={entry.at} now={now} />
          </div>
          {entry.summary && <p className="mt-1 text-15 whitespace-pre-wrap break-words">{entry.summary}</p>}
          <StatsLine stats={entry.stats} />
        </div>
      );
    }
    case 'system':
      return (
        <p className="flex items-center gap-2 text-13 text-ink-muted">
          <span className={`size-1.5 shrink-0 rounded-full ${TONE_BG.muted}`} />
          <span className="font-mono text-12">{formatClock(entry.at, now)}</span>
          {entry.seq !== undefined && <span className="font-mono text-12">#{entry.seq}</span>}
          <span className="min-w-0 break-words">{entry.text}</span>
        </p>
      );
  }
}

export function ConversationView({
  task,
  events,
  now,
}: {
  task: ClusterTask;
  events: ClusterEventEntry[];
  now: number;
}) {
  const { loaded, help, helpHistory, workerExits } = useCluster();
  const [opened, setOpened] = useState<Set<string>>(() => new Set());

  // Until the shared load lands, every pending question would read as already answered.
  const entries = useMemo(
    () =>
      loaded
        ? buildConversation({
            task,
            events,
            help,
            helpHistory,
            workerExitedAt: task.workerId ? workerExits.get(task.workerId) : undefined,
            children: [],
          })
        : [],
    [loaded, task, events, help, helpHistory, workerExits],
  );

  const items: ConversationItem[] = foldConversation(entries).flatMap((item) =>
    item.fold && opened.has(item.id) ? item.entries.map((entry) => ({ fold: false as const, entry })) : [item],
  );

  return (
    <div>
      <div className="flex flex-col gap-3 pb-4">
        {items.map((item) =>
          item.fold ? (
            <Button
              key={item.id}
              variant="quiet"
              className="self-start text-13"
              onClick={() => setOpened((prev) => new Set(prev).add(item.id))}
            >
              展开中间 {item.entries.length} 条
            </Button>
          ) : (
            <Entry key={item.entry.id} entry={item.entry} now={now} />
          ),
        )}
      </div>
      <MessageBox task={task} />
    </div>
  );
}
