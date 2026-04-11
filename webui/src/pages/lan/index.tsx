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
 *     responds with `role !== 'host'`, and we render NotHostBanner. The
 *     other endpoints all return 503 in that state — we don't even call them.
 */

import { Network, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  dispatchLanCommand,
  getLanStatus,
  getLanStreamUrl,
  kickLanClient,
  listLanClients,
  listLanReports,
} from '../../api';
import type { LanClientSnapshot, LanReportRow, LanStatusResponse } from '../../types';
import { ClientsTable } from './components/ClientsTable';
import { DispatchDialog } from './components/DispatchDialog';
import { LanCard } from './components/LanCard';
import { NotHostBanner } from './components/NotHostBanner';
import { ReportsPanel } from './components/ReportsPanel';

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

  // 1s tick: keeps `formatDuration(now - startedAt)` labels live without
  // re-fetching anything. We pass `now` into ClientsTable as a prop instead
  // of using a `data-tick` attribute hack.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const sseUrl = useMemo(() => getLanStreamUrl(), []);
  const isHost = status?.role === 'host';

  // ── Reports loader (declared before SSE effect so the SSE handler can
  //    reference it without TDZ) ─────────────────────────────────────────

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
        // Drop selection if the selected client disconnected; otherwise keep
        // it. Default-select the first client only when nothing is selected.
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

  // ── SSE push ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isHost) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(sseUrl);
      // Connect / disconnect events trigger a full refresh — we don't trust
      // the SSE payload as state-of-truth (mirrors ClusterPage). The
      // `internal_report` event is the one exception: reports are per-client
      // and reloading only the selected client is much cheaper than another
      // GET /clients per log line.
      es.addEventListener('init', () => refresh());
      es.addEventListener('client_connected', () => refresh());
      es.addEventListener('client_disconnected', () => refresh());
      es.addEventListener('internal_report', () => {
        if (selectedClientId) {
          loadReports(selectedClientId);
        }
      });
      es.onerror = () => {
        es?.close();
      };
    } catch {
      // EventSource not available — polling above stays as the fallback.
    }
    return () => {
      es?.close();
    };
  }, [isHost, sseUrl, selectedClientId, refresh, loadReports]);

  // ── Reload reports when selection changes ──────────────────────────────

  useEffect(() => {
    if (!selectedClientId) {
      setReports([]);
      return;
    }
    loadReports(selectedClientId);
  }, [selectedClientId, loadReports]);

  // ── Action handlers ────────────────────────────────────────────────────

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

  // ── Header summary ─────────────────────────────────────────────────────

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

  // ── Render ─────────────────────────────────────────────────────────────

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
          {!status && <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>}

          {status && !isHost && <NotHostBanner role={status.role} />}

          {status && isHost && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <LanCard title="Clients" count={clients.length}>
                <ClientsTable
                  clients={clients}
                  selectedClientId={selectedClientId}
                  onSelect={setSelectedClientId}
                  onDispatch={(clientId) => {
                    setDispatchClientId(clientId);
                    setDispatchText('');
                  }}
                  onKick={handleKick}
                  now={now}
                />
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
                <ReportsPanel
                  selectedClientId={selectedClientId}
                  reports={reports}
                  loading={reportsLoading}
                  error={reportsError}
                />
              </LanCard>
            </div>
          )}
        </div>
      </div>

      {dispatchClientId && (
        <DispatchDialog
          clientId={dispatchClientId}
          text={dispatchText}
          onTextChange={setDispatchText}
          submitting={dispatching}
          onCancel={() => setDispatchClientId(null)}
          onSubmit={submitDispatch}
        />
      )}
    </div>
  );
}
