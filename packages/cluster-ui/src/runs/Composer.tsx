import type { Ticket, TicketFrontmatter } from '@qqbot/api-types';
import { FileText, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { getTicket, listTickets } from '../api';
import { useCluster } from '../app/ClusterData';
import { navigate, type Route, routeHref, withRoute } from '../app/route';
import { readComposerChoice, rememberComposerChoice } from '../lib/memory';
import { composerDefaults, needsPlannerTicket, resolveTemplate } from '../lib/runs';
import { Button } from '../ui/Button';
import { INPUT_CLASS, Select } from '../ui/Field';
import { submitRun, ticketDescription } from './submitRun';

const PLACEHOLDER = '修 proactive 卡片在长回复时丢失的问题：先定位 ReplyGenerationService 里截断的那一段，再补测试';

export function Composer({ closeHref, route }: { closeHref: string; route: Route }) {
  const { projects, templates, refresh } = useCluster();
  const [saved] = useState(() => readComposerChoice());
  const [text, setText] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [readyTickets, setReadyTickets] = useState<TicketFrontmatter[]>([]);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [showTicketPicker, setShowTicketPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectAliases = projects?.projects.map((p) => p.alias) ?? [];
  const remembered = composerDefaults(saved, projectAliases, projects?.defaultAlias, templates?.projectDefaults ?? {});
  const chosenProject = project ?? remembered.project;
  const chosenTemplate =
    template ?? (project === null ? remembered.template : (templates?.projectDefaults[chosenProject] ?? ''));

  const resolvedTemplate = resolveTemplate({ project: chosenProject, template: chosenTemplate }, templates);
  const resolvedRole = templates?.templates.find((t) => t.name === resolvedTemplate)?.role;
  const willCreateTicket = needsPlannerTicket(resolvedRole, ticket?.id);

  const editingTicket = route.ticket;
  const wasEditing = useRef<string | null>(null);
  useEffect(() => {
    const previous = wasEditing.current;
    wasEditing.current = editingTicket;
    if (previous !== null && editingTicket === null && previous === ticket?.id) {
      getTicket(previous).then(
        (saved) => {
          setTicket(saved);
          setText(saved.body);
        },
        (err) => setError(err instanceof Error ? err.message : String(err)),
      );
    }
  }, [editingTicket, ticket?.id]);

  useEffect(() => {
    listTickets().then(
      (tickets) => setReadyTickets(tickets.filter((t) => t.status === 'ready')),
      () => {},
    );
  }, []);

  const pickTicket = async (id: string) => {
    if (!id) {
      setTicket(null);
      setText('');
      return;
    }
    try {
      const picked = await getTicket(id);
      setTicket(picked);
      setText(picked.body);
      setProject(picked.frontmatter.project ?? null);
      setTemplate(picked.frontmatter.template ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || !chosenProject || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { task, createdTicketId } = await submitRun(
        {
          project: chosenProject,
          description: ticket ? ticketDescription(ticket, text) : text.trim(),
          template: chosenTemplate || undefined,
          ticketId: ticket?.id,
        },
        templates,
      );
      rememberComposerChoice({ project: chosenProject, template: chosenTemplate });
      await refresh();
      navigate(routeHref({ section: 'runs', runId: task.id, createdTicket: createdTicketId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      navigate(closeHref);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void submit();
    }
  };

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-3 border-b border-line px-4 pt-1 pb-4">
      {ticket && (
        <div className="flex items-center justify-between gap-2 rounded-ui bg-surface-2 px-2.5 py-1.5 text-14">
          <span className="truncate">{ticket.frontmatter.title}</span>
          <a
            href={withRoute(route, { ticket: ticket.id })}
            className="ml-auto shrink-0 text-13 text-ink-muted underline hover:text-ink"
          >
            编辑正文
          </a>
          <button
            type="button"
            onClick={() => pickTicket('')}
            aria-label="取消引用这个 ticket"
            className="shrink-0 text-ink-muted hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <textarea
        // biome-ignore lint/a11y/noAutofocus: opening the composer is asking to type
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        aria-label="要做什么"
        className={`${INPUT_CLASS} resize-y`}
      />
      <div className="flex gap-2">
        <Select
          label="项目"
          value={chosenProject}
          onChange={(e) => {
            setProject(e.target.value);
            setTemplate(null);
          }}
        >
          {projects?.projects.map((p) => (
            <option key={p.alias} value={p.alias}>
              {p.alias}
            </option>
          ))}
        </Select>
        <Select label="模板" value={chosenTemplate} onChange={(e) => setTemplate(e.target.value)}>
          <option value="">自动选择</option>
          {templates?.templates.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <button
          type="button"
          disabled={readyTickets.length === 0}
          title={readyTickets.length === 0 ? '没有 ready 状态的 ticket' : undefined}
          onClick={() => setShowTicketPicker((v) => !v)}
          className="inline-flex items-center gap-1.5 text-14 text-ink-muted hover:text-ink disabled:opacity-50"
        >
          <FileText className="size-3.5" />
          <span>从 ticket 文件填入</span>
        </button>
        {showTicketPicker && readyTickets.length > 0 && (
          <div className="mt-2">
            <Select label="选择 ticket" value={ticket?.id ?? ''} onChange={(e) => pickTicket(e.target.value)}>
              <option value="">不用 ticket</option>
              {readyTickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {willCreateTicket && <p className="text-13 text-ink-muted">规划器要先有 ticket，提交时会自动新建。</p>}
      {error && <p className="text-13 text-failed">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="solid" disabled={submitting || !text.trim() || !chosenProject}>
          开始运行
        </Button>
        <a href={closeHref} className="rounded-ui px-2.5 py-1 text-13 text-ink-muted hover:bg-surface-2">
          取消
        </a>
        <span className="text-12 text-ink-muted">⌘Enter 提交 · Esc 取消</span>
      </div>
    </form>
  );
}
