import { Settings } from 'lucide-react';
import { useNavigate } from 'react-router';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { daemonSummary } from '../lib/daemon';
import { settingsPath } from '../lib/routes';
import { useCluster } from './ClusterData';
import { DaemonControls } from './DaemonControls';

export function DaemonPopover() {
  const { cluster, unreachable, loaded } = useCluster();
  const navigate = useNavigate();
  const summary = daemonSummary(cluster, unreachable, loaded);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={summary.label}>
          <StatusDot tone={summary.tone} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="flex items-center gap-2 font-medium">
          <StatusDot tone={summary.tone} />
          {summary.label}
        </div>
        <p className="text-xs text-muted-foreground">
          在跑 {summary.running} · 并发 {summary.capacity}
        </p>
        <DaemonControls />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => navigate(settingsPath('daemon'))}>
          <Settings />
          打开设置
        </Button>
      </PopoverContent>
    </Popover>
  );
}
