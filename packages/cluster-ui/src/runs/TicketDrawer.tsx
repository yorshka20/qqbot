import type { Ticket } from '@qqbot/api-types';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { getTicket, getTicketResult, updateTicket } from '../api';
import { navigate, type Route, withRoute } from '../app/route';
import { Button } from '../ui/Button';
import { INPUT_CLASS } from '../ui/Field';

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
    <>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="ticket 正文"
        className={`${INPUT_CLASS} min-h-0 flex-1 resize-none font-mono text-13`}
      />
      {error && <p className="text-13 text-failed">{error}</p>}
      <div>
        <Button variant="solid" disabled={saving || body === ticket.body} onClick={save}>
          保存正文
        </Button>
      </div>
    </>
  );
}

function ResultFile({ ticketId, file }: { ticketId: string; file: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTicketResult(ticketId, file).then(setContent, (err) => setError(String(err)));
  }, [ticketId, file]);

  if (error) {
    return <p className="text-13 text-failed">{error}</p>;
  }
  return (
    <pre className="min-h-0 flex-1 overflow-y-auto rounded-ui bg-surface-2 p-3 font-mono text-13 whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}

/** The ticket's only surface: its body as markdown text, or one result file. */
export function TicketDrawer({ route }: { route: Route }) {
  const { ticket: ticketId, ticketFile } = route;
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTicket(null);
    setError(null);
    if (ticketId) {
      getTicket(ticketId).then(setTicket, (err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, [ticketId]);

  const close = () => navigate(withRoute(route, { ticket: null, ticketFile: null }));

  return (
    <Dialog.Root open={ticketId !== null} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-10 flex w-full flex-col gap-3 border-l border-line bg-surface p-4 md:w-[36rem]"
        >
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="min-w-0 text-17 font-medium break-words">
              {ticketFile ?? ticket?.frontmatter.title ?? ticketId}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button>关闭</Button>
            </Dialog.Close>
          </div>
          {error && <p className="text-13 text-failed">{error}</p>}
          {ticketId && ticketFile && <ResultFile ticketId={ticketId} file={ticketFile} />}
          {ticket && !ticketFile && <BodyEditor key={ticket.id} ticket={ticket} onSaved={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
