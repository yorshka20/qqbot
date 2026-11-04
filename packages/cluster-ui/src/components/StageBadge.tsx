import { STAGE_LABEL, STAGE_TONE, type Stage, TONE_SOFT, TONE_TEXT } from '../lib/stage';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

export function StageBadge({ stage, className }: { stage: Stage; className?: string }) {
  const tone = STAGE_TONE[stage];
  return (
    <Badge variant="secondary" className={cn('rounded-md', TONE_SOFT[tone], TONE_TEXT[tone], className)}>
      {STAGE_LABEL[stage]}
    </Badge>
  );
}
