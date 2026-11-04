import type { ReactElement } from 'react';
import { TONE_BG, type Tone } from '../lib/stage';

/** Caller owns `relative` on the parent and leaves room on the left for this bar. */
export function StatusBar({ tone, active }: { tone: Tone; active?: boolean }): ReactElement {
  return (
    <span className={`absolute inset-y-0 left-0 w-[3px] rounded-r-ui ${TONE_BG[tone]} ${active ? '' : 'opacity-40'}`} />
  );
}
