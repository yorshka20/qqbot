import type { ClusterWorkerTemplate } from '@qqbot/api-types';
import { modelDisplayName } from '../lib/model';
import { groupTemplates, providerTag } from '../lib/templates';
import { Badge } from './ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';

const AUTO = '__auto__';

function TemplateLabel({ template }: { template: ClusterWorkerTemplate }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">{template.name}</span>
      <Badge variant="outline" className="font-mono">
        {providerTag(template.type)}
      </Badge>
      {template.model && (
        <span className="truncate text-xs text-muted-foreground">{modelDisplayName(template.model)}</span>
      )}
    </span>
  );
}

function Group({ label, templates }: { label: string; templates: ClusterWorkerTemplate[] }) {
  if (templates.length === 0) {
    return null;
  }
  return (
    <SelectGroup>
      <SelectLabel>{label}</SelectLabel>
      {templates.map((t) => (
        <SelectItem key={t.name} value={t.name}>
          <TemplateLabel template={t} />
        </SelectItem>
      ))}
    </SelectGroup>
  );
}

/** The empty value is "auto": the project's default template. */
export function TemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string;
  onChange: (name: string) => void;
  templates: readonly ClusterWorkerTemplate[];
}) {
  const { planners, executors } = groupTemplates(templates);
  return (
    <Select value={value || AUTO} onValueChange={(next) => onChange(next === AUTO ? '' : next)}>
      <SelectTrigger className="w-full" aria-label="模板">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>自动选择</SelectItem>
        <SelectSeparator />
        <Group label="规划（planner）" templates={planners} />
        {planners.length > 0 && executors.length > 0 && <SelectSeparator />}
        <Group label="执行（executor）" templates={executors} />
      </SelectContent>
    </Select>
  );
}
