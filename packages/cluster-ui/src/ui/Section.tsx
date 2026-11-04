import type { ReactNode } from 'react';

/** A titled block of a page; hierarchy comes from the spacing and the title's weight, not a border. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-13 font-medium text-ink-muted">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
