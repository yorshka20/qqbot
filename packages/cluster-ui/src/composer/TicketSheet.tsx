import type { Ticket } from '@qqbot/api-types';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { getTicket, getTicketResult, updateTicket } from '../api';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Textarea } from '../components/ui/textarea';
import { parseOverlay, withOverlay } from '../lib/routes';

function BodyEditor({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const [body, setBody] = useState(ticket.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateTicket(ticket.id, { body });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="ticket 正文"
        className="min-h-0 flex-1 resize-none font-mono text-xs"
      />
      {error && <p className="text-xs break-words text-failed">保存没有成功：{error}。</p>}
      <div>
        <Button disabled={saving || body === ticket.body} onClick={save}>
          <Save />
          保存正文
        </Button>
      </div>
    </div>
  );
}

function ResultFile({ ticketId, file }: { ticketId: string; file: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    getTicketResult(ticketId, file).then(setContent, (err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [ticketId, file]);

  if (error) {
    return <p className="px-4 text-xs break-words text-failed">读取结果文件失败：{error}。</p>;
  }
  if (content === null) {
    return <p className="px-4 text-sm text-muted-foreground">正在读取结果文件…</p>;
  }
  return (
    <pre className="mx-4 mb-4 min-h-0 flex-1 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap">
      {content}
    </pre>
  );
}

export function TicketSheet() {
  const location = useLocation();
  const navigate = useNavigate();
  const { ticket: target } = parseOverlay(location.search);
  const ticketId = target?.id ?? null;
  const file = target?.file ?? null;
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTicket(null);
    setError(null);
    if (ticketId && !file) {
      getTicket(ticketId).then(setTicket, (err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [ticketId, file]);

  const close = () => navigate({ pathname: location.pathname, search: withOverlay(location.search, { ticket: null }) });

  return (
    <Sheet open={ticketId !== null} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-words">{file ?? ticket?.frontmatter.title ?? ticketId}</SheetTitle>
          <SheetDescription>{file ? '运行产出的结果文件，只读。' : 'ticket 正文，markdown 纯文本。'}</SheetDescription>
        </SheetHeader>
        {error && <p className="px-4 text-xs break-words text-failed">读取 ticket 失败：{error}。</p>}
        {ticketId && file && <ResultFile ticketId={ticketId} file={file} />}
        {!file && !error && !ticket && <p className="px-4 text-sm text-muted-foreground">正在读取 ticket…</p>}
        {ticket && !file && <BodyEditor key={ticket.id} ticket={ticket} onSaved={close} />}
      </SheetContent>
    </Sheet>
  );
}
