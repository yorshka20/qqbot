import { Activity, Ban, Check, Clock, Eye, type LucideIcon, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import type { ReactElement } from 'react';
import { type Stage, TONE_SOFT, TONE_TEXT, type Tone } from '../lib/stage';
import { StatusDot } from './StatusDot';

export const STAGE_ICON: Record<Stage, LucideIcon> = {
  asking: MessageCircleQuestion,
  running: Activity,
  queued: Clock,
  failed: TriangleAlert,
  blocked: TriangleAlert,
  review: Eye,
  done: Check,
  cancelled: Ban,
};

export function StatePill({
  tone,
  label,
  icon: Icon,
  breathing,
}: {
  tone: Tone;
  label: string;
  icon?: LucideIcon;
  breathing?: boolean;
}): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5 text-12 font-medium ${TONE_SOFT[tone]} ${TONE_TEXT[tone]}`}
    >
      {breathing ? (
        <StatusDot tone={tone} breathing />
      ) : Icon ? (
        <Icon className="size-3.5 shrink-0" strokeWidth={2} />
      ) : null}
      {label}
    </span>
  );
}
