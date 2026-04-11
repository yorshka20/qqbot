import { Send } from 'lucide-react';

/**
 * Modal that lets the user type a free-form prompt and dispatch it to a
 * specific LAN client. The text is fed into the client's command/AI
 * pipeline as if it had been typed locally — equivalent to issuing
 * `/lan @<clientId> ...` from the host's IM.
 *
 * Click-outside and Escape both close, but only when not currently
 * submitting (avoid losing the user's text mid-flight).
 */
export function DispatchDialog({
  clientId,
  text,
  onTextChange,
  submitting,
  onCancel,
  onSubmit,
}: {
  clientId: string;
  text: string;
  onTextChange: (value: string) => void;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => {
        if (!submitting) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !submitting) onCancel();
      }}
    >
      <div
        className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl p-5 w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="font-semibold mb-1">
          Dispatch to <span className="font-mono">{clientId}</span>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          The text below is fed into the client's command/AI pipeline as if you'd typed
          <code className="mx-1 px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 font-mono">
            /lan @{clientId} ...
          </code>
          on the host's IM.
        </div>
        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="e.g. /status, or any natural-language prompt"
          className="w-full h-32 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          disabled={submitting}
          autoFocus
        />
        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !text.trim()}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Sending…' : 'Dispatch'}
          </button>
        </div>
      </div>
    </div>
  );
}
