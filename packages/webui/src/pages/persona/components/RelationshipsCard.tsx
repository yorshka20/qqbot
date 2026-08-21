import type { PersonaRelationshipView } from '../../../api';
import { fmt, fmtTs } from '../utils';
import { Card } from './Card';

export function RelationshipsCard({ relationships }: { relationships: PersonaRelationshipView[] }) {
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
