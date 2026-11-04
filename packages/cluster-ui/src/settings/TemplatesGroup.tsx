import { Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { probeClusterTemplates, type TemplateProbeResult } from '../api';
import { useCluster } from '../app/ClusterData';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { modelDisplayName } from '../lib/model';

const COST_LABEL = { low: '低', medium: '中', high: '高' } as const;

export function TemplatesGroup() {
  const { templates, cluster } = useCluster();
  const [probes, setProbes] = useState<TemplateProbeResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = cluster?.started === true;

  const probe = async () => {
    setProbing(true);
    setError(null);
    try {
      setProbes(await probeClusterTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={probing || !started} onClick={probe}>
          <Stethoscope />
          {probing ? '正在探测…' : '探测模板'}
        </Button>
        {!started && <span className="text-sm text-muted-foreground">调度未启动，启动后才能探测。</span>}
      </div>
      {error && <p className="text-sm break-words text-failed">探测没有完成：{error}。确认 daemon 在线后再试一次。</p>}
      {!templates ? (
        <p className="text-sm text-muted-foreground">正在读取模板…</p>
      ) : templates.templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有配置模板。在 daemon 的配置里添加后会列在这里。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {templates.templates.map((template) => {
            const result = probes?.find((p) => p.templateName === template.name);
            const model = result?.model ?? template.model;
            return (
              <li key={template.name} className="min-w-0 rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-medium">{template.name}</span>
                  <span className="text-xs text-muted-foreground">{template.type}</span>
                  <span className="text-xs text-muted-foreground">{template.role === 'planner' ? '规划' : '执行'}</span>
                  {model && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs">{modelDisplayName(model)}</span>
                      </TooltipTrigger>
                      <TooltipContent className="font-mono">{model}</TooltipContent>
                    </Tooltip>
                  )}
                  <span className="text-xs text-muted-foreground">成本 {COST_LABEL[template.costTier]}</span>
                  <span className="text-xs text-muted-foreground">最大并发 {template.maxConcurrent}</span>
                  {result && (
                    <span className={`ml-auto text-xs ${result.ok ? 'text-done' : 'text-failed'}`}>
                      {result.ok ? `凭据可用 · ${result.durationMs} ms` : '凭据坏了'}
                    </span>
                  )}
                </div>
                {result && !result.ok && (
                  <p className="mt-1 text-sm break-words text-failed">
                    {result.reason ? `${result.reason}。` : ''}检查这个模板对应后端的凭据后，再探测一次。
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
