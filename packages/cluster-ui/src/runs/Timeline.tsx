import { type ReactNode, useState } from 'react';
import { TONE_BG, TONE_TEXT, type Tone } from '../lib/stage';
import { formatClock } from '../lib/time';
import {
  type EndState,
  foldTimeline,
  type RulerGap,
  rulerGap,
  type TimelineItem,
  type TimelineNode,
} from '../lib/timeline';
import { StatusDot } from '../ui/StatusDot';
import { AnswerBox } from './AnswerBox';

const END: Record<EndState, { label: string; tone: Tone }> = {
  completed: { label: '完成', tone: 'done' },
  failed: { label: '失败', tone: 'failed' },
  blocked: { label: '受阻', tone: 'failed' },
  cancelled: { label: '已终止', tone: 'muted' },
};

function RailLine({ upperOnly = false }: { upperOnly?: boolean }) {
  return <span className={`absolute top-0 left-1/2 w-px -translate-x-1/2 bg-line ${upperOnly ? 'h-3' : 'bottom-0'}`} />;
}

function Row({ time, dot, last, children }: { time: string; dot: ReactNode; last: boolean; children: ReactNode }) {
  return (
    <li className="contents">
      <span className="pt-0.5 text-right font-mono text-13 whitespace-nowrap text-ink-muted">{time}</span>
      <span className="relative">
        <RailLine upperOnly={last} />
        <span className="absolute top-3 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center">
          {dot}
        </span>
      </span>
      <div className="min-w-0 pb-3">{children}</div>
    </li>
  );
}

function Ruler({ gap }: { gap: RulerGap }) {
  if (gap.ticks === 0 && gap.foldedMinutes === null) {
    return null;
  }
  return (
    <li className="contents" aria-hidden>
      <span />
      {gap.foldedMinutes !== null ? (
        <>
          <span className="relative">
            <RailLine />
          </span>
          <span className="pb-3 text-13 text-ink-muted">…{gap.foldedMinutes} 分钟…</span>
        </>
      ) : (
        <>
          <span className="ruler relative" style={{ height: gap.ticks * 6 }} />
          <span />
        </>
      )}
    </li>
  );
}

function SmallDot({ tone }: { tone: Tone }) {
  return <span className={`size-1.5 rounded-full ${TONE_BG[tone]}`} />;
}

function Question({ node }: { node: Extract<TimelineNode, { kind: 'question' }> }) {
  return (
    <div>
      <div className={`text-13 font-medium transition-colors ${node.pending ? 'text-attention' : 'text-ink-muted'}`}>
        提问
      </div>
      <p className="text-15 whitespace-pre-wrap break-words">{node.question}</p>
      {node.context && <p className="text-13 whitespace-pre-wrap break-words text-ink-muted">{node.context}</p>}
      <div className="collapsible" data-collapsed={!node.pending}>
        <div>
          <div className="pt-2">
            <AnswerBox askId={node.askId} options={node.options} />
          </div>
        </div>
      </div>
      {!node.pending && <p className="text-13 text-ink-muted">{node.answer ? `回答 · ${node.answer}` : '已回答'}</p>}
    </div>
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
          {node.nextSteps && <p className="text-13 break-words text-ink-muted">下一步 · {node.nextSteps}</p>}
          {node.lockedFiles > 0 && <p className="text-13 text-ink-muted">锁了 {node.lockedFiles} 个文件</p>}
        </div>
      );
    case 'question':
      return <Question node={node} />;
    case 'end': {
      const { label, tone } = END[node.state];
      return (
        <div>
          <div className={`text-15 font-medium ${TONE_TEXT[tone]}`}>{label}</div>
          {node.summary && <p className="text-15 whitespace-pre-wrap break-words">{node.summary}</p>}
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
      return <StatusDot tone={node.pending ? 'attention' : 'working'} />;
    case 'end':
      return <StatusDot tone={END[node.state].tone} />;
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
        <button type="button" onClick={onOpen} className="text-13 text-ink-muted underline">
          展开中间 {count} 个节点
        </button>
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
    <ol className="grid grid-cols-[auto_1rem_minmax(0,1fr)] gap-x-2.5">
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
          <Ruler gap={rulerGap(lastAt, now)} />
          <Row time="" dot={<StatusDot tone="working" breathing />} last>
            <span className="sr-only">进行中</span>
            <span className="block h-4" />
          </Row>
        </>
      )}
    </ol>
  );
}
