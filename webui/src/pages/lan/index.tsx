/**
 * LAN relay control page (route entry).
 *
 * Layout:
 *   - Header: status summary (role · listen · connected count) + Refresh
 *   - Clients card: table of connected LAN clients with Dispatch / Kick actions
 *   - Reports card: tail of internal_reports for the currently-selected client
 *
 * State sync:
 *   - 5s polling refresh as a baseline (matches ClusterPage)
 *   - SSE stream from /api/lan/stream pushes client_connected /
 *     client_disconnected / internal_report events; we just trigger a refresh
 *     on receipt instead of merging incrementally — same approach as
 *     ClusterPage. Simpler, no client-side state divergence.
 *
 * Gating:
 *   - When the local instance is NOT in host mode, /api/lan/status still
 *     responds with `role !== 'host'`, and we render a banner explaining
 *     why the rest of the page is empty. The other endpoints all return
 *     503 in that state — we don't even call them.
 */

import {
  Activity,
  Network,
  RefreshCw,
  Send,
  Skull,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  dispatchLanCommand,
  getLanStatus,
  getLanStreamUrl,
  kickLanClient,
  listLanClients,
  listLanReports,
} from '../../api';
import type {
  LanClientSnapshot,
  LanReportLevel,
  LanReportRow,
  LanStatusResponse,
} from '../../types';

// ────────────────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────────────────

function LanCard({
  title,
  count,
  right,
  children,
}: {
  title: string;
  count?: number;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
        {typeof count === 'number' && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">({count})</div>
        )}
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function levelBadgeClass(level: LanReportLevel): string {
  switch (level) {
    case 'error':
      return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300';
    case 'warn':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300';
    case 'info':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300';
    default:
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Page component
// ────────────────────────────────────────────────────────────────────────────

export function LanPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<LanStatusResponse | null>(null);
  const [clients, setClients] = useState<LanClientSnapshot[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [reports, setReports] = useState<LanReportRow[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const [dispatchClientId, setDispatchClientId] = useState<string | null>(null);
  const [dispatchText, setDispatchText] = useState('');
  const [dispatching, setDispatching] = useState(false);

  const [tickKey, setTickKey] = useState(0); // re-render trigger for live "lastSeen" durations

  const sseUrl = useMemo(() => getLanStreamUrl(), []);

  const isHost = status?.role === 'host';

  // ── Polling refresh ────────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const s = await getLanStatus();
      setStatus(s);
      if (s.role === 'host') {
        const list = await listLanClients();
        setClients(list);
        // Drop selection if the selected client disconnected.
        setSelectedClientId((prev) =>
          prev && list.some((c) => c.clientId === prev) ? prev : (list[0]?.clientId ?? null),
        );
      } else {
        setClients([]);
        setSelectedClientId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Tick once per second so "uptime" / "last seen" labels stay live without
  // hammering the API. The state value isn't used; the bump just forces a
  // re-render of the table.
  useEffect(() => {
    const t = window.setInterval(() => setTickKey((k) => k + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  // ── SSE push ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isHost) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(sseUrl);
      // Connect / disconnect / report all just trigger a refresh — same
      // strategy as ClusterPage. The SSE payloads are present in the
      // events but we don't trust them for state-of-truth merging.
      es.addEventListener('init', () => refresh());
      es.addEventListener('client_connected', () => refresh());
      es.addEventListener('client_disconnected', () => refresh());
      es.addEventListener('internal_report', () => {
        // Reports are per-client; reload only the currently-selected one
        // so we don't double-fetch the client list on every log line.
        if (selectedClientId) {
          loadReports(selectedClientId);
        }
      });
      es.onerror = () => {
        es?.close();
      };
    } catch {
      // EventSource not available — fall back to polling.
    }
    return () => {
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, sseUrl, selectedClientId]);

  // ── Reports ────────────────────────────────────────────────────────────

  const loadReports = useCallback(async (clientId: string) => {
    setReportsLoading(true);
    setReportsError(null);
    try {
      const body = await listLanReports(clientId, { limit: 100 });
      setReports(body.reports);
    } catch (err) {
      setReportsError(err instanceof Error ? err.message : String(err));
      setReports([]);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedClientId) {
      setReports([]);
      return;
    }
    loadReports(selectedClientId);
  }, [selectedClientId, loadReports]);

  // ── Actions ────────────────────────────────────────────────────────────

  const submitDispatch = async () => {
    if (!dispatchClientId) return;
    const text = dispatchText.trim();
    if (!text) return;
    setDispatching(true);
    try {
      await dispatchLanCommand(dispatchClientId, text);
      setDispatchClientId(null);
      setDispatchText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  const handleKick = async (clientId: string) => {
    if (!window.confirm(`Kick LAN client "${clientId}"?`)) return;
    try {
      await kickLanClient(clientId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const summary = status
    ? [
        `role=${status.role ?? '-'}`,
        status.role === 'host' && status.listen
          ? `listen=${status.listen.host}:${status.listen.port ?? '?'}`
          : null,
        `clients=${status.clientCount}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '-';

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">LAN Relay</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{summary}</div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => refresh()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100 dark:bg-zinc-900">
          {!status && (
            <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>
          )}

          {status && !isHost && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200">
              <div className="font-semibold mb-1">Not in host mode</div>
              <div>
                The LAN page only works on a bot instance configured as
                <code className="mx-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 font-mono text-xs">
                  lanRelay.instanceRole = "host"
                </code>
                . Current role:{' '}
                <code className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 font-mono text-xs">
                  {status.role ?? 'disabled'}
                </code>
                . Open the host machine's WebUI to manage LAN clients.
              </div>
            </div>
          )}

          {status && isHost && (
            <div
              className="grid grid-cols-1 lg:grid-cols-2 gap-4"
              // tickKey isn't read but its update forces formatDuration() to
              // recompute on each tick — see useEffect above.
              data-tick={tickKey}
            >
              <LanCard title="Clients" count={clients.length}>
                {clients.length === 0 ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
                    No clients connected.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700">
                          <th className="text-left py-2 px-2 font-medium">clientId</th>
                          <th className="text-left py-2 px-2 font-medium">lan</th>
                          <th className="text-left py-2 px-2 font-medium">uptime</th>
                          <th className="text-left py-2 px-2 font-medium">lastSeen</th>
                          <th className="text-right py-2 px-2 font-medium">actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clients.map((c) => {
                          const isSelected = c.clientId === selectedClientId;
                          return (
                            <tr
                              key={c.clientId}
                              className={`border-b border-zinc-100 dark:border-zinc-700/50 cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-blue-50 dark:bg-blue-950/30'
                                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/30'
                              }`}
                              onClick={() => setSelectedClientId(c.clientId)}
                            >
                              <td className="py-2 px-2 font-mono text-xs">
                                <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                                  {c.clientId}
                                </div>
                                {c.label && (
                                  <div className="text-zinc-500 dark:text-zinc-400">{c.label}</div>
                                )}
                              </td>
                              <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                                {c.lanAddress}
                              </td>
                              <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                                {formatDuration(Date.now() - c.startedAt)}
                              </td>
                              <td className="py-2 px-2 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                                {formatDuration(Date.now() - c.lastSeenAt)} ago
                              </td>
                              <td className="py-2 px-2">
                                <div
                                  className="flex items-center justify-end gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDispatchClientId(c.clientId);
                                      setDispatchText('');
                                    }}
                                    className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300"
                                    title="Dispatch command"
                                  >
                                    <Send className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleKick(c.clientId)}
                                    className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                                    title="Kick client"
                                  >
                                    <Skull className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </LanCard>

              <LanCard
                title="Internal Reports"
                count={reports.length}
                right={
                  selectedClientId && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                      {selectedClientId}
                    </div>
                  )
                }
              >
                {!selectedClientId && (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
                    Select a client to view its reports.
                  </div>
                )}
                {selectedClientId && reportsLoading && reports.length === 0 && (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
                    Loading…
                  </div>
                )}
                {selectedClientId && reportsError && (
                  <div className="text-sm text-red-600 dark:text-red-400 py-2">{reportsError}</div>
                )}
                {selectedClientId && !reportsLoading && reports.length === 0 && !reportsError && (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center flex items-center justify-center gap-2">
                    <Activity className="w-4 h-4" />
                    No reports yet.
                  </div>
                )}
                {reports.length > 0 && (
                  <div className="space-y-1 max-h-[500px] overflow-y-auto font-mono text-xs">
                    {reports.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-start gap-2 py-1 border-b border-zinc-100 dark:border-zinc-700/50 last:border-0"
                      >
                        <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
                          {formatTimestamp(r.ts).slice(11, 19)}
                        </span>
                        <span
                          className={`shrink-0 px-1.5 rounded text-[10px] uppercase ${levelBadgeClass(r.level)}`}
                        >
                          {r.level}
                        </span>
                        <span className="text-zinc-700 dark:text-zinc-200 break-all">{r.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </LanCard>
            </div>
          )}
        </div>
      </div>

      {/* Dispatch dialog */}
      {dispatchClientId && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => {
            if (!dispatching) setDispatchClientId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !dispatching) setDispatchClientId(null);
          }}
        >
          <div
            className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl p-5 w-full max-w-lg mx-4"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="font-semibold mb-1">
              Dispatch to <span className="font-mono">{dispatchClientId}</span>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
              The text below is fed into the client's command/AI pipeline as if you'd typed
              <code className="mx-1 px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 font-mono">
                /lan @{dispatchClientId} ...
              </code>
              on the host's IM.
            </div>
            <textarea
              value={dispatchText}
              onChange={(e) => setDispatchText(e.target.value)}
              placeholder="e.g. /status, or any natural-language prompt"
              className="w-full h-32 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
              disabled={dispatching}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-3">
              <button
                type="button"
                onClick={() => setDispatchClientId(null)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                disabled={dispatching}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDispatch}
                disabled={dispatching || !dispatchText.trim()}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                <Send className="w-4 h-4" />
                {dispatching ? 'Sending…' : 'Dispatch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
