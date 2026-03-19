import { getFileApiBase, getInsightsApiBase, getReportApiBase } from './config'
import type {
  InsightDetailResponse,
  InsightListResponse,
  InsightStatsResponse,
  ListResponse,
  ReportDetailResponse,
  ReportListResponse,
} from './types'

function apiBase(): string {
  return getFileApiBase()
}

function reportApiBase(): string {
  return getReportApiBase()
}

export async function listFiles(path: string): Promise<ListResponse> {
  const params = new URLSearchParams()
  if (path) {
    params.set('path', path)
  }
  const res = await fetch(`${apiBase()}/list?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List failed: ${res.status}`)
  }
  return res.json() as Promise<ListResponse>
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`${apiBase()}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Delete failed: ${res.status}`)
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  const res = await fetch(`${apiBase()}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Move failed: ${res.status}`)
  }
}

export async function renameFile(path: string, newName: string): Promise<void> {
  const res = await fetch(`${apiBase()}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName: newName.trim() }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Rename failed: ${res.status}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report API
// ────────────────────────────────────────────────────────────────────────────

export async function listReports(): Promise<ReportListResponse> {
  const res = await fetch(`${reportApiBase()}/list`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List reports failed: ${res.status}`)
  }
  return res.json() as Promise<ReportListResponse>
}

export async function getReport(id: string): Promise<ReportDetailResponse> {
  const res = await fetch(`${reportApiBase()}/${encodeURIComponent(id)}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get report failed: ${res.status}`)
  }
  return res.json() as Promise<ReportDetailResponse>
}

// ────────────────────────────────────────────────────────────────────────────
// Insights API
// ────────────────────────────────────────────────────────────────────────────

function insightsApiBase(): string {
  return getInsightsApiBase()
}

export async function listInsights(worthOnly = false): Promise<InsightListResponse> {
  const params = new URLSearchParams()
  if (!worthOnly) params.set('worthOnly', 'false')
  const res = await fetch(`${insightsApiBase()}/list?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List insights failed: ${res.status}`)
  }
  return res.json() as Promise<InsightListResponse>
}

export async function getInsight(articleMsgId: string): Promise<InsightDetailResponse> {
  const res = await fetch(`${insightsApiBase()}/${encodeURIComponent(articleMsgId)}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get insight failed: ${res.status}`)
  }
  return res.json() as Promise<InsightDetailResponse>
}

export async function getInsightStats(): Promise<InsightStatsResponse> {
  const res = await fetch(`${insightsApiBase()}/stats`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get insight stats failed: ${res.status}`)
  }
  return res.json() as Promise<InsightStatsResponse>
}
