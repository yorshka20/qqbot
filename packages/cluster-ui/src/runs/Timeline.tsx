import { MessageCircleQuestion } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { TONE_BG, TONE_TEXT, type Tone } from '../lib/stage';
import { formatClock } from '../lib/time';
import {
  type EndState,
  foldTimeline,
  type ReportStats,
  type RulerGap,
  rulerGap,
  rulerMinutesLabel,
  type TimelineItem,
  type TimelineNode,
} from '../lib/timeline';
import { Button } from '../ui/Button';
import { StatePill } from '../ui/StatePill';
import { StatusDot } from '../ui/StatusDot';
import { AnswerBox } from './AnswerBox';

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

type RailTone = 'line' | 'working';

const RAIL_TONE: Record<RailTone, string> = {
  line: 'bg-line',
  working: 'bg-working/50',
};

function RailLine({ upperOnly = false, tone = 'line' }: { upperOnly?: boolean; tone?: RailTone }) {
  return (
    <span
      className={`absolute top-0 left-1/2 w-0.5 -translate-x-1/2 ${RAIL_TONE[tone]} ${upperOnly ? 'h-3' : 'bottom-0'}`}
    />
  );
}

function Row({
  time,
  dot,
  last,
  railTone,
  children,
}: {
  time: string;
  dot: ReactNode;
  last: boolean;
  railTone?: RailTone;
  children: ReactNode;
}) {
  return (
    <li className="contents">
      <span className="pt-0.5 text-right font-mono text-13 whitespace-nowrap text-ink-muted">{time}</span>
      <span className="relative">
        <RailLine upperOnly={last} tone={railTone} />
        <span className="absolute top-3 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center">
          {dot}
        </span>
      </span>
      <div className="min-w-0 pb-3">{children}</div>
    </li>
  );
}

function Ruler({ gap, tone }: { gap: RulerGap; tone?: RailTone }) {
  if (gap.ticks === 0 && gap.foldedMinutes === null) {
    return null;
  }
  return (
    <li className="contents" aria-hidden>
      <span />
      {gap.foldedMinutes !== null ? (
        <>
          <span className="relative">
            <RailLine tone={tone} />
          </span>
          <span className="pb-3 text-12 text-ink-muted">…{gap.foldedMinutes} 分钟…</span>
        </>
      ) : (
        <>
          <span className="ruler relative" style={{ height: gap.ticks * 6 }} />
          <span className="pb-3 text-12 text-ink-muted">{rulerMinutesLabel(gap.ticks)}</span>
        </>
      )}
    </li>
  );
}

function SmallDot({ tone }: { tone: Tone }) {
  return <span className={`size-1.5 rounded-full ${TONE_BG[tone]}`} />;
}

function QuestionDot() {
  return <span className="size-3 rounded-full bg-attention ring-2 ring-attention/40" />;
}

function EndDot({ tone }: { tone: Tone }) {
  return <span className={`size-3 rounded-ui ${TONE_BG[tone]}`} />;
}

function Question({ node }: { node: Extract<TimelineNode, { kind: 'question' }> }) {
  const cardClass = node.pending
    ? 'rounded-ui border border-attention/35 bg-attention/8 p-3'
    : 'rounded-ui border border-line bg-surface-2 p-3';
  return (
    <div className={cardClass}>
      <StatePill tone={node.pending ? 'attention' : 'muted'} label="提问" icon={MessageCircleQuestion} />
      <p className="mt-2 text-15 whitespace-pre-wrap break-words">{node.question}</p>
      {node.context && <p className="mt-1 text-14 whitespace-pre-wrap break-words text-ink-muted">{node.context}</p>}
      <div className="collapsible" data-collapsed={!node.pending}>
        <div>
          <div className="pt-2">
            <AnswerBox askId={node.askId} options={node.options} />
          </div>
        </div>
      </div>
      {!node.pending && (
        <p className="mt-2 text-13 text-ink-muted">{node.answer ? `回答 · ${node.answer}` : '已回答'}</p>
      )}
    </div>
  );
}

const FILES_SHOWN = 3;

function FileList({ files }: { files: string[] }) {
  if (files.length === 0) {
    return null;
  }
  const shown = files.slice(0, FILES_SHOWN).join('、');
  const rest = files.length - FILES_SHOWN;
  return (
    <p className="truncate font-mono text-13 text-ink-muted">
      文件：{shown}
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

function NodeBody({ node }: { node: TimelineNode }) {
  switch (node.kind) {
    case 'note':
      return <p className="pt-0.5 text-13 break-words text-ink-muted">{node.text}</p>;
    case 'progress':
      return (
        <div>
          <p className="text-15 whitespace-pre-wrap break-words">{node.summary}</p>
          {node.nextSteps && <p className="text-14 break-words text-working">→ {node.nextSteps}</p>}
          <FileList files={node.files} />
          <StatsLine stats={node.stats} />
          {node.lockedFiles > 0 && <p className="text-13 text-ink-muted">锁了 {node.lockedFiles} 个文件</p>}
        </div>
      );
    case 'question':
      return <Question node={node} />;
    case 'end': {
      const { label, tone } = END[node.state];
      return (
        <div className={`rounded-ui border-l-2 bg-surface-2 p-3 ${END_BORDER[tone]}`}>
          <div className={`text-16 font-medium ${TONE_TEXT[tone]}`}>{label}</div>
          {node.summary && <p className="mt-1 text-15 whitespace-pre-wrap break-words">{node.summary}</p>}
          <StatsLine stats={node.stats} />
        </div>
      );
    }
  }
}

function nodeDot(node: TimelineNode): ReactNode {
  switch (node.kind) {
    case 'note':
      return <SmallDot tone="muted" />;
    case 'progress':
      return <StatusDot tone="working" />;
    case 'question':
      return node.pending ? <QuestionDot /> : <StatusDot tone="working" />;
    case 'end':
      return <EndDot tone={END[node.state].tone} />;
  }
}

function Fold({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <li className="contents">
      <span />
      <span className="relative">
        <RailLine />
      </span>
      <div className="pb-3">
        <Button variant="quiet" className="text-13" onClick={onOpen}>
          展开中间 {count} 个节点
        </Button>
      </div>
    </li>
  );
}

export function Timeline({ nodes, live, now }: { nodes: TimelineNode[]; live: boolean; now: number }) {
  const [unfolded, setUnfolded] = useState(false);
  const items: TimelineItem[] = unfolded ? nodes.map((node) => ({ fold: false, node })) : foldTimeline(nodes);
  const lastAt = nodes.at(-1)?.at;
  let previous: TimelineNode | undefined;

  return (
    <ol className="grid grid-cols-[auto_1.5rem_minmax(0,1fr)] gap-x-3">
      {items.map((item, index) => {
        if (item.fold) {
          previous = undefined;
          return <Fold key={item.id} count={item.count} onOpen={() => setUnfolded(true)} />;
        }
        const { node } = item;
        const before = previous;
        previous = node;
        return [
          before && <Ruler key={`gap:${node.id}`} gap={rulerGap(before.at, node.at)} />,
          <Row
            key={node.id}
            time={formatClock(node.at, now)}
            dot={nodeDot(node)}
            last={!live && index === items.length - 1}
          >
            <NodeBody node={node} />
          </Row>,
        ];
      })}
      {live && lastAt !== undefined && (
        <>
          <Ruler gap={rulerGap(lastAt, now)} tone="working" />
          <Row time="" dot={<StatusDot tone="working" breathing />} last railTone="working">
            <span className="text-14 text-working">在跑</span>
          </Row>
        </>
      )}
    </ol>
  );
}
