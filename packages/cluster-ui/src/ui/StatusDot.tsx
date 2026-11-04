import { TONE_BG, type Tone } from '../lib/stage';

export function StatusDot({ tone, breathing = false }: { tone: Tone; breathing?: boolean }) {
  return (
    <span className={`inline-block size-2 shrink-0 rounded-full ${TONE_BG[tone]} ${breathing ? 'breathing' : ''}`} />
  );
}
