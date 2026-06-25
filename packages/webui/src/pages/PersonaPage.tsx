import { useEffect, useState } from 'react';
import type {
  PersonaEpigeneticsView,
  PersonaReflectionView,
  PersonaRelationshipView,
  PersonaStateResponse,
} from '../api';
import { fetchPersonaState } from '../api';

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded overflow-hidden">
      <div
        className="h-full bg-blue-500 dark:bg-blue-400 rounded"
        style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }}
      />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 p-4">
      <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </div>
  );
}

function PhenotypeCard({ phenotype }: { phenotype: PersonaStateResponse['phenotype'] }) {
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

function ModulationCard({ modulation }: { modulation: PersonaStateResponse['modulation'] }) {
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

function EpigeneticsCard({ epigenetics }: { epigenetics: PersonaEpigeneticsView | null }) {
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

function ReflectionRow({ r }: { r: PersonaReflectionView }) {
  const [expanded, setExpanded] = useState(false);
  const preview = r.insightMd.length > 200 ? r.insightMd.slice(0, 200) + '…' : r.insightMd;
  return (
    <div className="border-b border-zinc-100 dark:border-zinc-700 last:border-0 py-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 mb-1">
        <span className="font-mono">{fmtTs(r.timestamp)}</span>
        {r.tone != null ? (
          <span className="px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
            {r.tone}
          </span>
        ) : (
          <span>—</span>
        )}
        <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
          {r.trigger}
        </span>
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap">
        {expanded ? r.insightMd : preview}
      </p>
      {r.insightMd.length > 200 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-blue-500 hover:underline mt-1"
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

function ReflectionsCard({ reflections }: { reflections: PersonaReflectionView[] }) {
  return (
    <Card title="Recent Reflections">
      {reflections.length === 0 ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">暂无 reflection 记录</p>
      ) : (
        <div>
          {reflections.map((r) => (
            <ReflectionRow key={r.id} r={r} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RelationshipsCard({ relationships }: { relationships: PersonaRelationshipView[] }) {
  return (
    <Card title="Relationships">
      {relationships.length === 0 ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">暂无 relationship 数据</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-700">
                <th className="text-left py-1 pr-3 font-medium">User ID</th>
                <th className="text-right py-1 pr-3 font-medium">Affinity</th>
                <th className="text-right py-1 pr-3 font-medium">Familiarity</th>
                <th className="text-left py-1 pr-3 font-medium">Tags</th>
                <th className="text-left py-1 font-medium">Last interaction</th>
              </tr>
            </thead>
            <tbody>
              {relationships.map((rel) => (
                <tr key={rel.userId} className="border-b border-zinc-50 dark:border-zinc-750 last:border-0">
                  <td className="py-1.5 pr-3 font-mono text-zinc-700 dark:text-zinc-200">{rel.userId}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-500 dark:text-zinc-400">
                    {fmt(rel.affinity)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono text-zinc-500 dark:text-zinc-400">
                    {fmt(rel.familiarity)}
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-600 dark:text-zinc-300">
                    {rel.tags.length > 0 ? rel.tags.join(', ') : '—'}
                  </td>
                  <td className="py-1.5 font-mono text-zinc-500 dark:text-zinc-400">{fmtTs(rel.lastInteractionAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function PersonaPage() {
  const [state, setState] = useState<PersonaStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchPersonaState();
        if (!cancelled) {
          setState(data);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch persona state');
          setLoading(false);
        }
      }
    }

    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
        Loading persona state…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {error && (
        <div className="px-4 py-2 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {state && (
        <>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{state.personaId}</h1>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                state.enabled
                  ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                  : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {state.enabled ? 'enabled' : 'disabled'}
            </span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">
              Captured at {fmtTs(state.capturedAt)}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PhenotypeCard phenotype={state.phenotype} />
            <ModulationCard modulation={state.modulation} />
          </div>

          <EpigeneticsCard epigenetics={state.epigenetics} />
          <ReflectionsCard reflections={state.recentReflections} />
          <RelationshipsCard relationships={state.relationships} />
        </>
      )}
    </div>
  );
}
