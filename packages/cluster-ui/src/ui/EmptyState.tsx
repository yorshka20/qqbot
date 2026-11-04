import type { ReactElement, ReactNode } from 'react';

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="flex flex-col items-center gap-1.5 opacity-60">
        <span className="h-2 w-24 rounded-ui bg-line" />
        <span className="h-2 w-16 rounded-ui bg-line" />
        <span className="h-2 w-20 rounded-ui bg-line" />
      </div>
      <p className="text-15">{title}</p>
      {hint ? <p className="text-14 text-ink-muted">{hint}</p> : null}
      {action}
    </div>
  );
}
