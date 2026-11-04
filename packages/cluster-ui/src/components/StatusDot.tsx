import { TONE_BG, type Tone } from '../lib/stage';
import { cn } from '../lib/utils';

export function StatusDot({ tone, breathing = false }: { tone: Tone; breathing?: boolean }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', TONE_BG[tone], breathing && 'breathing')} />;
}
