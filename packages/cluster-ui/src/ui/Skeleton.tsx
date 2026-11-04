import type { ReactElement } from 'react';

const ROW_WIDTHS = ['w-[70%]', 'w-[90%]', 'w-[55%]'];

export function SkeletonRows({ rows = 3 }: { rows?: number }): ReactElement {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows are positional and have no identity
        <span key={i} className={`h-4 rounded-ui bg-line/60 ${ROW_WIDTHS[i % ROW_WIDTHS.length]}`} />
      ))}
    </div>
  );
}
