import type { Ticket, TicketFrontmatter } from '@qqbot/api-types';
import { FilePen, FileText, Play, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { getTicket, listTickets } from '../api';
import { useCluster } from '../app/ClusterData';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { readComposerChoice, rememberComposerChoice } from '../lib/memory';
import { parseOverlay, taskPath, withOverlay } from '../lib/routes';
import { composerDefaults, needsPlannerTicket, resolveTemplate } from '../lib/runs';
import { submitRun, ticketDescription } from './submitRun';

const PLACEHOLDER = '修 proactive 卡片在长回复时丢失的问题：先定位 ReplyGenerationService 里截断的那一段，再补测试';
const AUTO_TEMPLATE = '__auto__';
const NO_TICKET = '__none__';

function ComposerForm() {
  const { projects, templates, refresh } = useCluster();
  const location = useLocation();
  const navigate = useNavigate();
  const overlay = parseOverlay(location.search);
  const [saved] = useState(() => readComposerChoice());
  const [text, setText] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [readyTickets, setReadyTickets] = useState<TicketFrontmatter[]>([]);
  const [ticket, setTicket] = useState<Ticket | null>(null);
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

  const editingTicket = overlay.ticket?.id ?? null;
  const wasEditing = useRef<string | null>(null);
  useEffect(() => {
    const previous = wasEditing.current;
    wasEditing.current = editingTicket;
    if (previous !== null && editingTicket === null && previous === ticket?.id) {
      getTicket(previous).then(
        (fresh) => {
          setTicket(fresh);
          setText(fresh.body);
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

  const close = () => navigate({ pathname: location.pathname, search: withOverlay(location.search, { new: false }) });

  const pickTicket = async (id: string) => {
    if (id === NO_TICKET) {
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

  const submit = async () => {
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
          maxChildren: ticket?.frontmatter.maxChildren,
        },
        templates,
      );
      rememberComposerChoice({ project: chosenProject, template: chosenTemplate });
      await refresh();
      navigate({
        pathname: taskPath(task.id),
        search: withOverlay('', { created: createdTicketId ?? null }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <DialogContent className="sm:max-w-xl" onKeyDown={onKeyDown}>
      <DialogHeader>
        <DialogTitle>新任务</DialogTitle>
        <DialogDescription>描述要做什么，选好项目和模板后开始运行。</DialogDescription>
      </DialogHeader>
      {ticket && (
        <div className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm">
          <FileText className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{ticket.frontmatter.title}</span>
          <Button variant="ghost" size="xs" asChild className="ml-auto shrink-0">
            <Link
              to={{
                pathname: location.pathname,
                search: withOverlay(location.search, { ticket: { id: ticket.id } }),
              }}
            >
              <FilePen />
              编辑正文
            </Link>
          </Button>
          <Button variant="ghost" size="xs" className="shrink-0" onClick={() => pickTicket(NO_TICKET)}>
            <X />
            取消引用
          </Button>
        </div>
      )}
      <Textarea
        autoFocus
        rows={5}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={PLACEHOLDER}
        aria-label="要做什么"
      />
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={chosenProject || undefined}
          onValueChange={(value) => {
            setProject(value);
            setTemplate(null);
          }}
        >
          <SelectTrigger className="w-full" aria-label="项目">
            <SelectValue placeholder="选择项目" />
          </SelectTrigger>
          <SelectContent>
            {projects?.projects.map((p) => (
              <SelectItem key={p.alias} value={p.alias}>
                {p.alias}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={chosenTemplate || AUTO_TEMPLATE}
          onValueChange={(value) => setTemplate(value === AUTO_TEMPLATE ? '' : value)}
        >
          <SelectTrigger className="w-full" aria-label="模板">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_TEMPLATE}>自动选择</SelectItem>
            {templates?.templates.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {readyTickets.length > 0 && !ticket && (
        <Select value={NO_TICKET} onValueChange={pickTicket}>
          <SelectTrigger className="w-full" aria-label="从 ticket 文件">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TICKET}>不用 ticket 文件</SelectItem>
            {readyTickets.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {willCreateTicket && <p className="text-xs text-muted-foreground">规划器要先有 ticket，提交时会自动新建。</p>}
      {error && <p className="text-xs break-words text-failed">{error}</p>}
      <DialogFooter className="items-center">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">⌘Enter 提交</span>
        <Button variant="outline" onClick={close}>
          取消
        </Button>
        <Button disabled={submitting || !text.trim() || !chosenProject} onClick={() => void submit()}>
          <Play />
          开始运行
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function Composer() {
  const location = useLocation();
  const navigate = useNavigate();
  const { composing } = parseOverlay(location.search);
  return (
    <Dialog
      open={composing}
      onOpenChange={(open) =>
        !open && navigate({ pathname: location.pathname, search: withOverlay(location.search, { new: false }) })
      }
    >
      {composing && <ComposerForm />}
    </Dialog>
  );
}
