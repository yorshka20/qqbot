import { Check, Copy, FileText, OctagonX, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Markdown } from '../../components/Markdown';
import { Button } from '../../components/ui/button';
import { copyText } from '../../lib/clipboard';
import type { ConversationEntry } from '../../lib/conversation';
import { withOverlay } from '../../lib/routes';
import { formatClock } from '../../lib/time';
import type { EndState } from '../../lib/timeline';
import { cn } from '../../lib/utils';

type Entry = Extract<ConversationEntry, { kind: 'end' }>;

const END_LABEL: Record<EndState, string> = {
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已终止',
};

const END_STYLE: Record<EndState, string> = {
  completed: 'border-done/40 bg-done/10',
  failed: 'border-failed/40 bg-failed/10',
  blocked: 'border-failed/40 bg-failed/10',
  cancelled: 'bg-card',
};

const END_TEXT: Record<EndState, string> = {
  completed: 'text-done',
  failed: 'text-failed',
  blocked: 'text-failed',
  cancelled: 'text-muted-foreground',
};

function CopyReason({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <Button variant="ghost" size="xs" onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {copied ? '已复制' : '复制原因'}
    </Button>
  );
}

export function EndCard({ entry, ticketId, now }: { entry: Entry; ticketId?: string; now: number }) {
  const location = useLocation();
  const Icon = entry.state === 'completed' ? Check : entry.state === 'cancelled' ? OctagonX : TriangleAlert;
  return (
    <div className={cn('rounded-lg border p-3 text-card-foreground', END_STYLE[entry.state])}>
      <div className={cn('mb-1 flex items-center gap-1.5 text-sm font-medium', END_TEXT[entry.state])}>
        <Icon className="size-4" />
        {END_LABEL[entry.state]}
        <span className="text-xs font-normal text-muted-foreground">· {formatClock(entry.at, now)}</span>
      </div>
      {entry.summary && <Markdown>{entry.summary}</Markdown>}
      {entry.reason && entry.reason !== entry.summary && (
        <div className="mt-2 rounded-md border border-failed/40 bg-background p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs text-failed">失败原因</span>
            <CopyReason text={entry.reason} />
          </div>
          <pre className="max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap break-words">{entry.reason}</pre>
        </div>
      )}
      {entry.files.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground">改了 {entry.files.length} 个文件</div>
          <ul className="mt-1 font-mono text-xs break-all">
            {entry.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
      {ticketId && (
        <Button variant="outline" size="sm" className="mt-2" asChild>
          <Link
            to={{ pathname: location.pathname, search: withOverlay(location.search, { ticket: { id: ticketId } }) }}
          >
            <FileText />
            查看 ticket {ticketId}
          </Link>
        </Button>
      )}
    </div>
  );
}
