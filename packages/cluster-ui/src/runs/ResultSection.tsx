import type { ClusterTaskDetail } from '@qqbot/api-types';
import { useEffect, useState } from 'react';
import { listTicketResults } from '../api';
import { type Route, withRoute } from '../app/route';
import { parseFiles } from '../lib/runs';
import { Section } from '../ui/Section';

/** `job.json` is the machine-readable snapshot, not something to read. */
const HIDDEN_RESULTS = new Set(['job.json']);

export function ResultSection({ task, ticketId, route }: { task: ClusterTaskDetail; ticketId?: string; route: Route }) {
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
  if (!task.diffSummary && !task.error && changed.length === 0 && !ticketId) {
    return null;
  }
  return (
    <Section title="结果">
      {task.diffSummary && <p className="text-15 whitespace-pre-wrap break-words">{task.diffSummary}</p>}
      {task.error && <p className="text-15 whitespace-pre-wrap break-words text-failed">{task.error}</p>}
      {changed.length > 0 && (
        <div className="mt-2">
          <div className="text-13 text-ink-muted">改了 {changed.length} 个文件</div>
          <ul className="font-mono text-13 break-all">
            {changed.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
      {ticketId && (
        <p className="mt-2 text-13 text-ink-muted">
          写回了 ticket{' '}
          <a href={withRoute(route, { ticket: ticketId })} className="text-ink underline">
            {ticketId}
          </a>
          {files.map((file) => (
            <span key={file}>
              {' · '}
              <a href={withRoute(route, { ticket: ticketId, ticketFile: file })} className="text-ink underline">
                {file}
              </a>
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}
