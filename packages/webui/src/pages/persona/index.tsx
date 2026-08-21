/**
 * Persona state dashboard (route entry). Polls the persona snapshot every 5s
 * and renders it as read-only cards: phenotype, modulation, epigenetics,
 * recent reflections, relationships.
 */

import { useEffect, useState } from 'react';

import { fetchPersonaState, type PersonaStateResponse } from '../../api';
import { EpigeneticsCard } from './components/EpigeneticsCard';
import { ModulationCard } from './components/ModulationCard';
import { PhenotypeCard } from './components/PhenotypeCard';
import { ReflectionsCard } from './components/ReflectionsCard';
import { RelationshipsCard } from './components/RelationshipsCard';
import { fmtTs } from './utils';

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
