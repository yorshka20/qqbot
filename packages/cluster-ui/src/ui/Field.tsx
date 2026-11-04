import type { ReactNode, SelectHTMLAttributes } from 'react';

export const INPUT_CLASS =
  'w-full rounded-ui bg-surface-2 px-2.5 py-1.5 text-15 text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-2 focus-visible:outline-working';

export function Select({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-13 text-ink-muted">{label}</span>
      <select className={`${INPUT_CLASS} text-13`} {...props}>
        {children}
      </select>
    </label>
  );
}
