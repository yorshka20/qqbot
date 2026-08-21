import type { PersonaEpigeneticsView } from '../../../api';
import { fmt, fmtTs } from '../utils';
import { Card } from './Card';

export function EpigeneticsCard({ epigenetics }: { epigenetics: PersonaEpigeneticsView | null }) {
  if (epigenetics == null) {
    return (
      <Card title="Epigenetics">
        <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">无数据（仅 SQLite 部署可见）</p>
      </Card>
    );
  }

  const sections: [string, Record<string, unknown>, boolean][] = [
    ['Behavioral biases', epigenetics.behavioralBiases, true],
    ['Topic mastery', epigenetics.topicMastery, false],
    ['Learned preferences', epigenetics.learnedPreferences, false],
  ];

  return (
    <Card title="Epigenetics">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Current tone</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
            {epigenetics.currentTone}
          </span>
          <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">
            Updated {fmtTs(epigenetics.updatedAt)}
          </span>
        </div>
        {sections.map(([title, data, skipCurrentTone]) => {
          const entries = Object.entries(data).filter(([k]) => !(skipCurrentTone && k === 'currentTone'));
          return (
            <div key={title}>
              <div className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1">
                {title}
              </div>
              {entries.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">—</p>
              ) : (
                <div className="space-y-0.5">
                  {entries.map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-300 truncate max-w-[60%]">{k}</span>
                      <span className="font-mono text-zinc-500 dark:text-zinc-400">
                        {typeof v === 'number' ? fmt(v, 3) : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
