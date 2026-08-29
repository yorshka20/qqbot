import { ChevronRight } from 'lucide-react';

import type { DumpSection, DumpToolCall, TranscriptMessage } from './parseDump';

const ROLE_CHIP: Record<string, string> = {
  user: 'bg-sky-100 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300',
  assistant: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300',
  tool: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300',
};

const ROLE_BORDER: Record<string, string> = {
  user: 'border-sky-300 dark:border-sky-800',
  assistant: 'border-emerald-300 dark:border-emerald-800',
  tool: 'border-amber-300 dark:border-amber-800',
};

const TITLE_ACCENT: Record<string, string> = {
  output: 'text-emerald-700 dark:text-emerald-300',
  thinking: 'text-violet-700 dark:text-violet-300',
  'tool-result': 'text-amber-700 dark:text-amber-300',
};

// Older dumps wrote each turn as its own `### user` / `### assistant` section
// instead of a fenced `### conversation` transcript; color those the same way.
const LABEL_ACCENT: Record<string, string> = {
  user: 'text-sky-700 dark:text-sky-300',
  assistant: 'text-emerald-700 dark:text-emerald-300',
};

function sizeBadge(text: string): string {
  const n = text.length;
  return n < 1000 ? `${n} 字符` : `${(n / 1000).toFixed(1)}k 字符`;
}

function DumpBody({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
      {text}
    </pre>
  );
}

function Collapsible({
  title,
  titleClass,
  badge,
  defaultOpen,
  children,
}: {
  title: string;
  titleClass?: string;
  badge?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/60"
    >
      <summary className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-zinc-50 dark:hover:bg-zinc-700/50 rounded-lg group-open:rounded-b-none">
        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" />
        <span className={`text-xs font-semibold ${titleClass ?? 'text-zinc-600 dark:text-zinc-300'}`}>{title}</span>
        {badge && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{badge}</span>}
      </summary>
      <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2">{children}</div>
    </details>
  );
}

function TranscriptView({ messages }: { messages: TranscriptMessage[] }) {
  return (
    <div className="space-y-2">
      {messages.map((m, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript order is the identity
          key={i}
          className={`border-l-2 pl-3 py-0.5 ${ROLE_BORDER[m.role] ?? 'border-zinc-300 dark:border-zinc-600'}`}
        >
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span
              className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${
                ROLE_CHIP[m.role] ?? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
              }`}
            >
              {m.role}
            </span>
            {m.speaker && <span className="text-xs text-zinc-600 dark:text-zinc-300 font-medium">{m.speaker}</span>}
            {m.time && <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">{m.time}</span>}
          </div>
          <DumpBody text={m.body} />
        </div>
      ))}
    </div>
  );
}

function EnvelopeView({ parts }: { parts: Array<{ tag: string; body: string }> }) {
  return (
    <div className="space-y-2">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: envelope part order is the identity
        <div key={i}>
          <div className="mb-1">
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              {`<${p.tag}>`}
            </span>
          </div>
          <div className="pl-3 border-l-2 border-zinc-200 dark:border-zinc-700">
            <DumpBody text={p.body} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolCallsView({ calls }: { calls: DumpToolCall[] }) {
  return (
    <div className="space-y-2">
      {calls.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: call order is the identity
        <div key={i}>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
              {c.name}
            </span>
            {c.id && <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">{c.id}</span>}
          </div>
          <div className="pl-3 border-l-2 border-indigo-200 dark:border-indigo-900">
            <DumpBody text={c.args} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectionBlock({ section }: { section: DumpSection }) {
  if (section.kind === 'conversation') {
    return (
      <Collapsible title="conversation" badge={`${section.messages.length} 条消息`} defaultOpen>
        <TranscriptView messages={section.messages} />
      </Collapsible>
    );
  }

  if (section.kind === 'envelope') {
    return (
      <Collapsible title={section.label} badge={`${section.parts.length} 段`} defaultOpen>
        <EnvelopeView parts={section.parts} />
      </Collapsible>
    );
  }

  if (section.kind === 'tool-calls') {
    return (
      <Collapsible title={section.label} badge={`${section.calls.length} 次调用`} defaultOpen>
        <ToolCallsView calls={section.calls} />
      </Collapsible>
    );
  }

  const collapsed = section.role === 'system' || section.role === 'thinking';
  return (
    <Collapsible
      title={section.label}
      titleClass={TITLE_ACCENT[section.role] ?? LABEL_ACCENT[section.label]}
      badge={sizeBadge(section.body)}
      defaultOpen={!collapsed}
    >
      {section.body ? <DumpBody text={section.body} /> : <p className="text-xs text-zinc-400 italic">(无文本)</p>}
    </Collapsible>
  );
}
