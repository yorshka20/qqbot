import { type ReactElement, useEffect, useState } from 'react';
import { runBody } from '../lib/runs';
import { Button } from '../ui/Button';
import { Section } from '../ui/Section';

const COLLAPSED_LINES = 8;
const COLLAPSED_CHARS = 400;
const COPIED_MS = 2000;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button className="text-13" onClick={copy}>
      {copied ? '已复制' : '复制'}
    </Button>
  );
}

export function DescriptionSection({ description }: { description: string }): ReactElement | null {
  const body = runBody(description);
  const [expanded, setExpanded] = useState(false);
  if (body.length === 0) {
    return null;
  }

  const long = body.split('\n').length > COLLAPSED_LINES || body.length > COLLAPSED_CHARS;
  const collapsed = long && !expanded;
  const canCopy = !collapsed && typeof navigator !== 'undefined' && navigator.clipboard !== undefined;

  return (
    <Section title="任务描述" aside={canCopy ? <CopyButton text={body} /> : undefined}>
      <div className={`relative ${collapsed ? 'max-h-[11rem] overflow-hidden' : 'select-text'}`}>
        <p className="text-15 whitespace-pre-wrap break-words">{body}</p>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface" />
        )}
      </div>
      {long && (
        <Button className="mt-1 -ml-3 text-13" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开全文'}
        </Button>
      )}
    </Section>
  );
}
