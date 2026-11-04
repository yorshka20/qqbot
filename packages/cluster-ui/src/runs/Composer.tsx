import type { Ticket, TicketFrontmatter } from '@qqbot/api-types';
import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react';
import { getTicket, listTickets } from '../api';
import { useCluster } from '../app/ClusterData';
import { navigate, routeHref } from '../app/route';
import { Button } from '../ui/Button';
import { INPUT_CLASS, Select } from '../ui/Field';
import { submitRun, ticketDescription } from './submitRun';

export function Composer({ closeHref }: { closeHref: string }) {
  const { projects, templates, refresh } = useCluster();
  const [text, setText] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [readyTickets, setReadyTickets] = useState<TicketFrontmatter[]>([]);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenProject = project ?? projects?.defaultAlias ?? '';
  const chosenTemplate = template ?? templates?.projectDefaults[chosenProject] ?? '';

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
      const task = await submitRun(
        {
          project: chosenProject,
          description: ticket ? ticketDescription(ticket, text) : text.trim(),
          template: chosenTemplate || undefined,
          ticketId: ticket?.id,
        },
        templates,
      );
      await refresh();
      navigate(routeHref({ section: 'runs', runId: task.id }));
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
    <form onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-2 px-4 pb-4">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: opening the composer is asking to type
        autoFocus
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="说一句要做什么"
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
      {readyTickets.length > 0 && (
        <Select label="从 ticket 文件（可选）" value={ticket?.id ?? ''} onChange={(e) => pickTicket(e.target.value)}>
          <option value="">不用 ticket</option>
          {readyTickets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </Select>
      )}
      {error && <p className="text-13 text-failed">{error}</p>}
      <div className="flex items-center gap-1">
        <Button type="submit" variant="solid" disabled={submitting || !text.trim() || !chosenProject}>
          开始运行
        </Button>
        <a href={closeHref} className="rounded-ui px-2.5 py-1 text-13 text-ink-muted hover:bg-surface-2">
          取消
        </a>
      </div>
    </form>
  );
}
