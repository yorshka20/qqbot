import type { PersonaStateResponse } from '../../../api';
import { fmt } from '../utils';
import { Card } from './Card';

export function ModulationCard({ modulation }: { modulation: PersonaStateResponse['modulation'] }) {
  const entries: [string, number][] = [
    ['Intensity scale', modulation.intensityScale],
    ['Speed scale', modulation.speedScale],
    ['Duration bias', modulation.durationBias],
  ];
  return (
    <Card title="Modulation">
      <div className="grid grid-cols-3 gap-4">
        {entries.map(([label, val]) => (
          <div key={label} className="text-center">
            <div className="text-2xl font-mono font-semibold text-zinc-800 dark:text-zinc-100">{fmt(val, 3)}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
