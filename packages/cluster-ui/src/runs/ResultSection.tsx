import type { ClusterTaskDetail } from '@qqbot/api-types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getTicketResult, listTicketResults } from '../api';
import { type Route, withRoute } from '../app/route';
import { parseFiles } from '../lib/runs';
import { Section } from '../ui/Section';

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
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1 font-mono text-13 hover:underline"
      >
        <Chevron className="size-4 shrink-0" />
        {file}
      </button>
      {open && error && <p className="mt-1 text-13 text-failed">{error}</p>}
      {open && !error && content === null && <p className="mt-1 text-13 text-ink-muted">读取中…</p>}
      {open && content !== null && (
        <pre className="mt-1 max-h-96 overflow-auto rounded-ui bg-surface-2 p-3 text-13 whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </li>
  );
}

export function ResultSection({
  task,
  ticketId,
  route,
  live,
}: {
  task: ClusterTaskDetail;
  ticketId?: string;
  route: Route;
  live: boolean;
}) {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (ticketId) {
      listTicketResults(ticketId).then(
        (names) => setFiles(names.filter((n) => !HIDDEN_RESULTS.has(n))),
        () => {},
      );
    }
  }, [ticketId]);

  const changed = parseFiles(task.filesModified);
  const empty = !task.diffSummary && !task.error && changed.length === 0 && !ticketId;
  if (empty) {
    return (
      <p className="text-14 text-ink-muted">{live ? '运行结束后，结果会出现在这里。' : '这条运行没有留下结果。'}</p>
    );
  }
  return (
    <Section title="结果">
      {task.diffSummary && <p className="text-15 whitespace-pre-wrap break-words">{task.diffSummary}</p>}
      {task.error && <p className="text-15 whitespace-pre-wrap break-words text-failed">{task.error}</p>}
      {changed.length > 0 && (
        <div className="mt-2">
          <div className="text-14 text-ink-muted">改了 {changed.length} 个文件</div>
          <ul className="font-mono text-13 break-all">
            {changed.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
      {ticketId && (
        <div className="mt-2">
          <p className="text-14 text-ink-muted">
            写回了 ticket{' '}
            <a href={withRoute(route, { ticket: ticketId })} className="font-mono text-13 text-ink underline">
              {ticketId}
            </a>
          </p>
          {files.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {files.map((file) => (
                <ResultFile key={file} ticketId={ticketId} file={file} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
