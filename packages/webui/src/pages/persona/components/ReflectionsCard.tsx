import { useState } from 'react';

import type { PersonaReflectionView } from '../../../api';
import { fmtTs } from '../utils';
import { Card } from './Card';

function ReflectionRow({ r }: { r: PersonaReflectionView }) {
  const [expanded, setExpanded] = useState(false);
  const preview = r.insightMd.length > 200 ? `${r.insightMd.slice(0, 200)}…` : r.insightMd;
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
      <p className="text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap">{expanded ? r.insightMd : preview}</p>
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

export function ReflectionsCard({ reflections }: { reflections: PersonaReflectionView[] }) {
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
