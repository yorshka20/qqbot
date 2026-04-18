import { HelpCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { answerClusterHelpRequest } from '../../../api';
import type { ClusterHelpRequest } from '../../../types';

export function HelpRequestRow({ request, onAnswered }: { request: ClusterHelpRequest; onAnswered: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await answerClusterHelpRequest(request.id, {
        answer: answer.trim(),
        answeredBy: 'webui',
      });
      setAnswer('');
      setExpanded(false);
      onAnswered();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [answer, request.id, onAnswered]);

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <HelpCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{request.id.slice(0, 8)}</div>
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-200/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
              {request.type}
            </span>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">from {request.workerId}</div>
          </div>
          <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">{request.question}</div>
          {request.context && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">{request.context}</div>
          )}
          {request.options && request.options.length > 0 && (
            <ul className="mt-1 text-xs text-zinc-700 dark:text-zinc-200 list-decimal list-inside">
              {request.options.map((opt) => (
                <li key={opt}>{opt}</li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            {!expanded ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="px-2 py-1 rounded text-xs font-medium border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
              >
                Reply
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm"
                  placeholder="Your answer to the worker..."
                  disabled={submitting}
                />
                {localError && <div className="text-xs text-red-600 dark:text-red-400">{localError}</div>}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitting || !answer.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                  >
                    {submitting ? 'Sending...' : 'Send answer'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExpanded(false);
                      setAnswer('');
                      setLocalError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                  >
                    Cancel
                  </button>
                  <div className="flex-1" />
                  <div className="text-xs text-zinc-400 dark:text-zinc-500">answeredBy=webui</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
