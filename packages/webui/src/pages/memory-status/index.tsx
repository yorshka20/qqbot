/**
 * Memory browser.
 * Groups and slots are separate pages and load only that layer.
 * A group's own memory is one special slot in the slot list.
 * A slot shows its manual.txt and its automatic facts, which can be corrected or deleted.
 */

import { Archive, ArrowLeft, Brain, ChevronRight, Library, RefreshCw, Shield, UserRound, Zap } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { getMemoryGroupDetail, getMemoryGroups, getMemorySlot, getMemoryStats } from '../../api';
import { StatCard } from '../../components/StatCard';
import type {
  MemoryFactCounts,
  MemoryGlobalStats,
  MemoryGroupDetail,
  MemoryGroupStats,
  MemorySlotDetail,
} from '../../types';
import { HighlightText } from './components/HighlightText';
import { ManualMemoryPanel } from './components/ManualMemoryPanel';
import { MemoryFactList } from './components/MemoryFactList';
import { MemoryToolbar } from './components/MemoryToolbar';
import { filterFacts, type MemoryLayerFilter, type MemoryStatusFilter } from './utils';

type View =
  | { type: 'overview' }
  | { type: 'group'; groupId: string }
  | { type: 'user'; groupId: string; userId: string };

export function MemoryStatusPage() {
  const [view, setView] = useState<View>({ type: 'overview' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<MemoryStatusFilter>('active');
  const [layer, setLayer] = useState<MemoryLayerFilter>('all');

  const [globalStats, setGlobalStats] = useState<MemoryGlobalStats | null>(null);
  const [groups, setGroups] = useState<MemoryGroupStats[]>([]);
  const [groupDetail, setGroupDetail] = useState<MemoryGroupDetail | null>(null);
  const [slot, setSlot] = useState<MemorySlotDetail | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, groupsRes] = await Promise.all([getMemoryStats(), getMemoryGroups()]);
      setGlobalStats(statsRes.stats);
      setGroups(groupsRes.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGroup = useCallback(async (groupId: string) => {
    setLoading(true);
    setError(null);
    try {
      setGroupDetail(await getMemoryGroupDetail(groupId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUser = useCallback(async (groupId: string, userId: string) => {
    setLoading(true);
    setError(null);
    try {
      setSlot(await getMemorySlot(groupId, userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view.type === 'overview') {
      setGroupDetail(null);
      setSlot(null);
      loadOverview();
      return;
    }
    if (view.type === 'group') {
      setGroupDetail(null);
      setSlot(null);
      loadGroup(view.groupId);
      return;
    }
    setSlot(null);
    loadUser(view.groupId, view.userId);
  }, [view, loadOverview, loadGroup, loadUser]);

  const refresh = () => {
    if (view.type === 'overview') {
      loadOverview();
    } else if (view.type === 'group') {
      loadGroup(view.groupId);
    } else {
      loadUser(view.groupId, view.userId);
    }
  };

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    return groups.filter((group) => {
      if (!matchesCounts(group, status, layer)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return group.groupId.toLowerCase().includes(needle) || (group.groupName?.toLowerCase().includes(needle) ?? false);
    });
  }, [groups, needle, status, layer]);

  const visibleUsers = useMemo(() => {
    const users = groupDetail?.slots ?? [];
    return users
      .filter((user) => {
        if (!matchesCounts({ ...user, manualSlots: user.hasManualText ? 1 : 0 }, status, layer)) {
          return false;
        }
        if (!needle) {
          return true;
        }
        const label = user.isGroupMemory ? '本群记忆' : '';
        return (
          user.userId.toLowerCase().includes(needle) ||
          (user.nickname?.toLowerCase().includes(needle) ?? false) ||
          label.includes(needle)
        );
      })
      .sort((a, b) => {
        if (a.isGroupMemory !== b.isGroupMemory) {
          return a.isGroupMemory ? -1 : 1;
        }
        return (a.nickname ?? a.userId).localeCompare(b.nickname ?? b.userId, 'zh-CN');
      });
  }, [groupDetail, needle, status, layer]);

  const visibleFacts = useMemo(() => filterFacts(slot?.facts ?? [], query, status), [slot, query, status]);

  const title = heading(view, groupDetail, slot);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          {view.type !== 'overview' && (
            <button
              type="button"
              onClick={() => {
                if (view.type === 'user') {
                  setView({ type: 'group', groupId: view.groupId });
                } else {
                  setView({ type: 'overview' });
                }
              }}
              className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              aria-label="返回"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <Brain className="w-6 h-6 text-purple-500" />
          <h1 className="text-xl font-bold min-w-0 truncate">{title}</h1>
          <button
            type="button"
            onClick={refresh}
            className="ml-auto p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <MemoryToolbar
          query={query}
          onQueryChange={setQuery}
          status={status}
          onStatusChange={setStatus}
          layer={layer}
          onLayerChange={setLayer}
        />

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {view.type === 'overview' && globalStats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<Zap className="w-5 h-5 text-emerald-500" />}
              label="有效"
              value={globalStats.activeFacts}
              color="bg-emerald-100 dark:bg-emerald-900/30"
            />
            <StatCard
              icon={<Brain className="w-5 h-5 text-zinc-500" />}
              label="已取代"
              value={globalStats.supersededFacts}
              color="bg-zinc-100 dark:bg-zinc-700"
            />
            <StatCard
              icon={<Archive className="w-5 h-5 text-amber-500" />}
              label="已淘汰"
              value={globalStats.retiredFacts}
              color="bg-amber-100 dark:bg-amber-900/30"
            />
            <StatCard
              icon={<Shield className="w-5 h-5 text-blue-500" />}
              label="手动记忆"
              value={globalStats.manualSlots}
              color="bg-blue-100 dark:bg-blue-900/30"
            />
          </div>
        )}

        {view.type === 'overview' && (
          <LayerList empty={overviewEmpty(groups.length, visibleGroups.length, loading)}>
            {visibleGroups.map((group) => (
              <button
                key={group.groupId}
                type="button"
                onClick={() => setView({ type: 'group', groupId: group.groupId })}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    {group.groupName ? (
                      <>
                        <span className="font-medium truncate">
                          <HighlightText text={group.groupName} query={query} />
                        </span>
                        <span className="font-mono text-xs text-zinc-400 shrink-0">{group.groupId}</span>
                      </>
                    ) : (
                      <span className="font-medium font-mono truncate">
                        <HighlightText text={group.groupId} query={query} />
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {group.slotCount} 项 · {group.activeFacts} 条有效 · {group.manualSlots} 份手动
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 shrink-0 text-zinc-400" />
              </button>
            ))}
          </LayerList>
        )}

        {view.type === 'group' && groupDetail && (
          <LayerList empty={visibleUsers.length === 0 ? '没有匹配的用户' : null}>
            {visibleUsers.map((user) => (
              <button
                key={user.userId}
                type="button"
                onClick={() => setView({ type: 'user', groupId: view.groupId, userId: user.userId })}
                className={`w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700/40 ${
                  user.isGroupMemory ? 'bg-purple-50/70 dark:bg-purple-950/20' : ''
                }`}
              >
                {user.isGroupMemory ? (
                  <Library className="w-4 h-4 shrink-0 text-purple-500" />
                ) : (
                  <UserRound className="w-4 h-4 shrink-0 text-zinc-400" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    {user.isGroupMemory ? (
                      <span className="font-medium text-sm">本群记忆</span>
                    ) : user.nickname ? (
                      <>
                        <span className="font-medium text-sm truncate">
                          <HighlightText text={user.nickname} query={query} />
                        </span>
                        <span className="font-mono text-xs text-zinc-400 shrink-0">{user.userId}</span>
                      </>
                    ) : (
                      <span className="font-medium text-sm font-mono truncate">
                        <HighlightText text={user.userId} query={query} />
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {user.activeFacts} 条有效{user.hasManualText ? ' · 有手动记忆' : ''}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 shrink-0 text-zinc-400" />
              </button>
            ))}
          </LayerList>
        )}

        {view.type === 'user' && slot && (
          <div className="space-y-4">
            {layer !== 'auto' && (
              <ManualMemoryPanel
                key={`${view.groupId}:${view.userId}`}
                groupId={view.groupId}
                userId={view.userId}
                text={slot.manualText}
                onSaved={() => loadUser(view.groupId, view.userId)}
              />
            )}
            {layer !== 'manual' && (
              <section className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-700 flex items-baseline gap-2">
                  <h2 className="text-sm font-medium">自动记忆</h2>
                  <span className="text-xs text-zinc-400">
                    {visibleFacts.length} / {slot.facts.length} 条
                  </span>
                </div>
                <MemoryFactList
                  facts={visibleFacts}
                  query={query}
                  onChanged={() => loadUser(view.groupId, view.userId)}
                />
              </section>
            )}
          </div>
        )}

        {loading && <div className="text-center py-6 text-sm text-zinc-400">加载中…</div>}
      </div>
    </div>
  );
}

function overviewEmpty(groupCount: number, visibleCount: number, loading: boolean): string | null {
  if (visibleCount > 0) {
    return null;
  }
  if (groupCount === 0 && !loading) {
    return '还没有记忆';
  }
  if (groupCount > 0) {
    return '没有匹配的群';
  }
  return null;
}

function LayerList({ empty, children }: { empty: string | null; children: ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {empty ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-400">{empty}</p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-700">{children}</div>
      )}
    </div>
  );
}

function heading(view: View, group: MemoryGroupDetail | null, user: MemorySlotDetail | null): string {
  if (view.type === 'overview') {
    return '记忆';
  }
  if (view.type === 'group') {
    return group?.groupName ?? view.groupId;
  }
  const known = group?.slots.find((row) => row.userId === view.userId);
  if (user?.isGroupMemory || known?.isGroupMemory) {
    return '本群记忆';
  }
  return user?.nickname ?? known?.nickname ?? view.userId;
}

function matchesCounts(
  row: MemoryFactCounts & { manualSlots: number },
  status: MemoryStatusFilter,
  layer: MemoryLayerFilter,
): boolean {
  if (layer === 'manual') {
    return row.manualSlots > 0;
  }
  const counts: Record<Exclude<MemoryStatusFilter, 'all'>, number> = {
    active: row.activeFacts,
    superseded: row.supersededFacts,
    retired: row.retiredFacts,
  };
  const total = row.activeFacts + row.supersededFacts + row.retiredFacts;
  const matching = status === 'all' ? total : counts[status];
  return matching > 0 || (layer === 'all' && row.manualSlots > 0);
}
