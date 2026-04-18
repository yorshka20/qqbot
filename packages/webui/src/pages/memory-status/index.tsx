/**
 * Memory Status page (route entry) — quality observation dashboard for memory facts.
 */

import { ArrowLeft, Brain, ChevronRight, Database, Eye, RefreshCw, Shield, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getMemoryGroupDetail, getMemoryGroups, getMemoryStats, getMemoryUserFacts } from '../../api';
import { StatCard } from '../../components/StatCard';
import type { MemoryGlobalStats, MemoryGroupDetail, MemoryGroupStats, MemoryUserFactDetail } from '../../types';
import { MemorySourceBadge, MemoryStatusBadge } from './components/MemoryBadges';
import { formatMemoryAge, formatMemoryDate } from './utils';

type View =
  | { type: 'overview' }
  | { type: 'group'; groupId: string }
  | { type: 'user'; groupId: string; userId: string };

export function MemoryStatusPage() {
  const [view, setView] = useState<View>({ type: 'overview' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [globalStats, setGlobalStats] = useState<MemoryGlobalStats | null>(null);
  const [groups, setGroups] = useState<MemoryGroupStats[]>([]);

  const [groupDetail, setGroupDetail] = useState<MemoryGroupDetail | null>(null);

  const [userFacts, setUserFacts] = useState<MemoryUserFactDetail | null>(null);

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
      const res = await getMemoryGroupDetail(groupId);
      setGroupDetail(res);
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
      const res = await getMemoryUserFacts(groupId, userId);
      setUserFacts(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view.type === 'overview') loadOverview();
    else if (view.type === 'group') loadGroup(view.groupId);
    else if (view.type === 'user') loadUser(view.groupId, view.userId);
  }, [view, loadOverview, loadGroup, loadUser]);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          {view.type !== 'overview' && (
            <button
              type="button"
              onClick={() => {
                if (view.type === 'user') setView({ type: 'group', groupId: view.groupId });
                else setView({ type: 'overview' });
              }}
              className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <Brain className="w-6 h-6 text-purple-500" />
          <h1 className="text-xl font-bold">
            {view.type === 'overview' && 'Memory Status'}
            {view.type === 'group' && `Group: ${view.groupId}`}
            {view.type === 'user' && `User: ${view.userId}`}
          </h1>
          <button
            type="button"
            onClick={() => {
              if (view.type === 'overview') loadOverview();
              else if (view.type === 'group') loadGroup(view.groupId);
              else if (view.type === 'user') loadUser(view.groupId, view.userId);
            }}
            className="ml-auto p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        {view.type === 'overview' && globalStats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <StatCard
                icon={<Database className="w-5 h-5 text-purple-500" />}
                label="Total Facts"
                value={globalStats.totalFacts}
                color="bg-purple-100 dark:bg-purple-900/30"
              />
              <StatCard
                icon={<Zap className="w-5 h-5 text-emerald-500" />}
                label="Active"
                value={globalStats.activeFacts}
                color="bg-emerald-100 dark:bg-emerald-900/30"
              />
              <StatCard
                icon={<Eye className="w-5 h-5 text-amber-500" />}
                label="Stale"
                value={globalStats.staleFacts}
                color="bg-amber-100 dark:bg-amber-900/30"
              />
              <StatCard
                icon={<Shield className="w-5 h-5 text-blue-500" />}
                label="Manual"
                value={globalStats.manualFacts}
                color="bg-blue-100 dark:bg-blue-900/30"
              />
              <StatCard
                icon={<Brain className="w-5 h-5 text-zinc-500" />}
                label="Auto (LLM)"
                value={globalStats.autoFacts}
                color="bg-zinc-100 dark:bg-zinc-700"
              />
            </div>

            <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                <h2 className="font-semibold">Groups ({groups.length})</h2>
              </div>
              {groups.length === 0 && !loading && (
                <p className="px-4 py-8 text-center text-zinc-400">No memory data yet</p>
              )}
              <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
                {groups.map((g) => (
                  <button
                    key={g.groupId}
                    type="button"
                    onClick={() => setView({ type: 'group', groupId: g.groupId })}
                    className="w-full px-4 py-3 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{g.groupId}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {g.userCount} users / {g.totalFacts} facts ({g.activeFacts} active, {g.staleFacts} stale)
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-400 shrink-0">
                      <span className="text-blue-500">{g.manualFacts} manual</span>
                      <span>{g.autoFacts} auto</span>
                      <ChevronRight className="w-4 h-4" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {view.type === 'group' && groupDetail && (
          <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
              <h2 className="font-semibold">
                Users ({groupDetail.users.length}) - {groupDetail.totalFacts} total facts
              </h2>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
              {groupDetail.users.map((u) => (
                <button
                  key={u.userId}
                  type="button"
                  onClick={() => setView({ type: 'user', groupId: view.groupId, userId: u.userId })}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate font-mono">{u.userId}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {u.totalFacts} facts ({u.activeFacts} active, {u.staleFacts} stale)
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-400 shrink-0">
                    <span className="text-blue-500">{u.manualFacts} manual</span>
                    <span>{u.autoFacts} auto</span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {view.type === 'user' && userFacts && (
          <div className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
              <h2 className="font-semibold">{userFacts.totalFacts} Facts</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left text-xs text-zinc-500 dark:text-zinc-400 uppercase">
                    <th className="px-4 py-2">Scope</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">Reinforce</th>
                    <th className="px-4 py-2 text-right">Hits</th>
                    <th className="px-4 py-2 text-right">Age</th>
                    <th className="px-4 py-2">First Seen</th>
                    <th className="px-4 py-2">Last Reinforced</th>
                    <th className="px-4 py-2 font-mono">Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-700">
                  {userFacts.facts.map((f) => (
                    <tr key={f.factHash} className="hover:bg-zinc-50 dark:hover:bg-zinc-750">
                      <td className="px-4 py-2 font-mono text-xs">{f.scope}</td>
                      <td className="px-4 py-2">
                        <MemorySourceBadge source={f.source} />
                      </td>
                      <td className="px-4 py-2">
                        <MemoryStatusBadge status={f.status} />
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{f.reinforceCount}</td>
                      <td className="px-4 py-2 text-right font-mono">{f.hitCount}</td>
                      <td className="px-4 py-2 text-right text-zinc-400">{formatMemoryAge(f.ageDays)}</td>
                      <td className="px-4 py-2 text-zinc-400 text-xs">{formatMemoryDate(f.firstSeen)}</td>
                      <td className="px-4 py-2 text-zinc-400 text-xs">{formatMemoryDate(f.lastReinforced)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-zinc-400">{f.factHash.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {loading && !globalStats && !groupDetail && !userFacts && (
          <div className="text-center py-12 text-zinc-400">Loading...</div>
        )}
      </div>
    </div>
  );
}
