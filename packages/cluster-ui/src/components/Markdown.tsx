import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '../lib/utils';

const COMPONENTS: Components = {
  p: ({ node: _node, className, ...props }) => <p className={cn('my-2 first:mt-0 last:mb-0', className)} {...props} />,
  ul: ({ node: _node, className, ...props }) => (
    <ul className={cn('my-2 list-disc space-y-1 pl-5', className)} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn('my-2 list-decimal space-y-1 pl-5', className)} {...props} />
  ),
  li: ({ node: _node, ...props }) => <li {...props} />,
  a: ({ node: _node, className, ...props }) => (
    <a
      className={cn('text-foreground underline underline-offset-2 hover:text-muted-foreground', className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  h1: ({ node: _node, ...props }) => <h3 className="mt-4 mb-2 text-lg font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h5 className="mt-3 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h6 className="mt-3 mb-1 text-sm font-medium first:mt-0" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words', className)} {...props} />
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('min-w-0 text-sm break-words', className)}>
      <ReactMarkdown components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
