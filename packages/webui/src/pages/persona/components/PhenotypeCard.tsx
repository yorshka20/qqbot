import type { PersonaStateResponse } from '../../../api';
import { fmt, fmtTs } from '../utils';
import { Card, ProgressBar } from './Card';

export function PhenotypeCard({ phenotype }: { phenotype: PersonaStateResponse['phenotype'] }) {
  return (
    <Card title="Phenotype">
      <div className="space-y-3">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-zinc-600 dark:text-zinc-300">Fatigue</span>
            <span className="text-zinc-500 dark:text-zinc-400 font-mono">{fmt(phenotype.fatigue)}</span>
          </div>
          <ProgressBar value={phenotype.fatigue} />
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-zinc-600 dark:text-zinc-300">Attention</span>
            <span className="text-zinc-500 dark:text-zinc-400 font-mono">{fmt(phenotype.attention)}</span>
          </div>
          <ProgressBar value={phenotype.attention} />
        </div>
        <div className="flex gap-6 text-sm mt-1">
          <div>
            <span className="text-zinc-500 dark:text-zinc-400">Stimulus count </span>
            <span className="font-mono text-zinc-700 dark:text-zinc-200">{phenotype.stimulusCount}</span>
          </div>
          {phenotype.lastStimulusAt != null && (
            <div>
              <span className="text-zinc-500 dark:text-zinc-400">Last stimulus </span>
              <span className="font-mono text-zinc-700 dark:text-zinc-200">{fmtTs(phenotype.lastStimulusAt)}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
