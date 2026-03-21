/**
 * Entities View — named entity exploration with type tabs and frequency ranking.
 */

import { Activity, MapPin, Tag, TrendingUp, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getMomentsEntities } from '../api';
import type { EntitiesResponse } from '../types';
import { EmptyState, LoadingSpinner } from './MomentsShared';

const ENTITY_TYPE_CONFIG: Record<string, { label: string; color: string; icon: typeof Users }> = {
  person: { label: '人物', color: '#8b5cf6', icon: Users },
  company: { label: '公司/组织', color: '#06b6d4', icon: Activity },
  product: { label: '产品/服务', color: '#f59e0b', icon: Tag },
  tech: { label: '技术/概念', color: '#22c55e', icon: TrendingUp },
  location: { label: '地点', color: '#ef4444', icon: MapPin },
};

export function EntitiesView() {
  const [data, setData] = useState<EntitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState<string | null>(null);

  useEffect(() => {
    getMomentsEntities({ limit: 100 })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (!data || data.analyzedCount === 0) {
    return <EmptyState text="暂无实体数据，请先运行: bun scripts/moments/moments-ner.ts" />;
  }

  const types = Object.keys(data.byType);
  const displayType = activeType ?? types[0] ?? null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
        <Users className="w-4 h-4" />
        实体图谱
        <span className="text-xs text-zinc-400 ml-2">({data.analyzedCount} 条已分析)</span>
      </h2>

      {/* Type tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {types.map((type) => {
          const cfg = ENTITY_TYPE_CONFIG[type];
          const count = data.byType[type]?.length ?? 0;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setActiveType(type)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full transition-colors ${
                displayType === type
                  ? 'text-white'
                  : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600'
              }`}
              style={displayType === type ? { backgroundColor: cfg?.color ?? '#6b7280' } : undefined}
            >
              {cfg?.label ?? type}
              <span className={displayType === type ? 'opacity-70' : 'text-zinc-400'}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Entity list for selected type */}
      {displayType && data.byType[displayType] && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {data.byType[displayType].slice(0, 60).map((e) => {
              const cfg = ENTITY_TYPE_CONFIG[displayType];
              const maxCount = data.byType[displayType][0]?.count ?? 1;
              const opacity = 0.3 + (e.count / maxCount) * 0.7;
              return (
                <div
                  key={e.name}
                  className="flex items-center justify-between px-3 py-2 rounded-lg text-sm"
                  style={{
                    backgroundColor: `${cfg?.color ?? '#6b7280'}${Math.round(opacity * 25)
                      .toString(16)
                      .padStart(2, '0')}`,
                  }}
                >
                  <span className="truncate text-zinc-800 dark:text-zinc-200">{e.name}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-2 shrink-0">{e.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top entities across all types */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 bg-white dark:bg-zinc-800">
        <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-3">高频实体 Top 30</h3>
        <div className="space-y-1.5">
          {data.entities.slice(0, 30).map((e) => {
            const cfg = ENTITY_TYPE_CONFIG[e.type];
            const maxCount = data.entities[0]?.count ?? 1;
            const barWidth = Math.max(4, (e.count / maxCount) * 100);
            return (
              <div key={`${e.name}-${e.type}`} className="flex items-center gap-3 text-sm">
                <span className="w-28 truncate text-zinc-700 dark:text-zinc-300">{e.name}</span>
                <span
                  className="px-1.5 py-0.5 text-xs rounded text-white shrink-0"
                  style={{ backgroundColor: cfg?.color ?? '#6b7280' }}
                >
                  {cfg?.label ?? e.type}
                </span>
                <div className="flex-1 h-4 bg-zinc-100 dark:bg-zinc-700 rounded overflow-hidden">
                  <div
                    className="h-full rounded transition-all"
                    style={{ width: `${barWidth}%`, backgroundColor: cfg?.color ?? '#6b7280' }}
                  />
                </div>
                <span className="text-xs text-zinc-400 w-8 text-right">{e.count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
