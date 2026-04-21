import {
  getClusterApiBase,
  getDocsApiBase,
  getFileApiBase,
  getInsightsApiBase,
  getLanApiBase,
  getMemoryApiBase,
  getMomentsApiBase,
  getProjectsApiBase,
  getQdrantApiBase,
  getReportApiBase,
  getStatsApiBase,
  getTicketsApiBase,
  getZhihuApiBase,
} from './config';
import type {
  BehaviorResponse,
  ClusterEventListResponse,
  ClusterHelpRequest,
  ClusterJob,
  ClusterJobWithDetail,
  ClusterLock,
  ClusterStatus,
  ClustersResponse,
  ClusterTask,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryEntry,
  ClusterWorkerRegistration,
  DailyStatsResponse,
  DocsRootsResponse,
  EnrichedWorkerRegistration,
  EntitiesResponse,
  InsightDetailResponse,
  InsightListResponse,
  InsightStatsResponse,
  InterestEvolutionResponse,
  LanClientSnapshot,
  LanClientsResponse,
  LanReportsResponse,
  LanStatusResponse,
  ListResponse,
  MemoryGroupDetail,
  MemoryUserFactDetail,
  MomentsListResponse,
  MomentsSearchResponse,
  MomentsStatsResponse,
  PaginatedResponse,
  ProjectsResponse,
  QdrantCollectionsResponse,
  QdrantScrollResponse,
  QdrantSearchResponse,
  ReportDetailResponse,
  ReportListResponse,
  SentimentTrendResponse,
  StatsDateListResponse,
  Ticket,
  TicketFrontmatter,
  TicketStatus,
  TicketsListResponse,
  ZhihuContentDetailResponse,
  ZhihuContentsResponse,
  ZhihuStatsResponse,
} from './types';

function apiBase(): string {
  return getFileApiBase();
}

function docsApiBase(): string {
  return getDocsApiBase();
}

function reportApiBase(): string {
  return getReportApiBase();
}

function clusterApiBase(): string {
  return getClusterApiBase();
}

function projectsApiBase(): string {
  return getProjectsApiBase();
}

export async function listFiles(path: string): Promise<ListResponse> {
  const params = new URLSearchParams();
  if (path) {
    params.set('path', path);
  }
  const res = await fetch(`${apiBase()}/list?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List failed: ${res.status}`);
  }
  return res.json() as Promise<ListResponse>;
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`${apiBase()}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Delete failed: ${res.status}`);
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  const res = await fetch(`${apiBase()}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Move failed: ${res.status}`);
  }
}

export async function renameFile(path: string, newName: string): Promise<void> {
  const res = await fetch(`${apiBase()}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName: newName.trim() }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Rename failed: ${res.status}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Docs preview API (read-only; roots under repo: docs/, claude-learnings/, claude-workbook/)
// ────────────────────────────────────────────────────────────────────────────

export async function listDocsRoots(): Promise<DocsRootsResponse> {
  const res = await fetch(`${docsApiBase()}/roots`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List docs roots failed: ${res.status}`);
  }
  return res.json() as Promise<DocsRootsResponse>;
}

export async function listDocs(root: string, path: string): Promise<ListResponse> {
  const params = new URLSearchParams();
  params.set('root', root);
  if (path) {
    params.set('path', path);
  }
  const res = await fetch(`${docsApiBase()}/list?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List docs failed: ${res.status}`);
  }
  return res.json() as Promise<ListResponse>;
}

/** GET /api/docs/raw — returns Response (caller inspects Content-Type / body). */
export function docsRawUrl(root: string, path: string): string {
  const params = new URLSearchParams();
  params.set('root', root);
  params.set('path', path);
  return `${docsApiBase()}/raw?${params}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Report API
// ────────────────────────────────────────────────────────────────────────────

export async function listReports(): Promise<ReportListResponse> {
  const res = await fetch(`${reportApiBase()}/list`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List reports failed: ${res.status}`);
  }
  return res.json() as Promise<ReportListResponse>;
}

export async function getReport(id: string): Promise<ReportDetailResponse> {
  const res = await fetch(`${reportApiBase()}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get report failed: ${res.status}`);
  }
  return res.json() as Promise<ReportDetailResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Insights API
// ────────────────────────────────────────────────────────────────────────────

function insightsApiBase(): string {
  return getInsightsApiBase();
}

export async function listInsights(worthOnly = false): Promise<InsightListResponse> {
  const params = new URLSearchParams();
  if (!worthOnly) params.set('worthOnly', 'false');
  const res = await fetch(`${insightsApiBase()}/list?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List insights failed: ${res.status}`);
  }
  return res.json() as Promise<InsightListResponse>;
}

export async function getInsight(articleMsgId: string): Promise<InsightDetailResponse> {
  const res = await fetch(`${insightsApiBase()}/${encodeURIComponent(articleMsgId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get insight failed: ${res.status}`);
  }
  return res.json() as Promise<InsightDetailResponse>;
}

export async function getInsightStats(): Promise<InsightStatsResponse> {
  const res = await fetch(`${insightsApiBase()}/stats`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get insight stats failed: ${res.status}`);
  }
  return res.json() as Promise<InsightStatsResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Zhihu API
// ────────────────────────────────────────────────────────────────────────────

function zhihuApiBase(): string {
  return getZhihuApiBase();
}

export async function listZhihuContents(opts?: {
  type?: string;
  sinceTs?: number;
  keyword?: string;
  limit?: number;
}): Promise<ZhihuContentsResponse> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.sinceTs) params.set('sinceTs', String(opts.sinceTs));
  if (opts?.keyword) params.set('keyword', opts.keyword);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${zhihuApiBase()}/contents?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List zhihu contents failed: ${res.status}`);
  }
  return res.json() as Promise<ZhihuContentsResponse>;
}

export async function getZhihuContent(targetType: string, targetId: number): Promise<ZhihuContentDetailResponse> {
  const res = await fetch(`${zhihuApiBase()}/content/${targetType}/${targetId}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get zhihu content failed: ${res.status}`);
  }
  return res.json() as Promise<ZhihuContentDetailResponse>;
}

export async function getZhihuStats(): Promise<ZhihuStatsResponse> {
  const res = await fetch(`${zhihuApiBase()}/stats`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get zhihu stats failed: ${res.status}`);
  }
  return res.json() as Promise<ZhihuStatsResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Moments API
// ────────────────────────────────────────────────────────────────────────────

function momentsApiBase(): string {
  return getMomentsApiBase();
}

export async function getMomentsStats(): Promise<MomentsStatsResponse> {
  const res = await fetch(`${momentsApiBase()}/stats`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get moments stats failed: ${res.status}`);
  }
  return res.json() as Promise<MomentsStatsResponse>;
}

export async function listMoments(opts?: {
  tag?: string;
  date?: string; // "YYYY-MM-DD"
  month?: string; // "YYYY-MM"
  year?: string; // "YYYY"
  type?: string;
  offset?: string;
  limit?: number;
}): Promise<MomentsListResponse> {
  const params = new URLSearchParams();
  if (opts?.tag) params.set('tag', opts.tag);
  if (opts?.date) params.set('date', opts.date);
  else if (opts?.month) params.set('month', opts.month);
  else if (opts?.year) params.set('year', opts.year);
  if (opts?.type) params.set('type', opts.type);
  if (opts?.offset) params.set('offset', opts.offset);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${momentsApiBase()}/list?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List moments failed: ${res.status}`);
  }
  return res.json() as Promise<MomentsListResponse>;
}

export async function searchMoments(opts: {
  q: string;
  limit?: number;
  minScore?: number;
}): Promise<MomentsSearchResponse> {
  const params = new URLSearchParams();
  params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.minScore) params.set('minScore', String(opts.minScore));
  const res = await fetch(`${momentsApiBase()}/search?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Search moments failed: ${res.status}`);
  }
  return res.json() as Promise<MomentsSearchResponse>;
}

export async function getMomentsInterestEvolution(): Promise<InterestEvolutionResponse> {
  const res = await fetch(`${momentsApiBase()}/interest-evolution`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get interest evolution failed: ${res.status}`);
  }
  return res.json() as Promise<InterestEvolutionResponse>;
}

export async function getMomentsBehavior(): Promise<BehaviorResponse> {
  const res = await fetch(`${momentsApiBase()}/behavior`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get behavior failed: ${res.status}`);
  }
  return res.json() as Promise<BehaviorResponse>;
}

export async function getMomentsSentimentTrend(): Promise<SentimentTrendResponse> {
  const res = await fetch(`${momentsApiBase()}/sentiment-trend`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get sentiment trend failed: ${res.status}`);
  }
  return res.json() as Promise<SentimentTrendResponse>;
}

export async function getMomentsEntities(opts?: { type?: string; limit?: number }): Promise<EntitiesResponse> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${momentsApiBase()}/entities?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get entities failed: ${res.status}`);
  }
  return res.json() as Promise<EntitiesResponse>;
}

export async function getMomentsClusters(): Promise<ClustersResponse> {
  const res = await fetch(`${momentsApiBase()}/clusters`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get clusters failed: ${res.status}`);
  }
  return res.json() as Promise<ClustersResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Qdrant Explorer API
// ────────────────────────────────────────────────────────────────────────────

function qdrantApiBase(): string {
  return getQdrantApiBase();
}

export async function listQdrantCollections(): Promise<QdrantCollectionsResponse> {
  const res = await fetch(`${qdrantApiBase()}/collections`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List collections failed: ${res.status}`);
  }
  return res.json() as Promise<QdrantCollectionsResponse>;
}

export async function searchQdrant(opts: {
  collection: string;
  q: string;
  limit?: number;
  minScore?: number;
}): Promise<QdrantSearchResponse> {
  const params = new URLSearchParams();
  params.set('collection', opts.collection);
  params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.minScore) params.set('minScore', String(opts.minScore));
  const res = await fetch(`${qdrantApiBase()}/search?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Qdrant search failed: ${res.status}`);
  }
  return res.json() as Promise<QdrantSearchResponse>;
}

export async function scrollQdrant(opts: { collection: string; limit?: number }): Promise<QdrantScrollResponse> {
  const params = new URLSearchParams();
  params.set('collection', opts.collection);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${qdrantApiBase()}/scroll?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Qdrant scroll failed: ${res.status}`);
  }
  return res.json() as Promise<QdrantScrollResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Daily Stats API
// ────────────────────────────────────────────────────────────────────────────

function statsApiBase(): string {
  return getStatsApiBase();
}

export async function getDailyStats(date?: string): Promise<DailyStatsResponse> {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  const res = await fetch(`${statsApiBase()}?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get daily stats failed: ${res.status}`);
  }
  return res.json() as Promise<DailyStatsResponse>;
}

export async function getStatsDates(): Promise<StatsDateListResponse> {
  const res = await fetch(`${statsApiBase()}/dates`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get stats dates failed: ${res.status}`);
  }
  return res.json() as Promise<StatsDateListResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Memory Status API
// ────────────────────────────────────────────────────────────────────────────

function memoryApiBase(): string {
  return getMemoryApiBase();
}

export async function getMemoryStats(): Promise<{ stats: import('./types').MemoryGlobalStats }> {
  const res = await fetch(`${memoryApiBase()}/stats`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get memory stats failed: ${res.status}`);
  }
  return res.json();
}

export async function getMemoryGroups(): Promise<{ groups: import('./types').MemoryGroupStats[] }> {
  const res = await fetch(`${memoryApiBase()}/groups`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get memory groups failed: ${res.status}`);
  }
  return res.json();
}

export async function getMemoryGroupDetail(groupId: string): Promise<MemoryGroupDetail> {
  const res = await fetch(`${memoryApiBase()}/group/${encodeURIComponent(groupId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get memory group detail failed: ${res.status}`);
  }
  return res.json();
}

export async function getMemoryUserFacts(groupId: string, userId: string): Promise<MemoryUserFactDetail> {
  const res = await fetch(`${memoryApiBase()}/group/${encodeURIComponent(groupId)}/user/${encodeURIComponent(userId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get memory user facts failed: ${res.status}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────────
// Projects API (ProjectRegistry)
// ────────────────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectsResponse> {
  const res = await fetch(`${projectsApiBase()}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List projects failed: ${res.status}`);
  }
  return res.json() as Promise<ProjectsResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Agent Cluster API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Cluster status snapshot. Returned by `/api/cluster/status` whether or
 * not the cluster is currently started — `started` reflects the live
 * state and `status` is always populated (counters are zero when stopped).
 */
export async function getClusterStatus(): Promise<{ started: boolean; status: ClusterStatus }> {
  const res = await fetch(`${clusterApiBase()}/status`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster status failed: ${res.status}`);
  }
  return res.json() as Promise<{ started: boolean; status: ClusterStatus }>;
}

export async function startCluster(): Promise<{ started: boolean }> {
  const res = await fetch(`${clusterApiBase()}/start`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Start cluster failed: ${res.status}`);
  }
  return res.json() as Promise<{ started: boolean }>;
}

export async function stopCluster(): Promise<{ started: boolean }> {
  const res = await fetch(`${clusterApiBase()}/stop`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Stop cluster failed: ${res.status}`);
  }
  return res.json() as Promise<{ started: boolean }>;
}

export async function listClusterWorkers(): Promise<ClusterWorkerRegistration[]> {
  const res = await fetch(`${clusterApiBase()}/workers`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster workers failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterWorkerRegistration[]>;
}

export async function listClusterJobs(opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ClusterJob[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  const res = await fetch(`${clusterApiBase()}/jobs?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster jobs failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterJob[]>;
}

/** Fetch all registered projects from ProjectRegistry. */
export async function getClusterProjects(): Promise<ProjectsResponse> {
  const res = await fetch(`${clusterApiBase()}/projects`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster projects failed: ${res.status}`);
  }
  return res.json() as Promise<ProjectsResponse>;
}

/**
 * Snapshot of configured worker templates + per-project default
 * `workerPreference`. Used by the submit form's template picker.
 */
export async function getClusterTemplates(): Promise<ClusterTemplatesResponse> {
  const res = await fetch(`${clusterApiBase()}/templates`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster templates failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterTemplatesResponse>;
}

/**
 * Fetch a single job along with its tasks. Used by the WebUI to expand a
 * job row and show its task breakdown (status / output / error).
 */
export async function getClusterJob(jobId: string): Promise<ClusterJobWithDetail> {
  const res = await fetch(`${clusterApiBase()}/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster job failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterJobWithDetail>;
}

export async function listClusterTasks(): Promise<ClusterTask[]> {
  const res = await fetch(`${clusterApiBase()}/tasks`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster tasks failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterTask[]>;
}

/** Fetch a single task with full detail (description, output, metadata, children). */
export async function getClusterTask(taskId: string): Promise<ClusterTask & { children?: ClusterTask[] }> {
  const res = await fetch(`${clusterApiBase()}/tasks/${encodeURIComponent(taskId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster task failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterTask & { children?: ClusterTask[] }>;
}

export async function listClusterEvents(opts?: {
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<ClusterEventListResponse> {
  const params = new URLSearchParams();
  if (opts?.type) params.set('type', opts.type);
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  const res = await fetch(`${clusterApiBase()}/events?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster events failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterEventListResponse>;
}

/** Fetch events for a specific task (hub_report timeline). */
export async function getClusterTaskEvents(taskId: string): Promise<ClusterEventListResponse> {
  const res = await fetch(`${clusterApiBase()}/tasks/${encodeURIComponent(taskId)}/events`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get task events failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterEventListResponse>;
}

export async function listClusterLocks(): Promise<ClusterLock[]> {
  const res = await fetch(`${clusterApiBase()}/locks`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster locks failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterLock[]>;
}

export async function listClusterHelpRequests(): Promise<ClusterHelpRequest[]> {
  const res = await fetch(`${clusterApiBase()}/help`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster help requests failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterHelpRequest[]>;
}

export async function createClusterJob(input: {
  project: string;
  description: string;
  workerTemplate?: string;
  requirePlannerRole?: boolean;
  ticketId?: string;
}): Promise<ClusterTask> {
  const res = await fetch(`${clusterApiBase()}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Create cluster job failed: ${res.status}`);
  }
  return res.json() as Promise<ClusterTask>;
}

export async function pauseCluster(): Promise<{ paused: boolean }> {
  const res = await fetch(`${clusterApiBase()}/pause`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Pause cluster failed: ${res.status}`);
  }
  return res.json() as Promise<{ paused: boolean }>;
}

export async function resumeCluster(): Promise<{ paused: boolean }> {
  const res = await fetch(`${clusterApiBase()}/resume`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Resume cluster failed: ${res.status}`);
  }
  return res.json() as Promise<{ paused: boolean }>;
}

export async function killClusterWorker(workerId: string): Promise<{ killed: boolean }> {
  const res = await fetch(`${clusterApiBase()}/workers/${encodeURIComponent(workerId)}/kill`, { method: 'POST' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Kill worker failed: ${res.status}`);
  }
  return res.json() as Promise<{ killed: boolean }>;
}

export async function answerClusterHelpRequest(
  askId: string,
  input: { answer: string; answeredBy?: string },
): Promise<{ answered: boolean }> {
  const res = await fetch(`${clusterApiBase()}/help/${encodeURIComponent(askId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Answer help request failed: ${res.status}`);
  }
  return res.json() as Promise<{ answered: boolean }>;
}

/** Paginated job history from DB (not limited to in-memory window). */
export async function listClusterHistoryJobs(opts?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<PaginatedResponse<ClusterJob>> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.status) params.set('status', opts.status);
  const res = await fetch(`${clusterApiBase()}/history/jobs?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster history jobs failed: ${res.status}`);
  }
  return res.json() as Promise<PaginatedResponse<ClusterJob>>;
}

/** Paginated worker history from DB (full history, no time window). */
export async function listClusterHistoryWorkers(opts?: {
  limit?: number;
  offset?: number;
  jobId?: string;
  project?: string;
}): Promise<PaginatedResponse<ClusterWorkerHistoryEntry>> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.jobId) params.set('jobId', opts.jobId);
  if (opts?.project) params.set('project', opts.project);
  const res = await fetch(`${clusterApiBase()}/history/workers?${params}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List cluster history workers failed: ${res.status}`);
  }
  return res.json() as Promise<PaginatedResponse<ClusterWorkerHistoryEntry>>;
}

/** Get all workers for a specific job (from DB, no time window limit). */
export async function getClusterJobWorkers(jobId: string): Promise<EnrichedWorkerRegistration[]> {
  const res = await fetch(`${clusterApiBase()}/jobs/${encodeURIComponent(jobId)}/workers`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get cluster job workers failed: ${res.status}`);
  }
  return res.json() as Promise<EnrichedWorkerRegistration[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// LAN Relay API
// ────────────────────────────────────────────────────────────────────────────

function lanApiBase(): string {
  return getLanApiBase();
}

/**
 * Always-on status. On a non-host instance the response is still valid
 * (with `role !== 'host'`) so the LanPage can render an informative
 * "not in host mode" panel instead of failing.
 */
export async function getLanStatus(): Promise<LanStatusResponse> {
  const res = await fetch(`${lanApiBase()}/status`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get LAN status failed: ${res.status}`);
  }
  return res.json() as Promise<LanStatusResponse>;
}

export async function listLanClients(): Promise<LanClientSnapshot[]> {
  const res = await fetch(`${lanApiBase()}/clients`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List LAN clients failed: ${res.status}`);
  }
  const body = (await res.json()) as LanClientsResponse;
  return body.clients;
}

export async function getLanClient(clientId: string): Promise<LanClientSnapshot> {
  const res = await fetch(`${lanApiBase()}/clients/${encodeURIComponent(clientId)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get LAN client failed: ${res.status}`);
  }
  return res.json() as Promise<LanClientSnapshot>;
}

export async function listLanReports(
  clientId: string,
  opts?: { limit?: number; level?: 'debug' | 'info' | 'warn' | 'error' },
): Promise<LanReportsResponse> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.level) params.set('level', opts.level);
  const qs = params.toString();
  const url = `${lanApiBase()}/clients/${encodeURIComponent(clientId)}/reports${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List LAN reports failed: ${res.status}`);
  }
  return res.json() as Promise<LanReportsResponse>;
}

export async function dispatchLanCommand(clientId: string, text: string): Promise<{ dispatched: boolean }> {
  const res = await fetch(`${lanApiBase()}/clients/${encodeURIComponent(clientId)}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Dispatch LAN command failed: ${res.status}`);
  }
  return res.json() as Promise<{ dispatched: boolean }>;
}

export async function kickLanClient(clientId: string): Promise<{ kicked: boolean }> {
  const res = await fetch(`${lanApiBase()}/clients/${encodeURIComponent(clientId)}/kick`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Kick LAN client failed: ${res.status}`);
  }
  return res.json() as Promise<{ kicked: boolean }>;
}

/**
 * URL for the SSE stream. The LanPage opens an EventSource against this
 * and listens for `init` / `client_connected` / `client_disconnected` /
 * `internal_report` events. Returned as a string (not an EventSource)
 * so the page can decide when to (re)open it.
 */
export function getLanStreamUrl(): string {
  return `${lanApiBase()}/stream`;
}

// ────────────────────────────────────────────────────────────────────────────
// Logs API
// ────────────────────────────────────────────────────────────────────────────

import { getLogsApiBase } from './config';

/** SSE stream URL for real-time pm2 log output (streams from now, no history). */
export function getLogsStreamUrl(): string {
  return `${getLogsApiBase()}/stream`;
}

// ────────────────────────────────────────────────────────────────────────────
// Cluster Ticket API
// ────────────────────────────────────────────────────────────────────────────

function ticketsApiBase(): string {
  return getTicketsApiBase();
}

/** List all tickets (frontmatter only — no body). Newest first. */
export async function listTickets(): Promise<TicketFrontmatter[]> {
  const res = await fetch(`${ticketsApiBase()}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `List tickets failed: ${res.status}`);
  }
  const body = (await res.json()) as TicketsListResponse;
  return body.tickets;
}

/** Fetch a single ticket including its markdown body. */
export async function getTicket(id: string): Promise<Ticket> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get ticket failed: ${res.status}`);
  }
  return res.json() as Promise<Ticket>;
}

/** Fetch the default ticket body template (`tickets/_template.md`). Returns the raw markdown string. */
export async function getTicketTemplate(): Promise<string> {
  const res = await fetch(`${ticketsApiBase()}/template`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `getTicketTemplate failed: ${res.status}`);
  }
  const data = (await res.json()) as { content: string };
  return data.content;
}

/**
 * Create a new ticket. The server allocates the id from `<date>-<slug>`
 * (slug derived from title) and returns the full Ticket.
 */
export async function createTicket(input: {
  title: string;
  status?: TicketStatus;
  template?: string;
  project?: string;
  body?: string;
  /** Phase 3: enable planner-mode dispatch for this ticket. */
  usePlanner?: boolean;
  /** Phase 3: optional cap on planner child workers (passed via prompt). */
  maxChildren?: number;
  /** Hints for planner executor selection: trivial | low | medium | high. */
  estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high';
}): Promise<Ticket> {
  const res = await fetch(`${ticketsApiBase()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Create ticket failed: ${res.status}`);
  }
  return res.json() as Promise<Ticket>;
}

/**
 * Patch an existing ticket. Any field left undefined is preserved;
 * passing `null` to a nullable field clears it (used to remove
 * `template` / `project` / `dispatchedJobId`).
 */
export async function updateTicket(
  id: string,
  patch: {
    title?: string;
    status?: TicketStatus;
    template?: string | null;
    project?: string | null;
    body?: string;
    dispatchedJobId?: string | null;
    usePlanner?: boolean | null;
    maxChildren?: number | null;
    estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high' | null;
  },
): Promise<Ticket> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Update ticket failed: ${res.status}`);
  }
  return res.json() as Promise<Ticket>;
}

export async function deleteTicket(id: string): Promise<void> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Delete ticket failed: ${res.status}`);
  }
}

/** List result files for a ticket. */
export async function listTicketResults(id: string): Promise<string[]> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}/results`);
  if (!res.ok) return [];
  const body = (await res.json()) as { files: string[] };
  return body.files;
}

/** Read a specific result file content. */
export async function getTicketResult(id: string, filename: string): Promise<string> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}/results/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Get ticket result failed: ${res.status}`);
  }
  const body = (await res.json()) as { filename: string; content: string };
  return body.content;
}

/**
 * Structured snapshot of the last cluster job that ran for a ticket. Written
 * by ClusterTicketWriteback at job terminal time. Absent until the first
 * dispatch completes. Available on any LAN machine that shares the
 * cluster-tickets repo (via git sync) — unlike the live /api/cluster/jobs/:id
 * endpoint which only returns data for the local cluster instance.
 */
export interface TicketJobSnapshot {
  schemaVersion: number;
  clusterId: string;
  job: {
    id: string;
    ticketId?: string;
    project: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    taskCount: number;
    tasksCompleted: number;
    tasksFailed: number;
  };
  tasks: Array<{
    id: string;
    shortId: string;
    parentTaskId?: string;
    workerId?: string;
    workerTemplate?: string;
    source: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    diffSummary?: string;
    filesModified?: string;
    error?: string;
    resultFile: string;
  }>;
  workers: Array<{
    workerId: string;
    role: string;
    templateName: string;
    project: string;
    status: string;
    lastBoundTaskId?: string;
    lastReportStatus?: string;
    lastReportSummary?: string;
    registeredAt: number;
    exitedAt?: number;
    stats: { tasksCompleted: number; tasksFailed: number; totalReports: number };
  }>;
}

export async function getTicketJobSnapshot(id: string): Promise<TicketJobSnapshot | null> {
  const res = await fetch(`${ticketsApiBase()}/${encodeURIComponent(id)}/results/job.json`);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const body = (await res.json()) as { filename: string; content: string };
  try {
    return JSON.parse(body.content) as TicketJobSnapshot;
  } catch {
    return null;
  }
}
