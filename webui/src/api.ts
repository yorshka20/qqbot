import { getFileApiBase, getInsightsApiBase, getMomentsApiBase, getQdrantApiBase, getReportApiBase, getZhihuApiBase } from './config'
import type {
  InsightDetailResponse,
  InsightListResponse,
  InsightStatsResponse,
  ListResponse,
  MomentsListResponse,
  MomentsSearchResponse,
  MomentsStatsResponse,
  QdrantCollectionsResponse,
  QdrantScrollResponse,
  QdrantSearchResponse,
  ReportDetailResponse,
  ReportListResponse,
  ZhihuContentDetailResponse,
  ZhihuContentsResponse,
  ZhihuStatsResponse,
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

// ────────────────────────────────────────────────────────────────────────────
// Zhihu API
// ────────────────────────────────────────────────────────────────────────────

function zhihuApiBase(): string {
  return getZhihuApiBase()
}

export async function listZhihuContents(opts?: {
  type?: string
  sinceTs?: number
  keyword?: string
  limit?: number
}): Promise<ZhihuContentsResponse> {
  const params = new URLSearchParams()
  if (opts?.type) params.set('type', opts.type)
  if (opts?.sinceTs) params.set('sinceTs', String(opts.sinceTs))
  if (opts?.keyword) params.set('keyword', opts.keyword)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`${zhihuApiBase()}/contents?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List zhihu contents failed: ${res.status}`)
  }
  return res.json() as Promise<ZhihuContentsResponse>
}

export async function getZhihuContent(
  targetType: string,
  targetId: number,
): Promise<ZhihuContentDetailResponse> {
  const res = await fetch(`${zhihuApiBase()}/content/${targetType}/${targetId}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get zhihu content failed: ${res.status}`)
  }
  return res.json() as Promise<ZhihuContentDetailResponse>
}

export async function getZhihuStats(): Promise<ZhihuStatsResponse> {
  const res = await fetch(`${zhihuApiBase()}/stats`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get zhihu stats failed: ${res.status}`)
  }
  return res.json() as Promise<ZhihuStatsResponse>
}

// ────────────────────────────────────────────────────────────────────────────
// Moments API
// ────────────────────────────────────────────────────────────────────────────

function momentsApiBase(): string {
  return getMomentsApiBase()
}

export async function getMomentsStats(): Promise<MomentsStatsResponse> {
  const res = await fetch(`${momentsApiBase()}/stats`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Get moments stats failed: ${res.status}`)
  }
  return res.json() as Promise<MomentsStatsResponse>
}

export async function listMoments(opts?: {
  tag?: string
  date?: string   // "YYYY-MM-DD"
  month?: string  // "YYYY-MM"
  year?: string   // "YYYY"
  type?: string
  offset?: string
  limit?: number
}): Promise<MomentsListResponse> {
  const params = new URLSearchParams()
  if (opts?.tag) params.set('tag', opts.tag)
  if (opts?.date) params.set('date', opts.date)
  else if (opts?.month) params.set('month', opts.month)
  else if (opts?.year) params.set('year', opts.year)
  if (opts?.type) params.set('type', opts.type)
  if (opts?.offset) params.set('offset', opts.offset)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`${momentsApiBase()}/list?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List moments failed: ${res.status}`)
  }
  return res.json() as Promise<MomentsListResponse>
}

export async function searchMoments(opts: {
  q: string
  limit?: number
  minScore?: number
}): Promise<MomentsSearchResponse> {
  const params = new URLSearchParams()
  params.set('q', opts.q)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.minScore) params.set('minScore', String(opts.minScore))
  const res = await fetch(`${momentsApiBase()}/search?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Search moments failed: ${res.status}`)
  }
  return res.json() as Promise<MomentsSearchResponse>
}

// ────────────────────────────────────────────────────────────────────────────
// Qdrant Explorer API
// ────────────────────────────────────────────────────────────────────────────

function qdrantApiBase(): string {
  return getQdrantApiBase()
}

export async function listQdrantCollections(): Promise<QdrantCollectionsResponse> {
  const res = await fetch(`${qdrantApiBase()}/collections`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List collections failed: ${res.status}`)
  }
  return res.json() as Promise<QdrantCollectionsResponse>
}

export async function searchQdrant(opts: {
  collection: string
  q: string
  limit?: number
  minScore?: number
}): Promise<QdrantSearchResponse> {
  const params = new URLSearchParams()
  params.set('collection', opts.collection)
  params.set('q', opts.q)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.minScore) params.set('minScore', String(opts.minScore))
  const res = await fetch(`${qdrantApiBase()}/search?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Qdrant search failed: ${res.status}`)
  }
  return res.json() as Promise<QdrantSearchResponse>
}

export async function scrollQdrant(opts: {
  collection: string
  limit?: number
}): Promise<QdrantScrollResponse> {
  const params = new URLSearchParams()
  params.set('collection', opts.collection)
  if (opts.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`${qdrantApiBase()}/scroll?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Qdrant scroll failed: ${res.status}`)
  }
  return res.json() as Promise<QdrantScrollResponse>
}
