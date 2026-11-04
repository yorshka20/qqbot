import { GitMerge } from 'lucide-react';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import type { Delivery } from '../lib/delivery';

export function DeliveryLine({ delivery, busy, onLand }: { delivery: Delivery; busy: boolean; onLand: () => void }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot tone={delivery.tone} />
        <span className="font-mono text-xs">{delivery.label}</span>
        {delivery.canLand && (
          <Button size="xs" variant="outline" disabled={busy} onClick={onLand}>
            <GitMerge />
            合入主分支
          </Button>
        )}
      </div>
      {delivery.detail && (
        <pre className="max-h-32 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-failed">
          {delivery.detail}
        </pre>
      )}
    </div>
  );
}
