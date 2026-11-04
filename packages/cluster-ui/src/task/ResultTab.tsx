import type { ClusterTaskDetail } from '@qqbot/api-types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getTicketResult, listTicketResults } from '../api';
import { useCluster } from '../app/ClusterData';
import { Markdown } from '../components/Markdown';
import { StageBadge } from '../components/StageBadge';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { failureReason } from '../lib/conversation';
import { modelShortName } from '../lib/model';
import { workerPath } from '../lib/routes';
import { parseFiles, runTitle } from '../lib/runs';
import { stageOfStatus } from '../lib/stage';

/** `job.json` is the machine-readable snapshot, not something to read. */
const HIDDEN_RESULTS = new Set(['job.json']);

function ResultFile({ ticketId, file }: { ticketId: string; file: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || content !== null) {
      return;
    }
    getTicketResult(ticketId, file).then(setContent, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [open, content, ticketId, file]);

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="font-mono">
          <Chevron />
          {file}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {error && <p className="mt-1 text-xs text-failed">{error}</p>}
        {!error && content === null && <p className="mt-1 text-xs text-muted-foreground">读取中…</p>}
        {content !== null &&
          (file.endsWith('.md') ? (
            <div className="mt-1 max-h-96 overflow-auto rounded-md border bg-card p-3">
              <Markdown>{content}</Markdown>
            </div>
          ) : (
            <pre className="mt-1 max-h-96 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">
              {content}
            </pre>
          ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ResultTab({
  task,
  rootId,
  ticketId,
  output,
  live,
}: {
  task: ClusterTaskDetail;
  rootId: string;
  ticketId?: string;
  output: string;
  live: boolean;
}) {
  const { runs } = useCluster();
  const [resultFiles, setResultFiles] = useState<string[]>([]);

  useEffect(() => {
    if (ticketId) {
      listTicketResults(ticketId).then(
        (names) => setResultFiles(names.filter((name) => !HIDDEN_RESULTS.has(name))),
        () => setResultFiles([]),
      );
    }
  }, [ticketId]);

  const files = parseFiles(task.filesModified);
  const failed = task.status === 'failed' || task.status === 'blocked';
  const reason = failed ? failureReason({ output, taskError: task.error }) : undefined;
  const children = task.children ?? [];
  const empty = !task.diffSummary && !reason && files.length === 0 && resultFiles.length === 0 && children.length === 0;

  if (empty) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {live ? '运行结束后，结果会出现在这里。' : '这条运行没有留下结果。'}
      </p>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-3 py-4 md:px-6">
      {task.diffSummary && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">摘要</h2>
          <div className="rounded-lg border bg-card p-3">
            <Markdown>{task.diffSummary}</Markdown>
          </div>
        </section>
      )}
      {reason && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-failed">失败原因</h2>
          <pre className="max-h-64 overflow-auto rounded-lg border border-failed/40 bg-failed/10 p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {reason}
          </pre>
        </section>
      )}
      {files.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">改了 {files.length} 个文件</h2>
          <ul className="font-mono text-xs break-all">
            {files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </section>
      )}
      {ticketId && resultFiles.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">ticket {ticketId} 的结果文件</h2>
          <div className="flex flex-col gap-1">
            {resultFiles.map((file) => (
              <ResultFile key={file} ticketId={ticketId} file={file} />
            ))}
          </div>
        </section>
      )}
      {children.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">派生了 {children.length} 条子运行</h2>
          <ul className="flex flex-col gap-1">
            {children.map((child) => {
              const stage = runs.find((run) => run.task.id === child.id)?.stage ?? stageOfStatus(child.status);
              return (
                <li key={child.id}>
                  <Button variant="ghost" className="h-auto w-full justify-start gap-2 py-1.5" asChild>
                    <Link to={workerPath(rootId, child.id)}>
                      <StageBadge stage={stage} />
                      <span className="min-w-0 flex-1 truncate text-left">{runTitle(child.description)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{modelShortName(child.model)}</span>
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
