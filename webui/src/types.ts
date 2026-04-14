export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

export interface ListResponse {
  items: FileItem[];
}

// ────────────────────────────────────────────────────────────────────────────
// Report Types
// ────────────────────────────────────────────────────────────────────────────

export interface ReportListItem {
  id: string;
  type: string;
  title: string;
  generatedAt: string;
  period: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

export interface ReportListResponse {
  reports: ReportListItem[];
}

export interface MessageEntry {
  time: string;
  sender: string;
  content: string;
  category: string;
  url?: string;
  filePath?: string;
  title?: string;
}

export interface GroupSummary {
  conversationId: string;
  groupName?: string;
  messageCount: number;
  senderCount: number;
  senders: string[];
  formattedMessages: string;
  messages?: MessageEntry[];
  categories: string[];
}

export interface ArticleSummary {
  title: string;
  url: string;
  summary: string;
  source: string;
  accountNick: string;
  sourceType: string;
  sharedBy?: string;
  sharedIn?: string;
  pubTime: number;
}

export interface WechatStats {
  period: string;
  sinceTs: number;
  messages: {
    total: number;
    groups: number;
    private: number;
    groupCount: number;
    privateCount: number;
  };
  articles: {
    total: number;
    oaPush: number;
    shared: number;
  };
  topGroups: Array<{
    conversationId: string;
    groupName?: string;
    messageCount: number;
    senderCount: number;
  }>;
  topAccounts: Array<{
    accountNick: string;
    articleCount: number;
  }>;
}

export interface StructuredReport {
  id: string;
  type: string;
  title: string;
  generatedAt: string;
  period: {
    start: string;
    end: string;
    label: string;
  };
  stats: WechatStats | null;
  groups: GroupSummary[];
  articles: ArticleSummary[];
  markdownContent: string;
}

export interface ReportMetadata {
  id: string;
  type: string;
  generatedAt: string;
  period: string;
  filePath: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

export interface ReportDetailResponse {
  report: StructuredReport;
  metadata: ReportMetadata;
}

// ────────────────────────────────────────────────────────────────────────────
// Insight Types (Article Analysis)
// ────────────────────────────────────────────────────────────────────────────

export interface InsightListItem {
  articleMsgId: string;
  title: string;
  url: string;
  source: string;
  headline: string;
  categoryTags: string[];
  worthReporting: boolean;
  analyzedAt: string;
  model: string;
  itemCount: number;
}

export interface InsightDetail {
  articleMsgId: string;
  title: string;
  url: string;
  source: string;
  headline: string;
  categoryTags: string[];
  items: Array<{
    type: string;
    content: string;
    tags: string[];
    importance: string;
  }>;
  worthReporting: boolean;
  analyzedAt: string;
  model: string;
}

export interface InsightStats {
  total: number;
  worthReporting: number;
  notWorth: number;
  byCategory: Array<{ tag: string; count: number }>;
}

export interface InsightListResponse {
  insights: InsightListItem[];
}

export interface InsightDetailResponse {
  insight: InsightDetail;
}

export interface InsightStatsResponse {
  stats: InsightStats;
}

// ────────────────────────────────────────────────────────────────────────────
// Zhihu Types
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuContentListItem {
  targetType: string;
  targetId: number;
  title: string;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl: string | null;
  excerpt: string;
  voteupCount: number;
  commentCount: number;
  questionTitle: string | null;
  createdTime: number;
  fetchedAt: string;
}

export interface ZhihuContentDetail {
  targetType: string;
  targetId: number;
  title: string;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl: string | null;
  content: string;
  excerpt: string;
  voteupCount: number;
  commentCount: number;
  questionId: number | null;
  questionTitle: string | null;
  createdTime: number;
  fetchedAt: string;
}

export interface ZhihuPageStats {
  totalFeedItems: number;
  feedByType: Array<{ targetType: string; count: number }>;
  feedByVerb: Array<{ verb: string; verbLabel: string; count: number }>;
  lastFetchTs: number;
}

export interface ZhihuContentsResponse {
  contents: ZhihuContentListItem[];
}

export interface ZhihuContentDetailResponse {
  content: ZhihuContentDetail;
}

export interface ZhihuStatsResponse {
  stats: ZhihuPageStats;
}

// ────────────────────────────────────────────────────────────────────────────
// Moments Types (WeChat 朋友圈)
// ────────────────────────────────────────────────────────────────────────────

export interface MomentItem {
  id: string | number;
  content: string;
  createTime: string;
  type: string;
  mediasCount: number;
  tags: string[];
  summary: string;
  imagePaths: string[];
  score?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TimelineEntry {
  month: string;
  count: number;
}

export interface MomentsStats {
  total: number;
  tagged: number;
  untagged: number;
  timeRange: { earliest: string; latest: string } | null;
  topTags: TagCount[];
  monthlyCount: TimelineEntry[];
}

export interface MomentsStatsResponse {
  stats: MomentsStats;
}

export interface MomentsListResponse {
  moments: MomentItem[];
  total: number;
  nextOffset: string | number | null;
}

export interface MomentsSearchResponse {
  moments: MomentItem[];
  query: string;
}

// ── Moments Analysis Types ──

export interface InterestEvolutionResponse {
  heatmap: Array<{ tag: string; month: string; count: number }>;
  tags: string[];
  months: string[];
}

export interface BehaviorResponse {
  hourDistribution: Array<{ hour: number; count: number }>;
  dayOfWeekDistribution: Array<{ day: number; label: string; count: number }>;
  monthlyFrequency: Array<{ month: string; count: number; avgGapDays: number }>;
  gapStats: { avgDays: number; medianDays: number; maxDays: number; minDays: number };
}

export interface SentimentTrendResponse {
  trend: Array<{
    month: string;
    avgScore: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    count: number;
  }>;
  overall: { avgScore: number; positive: number; negative: number; neutral: number; mixed: number; total: number };
  analyzedCount: number;
}

export interface EntitiesResponse {
  entities: Array<{ name: string; type: string; count: number }>;
  byType: Record<string, Array<{ name: string; count: number }>>;
  analyzedCount: number;
}

export interface ClustersResponse {
  clusters: Array<{ clusterId: number; label: string; count: number }>;
  clusteredCount: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Agent Cluster Types
// ────────────────────────────────────────────────────────────────────────────

export interface ClusterStatus {
  running: boolean;
  paused: boolean;
  activeWorkers: number;
  idleWorkers: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  workers: Array<{
    id: string;
    template: string;
    project: string;
    status: string;
    currentTaskDescription?: string;
    uptime: number;
  }>;
}

export interface ClusterWorkerRegistration {
  workerId: string;
  role?: string;
  project?: string;
  templateName?: string;
  status?: string;
  currentTaskId?: string;
  /** Kept after task completes — server may omit on old sessions */
  lastBoundTaskId?: string;
  /** Epoch ms when worker process exited */
  exitedAt?: number;
  lastSeen?: number;
  syncCursor?: number;
  /** Epoch ms of last hub_report */
  lastHubReportAt?: number;
  lastReportSummary?: string;
  lastReportNextSteps?: string;
  lastReportStatus?: string;
  stats?: { registeredAt?: number; tasksCompleted?: number; tasksFailed?: number; totalReports?: number };
  /** Process / hub registration time (epoch ms), mirrors stats.registeredAt */
  spawnedAt?: number;
  boundJobId?: string;
  boundTicketId?: string;
  boundTaskSummary?: string;
  /** Task id after server resolution (DB fallback) */
  resolvedTaskId?: string;
}

export interface ClusterJob {
  id: string;
  project: string;
  description: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  taskCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  ticketId: string;
}

export interface ClusterTask {
  id: string;
  jobId: string;
  project: string;
  description: string;
  status: string;
  workerId?: string;
  workerTemplate?: string;
  source?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  filesModified?: string;
  diffSummary?: string;
  metadata?: unknown;
  /**
   * Phase 3 multi-agent: parent task that spawned this one. Root tasks
   * (user-submitted) have this unset; planner-spawned children have it
   * set to the planner's taskId. Used by the WebUI to render the
   * task tree (one level of indentation: planner row → child rows).
   */
  parentTaskId?: string;
}

export interface ClusterEventEntry {
  seq: number;
  timestamp: number;
  type: string;
  sourceWorkerId?: string;
  targetWorkerId?: string;
  data: Record<string, unknown>;
  jobId?: string;
  taskId?: string;
}

/**
 * `/api/cluster/events` returns a bare array of events.
 * (Older versions of this type wrapped them in {events, total, limit, offset}
 * but the server has always returned the bare array — the wrapper was a
 * lie that worked because no caller ever read total/limit/offset.)
 */
export type ClusterEventListResponse = ClusterEventEntry[];

/**
 * `/api/cluster/jobs/:id` returns a job augmented with its tasks.
 */
export interface ClusterJobWithTasks extends ClusterJob {
  tasks: ClusterTask[];
}

/** Paginated response shape for history endpoints. */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** Worker registration with jobId included (from DB history queries). */
export interface ClusterWorkerHistoryEntry extends ClusterWorkerRegistration {
  jobId?: string;
}

/** Extended job detail with both tasks and workers. */
export interface ClusterJobWithDetail extends ClusterJobWithTasks {
  workers?: EnrichedWorkerRegistration[];
}

/** Enriched worker registration from the backend (GET /workers, GET /jobs/:id/workers). */
export interface EnrichedWorkerRegistration extends ClusterWorkerRegistration {
  spawnedAt: number;
  boundJobId?: string;
  boundTicketId?: string;
  boundTaskSummary?: string;
  resolvedTaskId?: string;
}

/**
 * One entry in the WorkerTemplates dictionary — mirrors the server's
 * snapshot response from `GET /api/cluster/templates`.
 */
export interface ClusterWorkerTemplate {
  name: string;
  type: string;
  /** Planner vs executor — root planner tasks must use a planner-role template. */
  role?: 'planner' | 'executor';
  command: string;
  maxConcurrent: number;
  capabilities: string[];
  costTier: 'low' | 'medium' | 'high';
}

/**
 * `/api/cluster/templates` response: list of configured templates plus a
 * map of project alias → default workerPreference. The WebUI submit form
 * uses this to render a template picker and default-select the project's
 * preferred template.
 */
export interface ClusterTemplatesResponse {
  templates: ClusterWorkerTemplate[];
  projectDefaults: Record<string, string>;
}

export interface ClusterLock {
  filePath: string;
  workerId: string;
  taskId?: string;
  claimedAt: number;
  lastRenewed: number;
  ttl: number;
}

export interface ClusterHelpRequest {
  id: string;
  workerId: string;
  taskId?: string;
  type: string;
  question: string;
  context?: string;
  options?: string[];
  status: string;
  answer?: string;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Projects (ProjectRegistry)
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectRegistryEntry {
  alias: string;
  path: string;
  type: string;
  description?: string;
  hasClaudeMd: boolean;
  promptTemplateKey?: string;
  isDefault: boolean;
  isConfig: boolean;
}

export interface ProjectsResponse {
  defaultAlias: string;
  projects: ProjectRegistryEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// Qdrant Explorer Types
// ────────────────────────────────────────────────────────────────────────────

export interface QdrantCollectionInfo {
  name: string;
  pointsCount: number;
  vectorSize: number;
  distance: string;
}

export interface QdrantCollectionsResponse {
  collections: QdrantCollectionInfo[];
}

export interface QdrantSearchHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantSearchResponse {
  results: QdrantSearchHit[];
  query: string;
  collection: string;
}

export interface QdrantScrollResponse {
  points: Array<{ id: string | number; payload: Record<string, unknown> }>;
  total: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Daily Stats Types
// ────────────────────────────────────────────────────────────────────────────

export interface ErrorEntry {
  timestamp: string;
  component: string;
  message: string;
}

export interface ProviderStats {
  provider: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptChars: number;
  responseChars: number;
}

export interface HourlyActivity {
  hour: number;
  messagesReceived: number;
  messagesSent: number;
  llmCalls: number;
}

export interface GroupActivity {
  groupName: string;
  groupId: string;
  messageCount: number;
}

export interface DailyStats {
  date: string;
  summary: {
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalLLMCalls: number;
    totalErrors: number;
    totalWarnings: number;
    totalTokensUsed: number;
    totalPromptChars: number;
    totalResponseChars: number;
  };
  providerStats: ProviderStats[];
  hourlyActivity: HourlyActivity[];
  topGroups: GroupActivity[];
  recentErrors: ErrorEntry[];
  logFileCount: number;
}

export interface DailyStatsResponse {
  stats: DailyStats;
}

export interface StatsDateListResponse {
  dates: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Memory Status Types
// ────────────────────────────────────────────────────────────────────────────

export interface MemoryGlobalStats {
  totalFacts: number;
  activeFacts: number;
  staleFacts: number;
  manualFacts: number;
  autoFacts: number;
}

export interface MemoryGroupStats {
  groupId: string;
  totalFacts: number;
  activeFacts: number;
  staleFacts: number;
  manualFacts: number;
  autoFacts: number;
  userCount: number;
}

export interface MemoryGroupUserSummary {
  userId: string;
  totalFacts: number;
  activeFacts: number;
  staleFacts: number;
  manualFacts: number;
  autoFacts: number;
}

export interface MemoryGroupDetail {
  groupId: string;
  totalFacts: number;
  users: MemoryGroupUserSummary[];
}

export interface MemoryFactEntry {
  factHash: string;
  scope: string;
  source: string;
  status: string;
  reinforceCount: number;
  hitCount: number;
  firstSeen: number;
  lastReinforced: number;
  staleSince?: number;
  ageDays: number;
}

export interface MemoryUserFactDetail {
  groupId: string;
  userId: string;
  totalFacts: number;
  facts: MemoryFactEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// LAN Relay Types
// ────────────────────────────────────────────────────────────────────────────

/** Returned by `/api/lan/status`. Always-on; usable on a non-host instance. */
export interface LanStatusResponse {
  enabled: boolean;
  /** `host` | `client` | `null` (LAN relay disabled or runtime not yet wired). */
  role: 'host' | 'client' | null;
  /** Listen address; only set when this instance is in host mode. */
  listen: { host: string; port: number | null } | null;
  clientCount: number;
}

/** Snapshot of a connected LAN client (JSON-safe view of `ClientEntry`). */
export interface LanClientSnapshot {
  clientId: string;
  label?: string;
  lanAddress: string;
  startedAt: number;
  connectedAt: number;
  lastSeenAt: number;
  enabledPlugins?: string[];
}

export interface LanClientsResponse {
  clients: LanClientSnapshot[];
}

export type LanReportLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LanReportRow {
  id: number;
  clientId: string;
  level: LanReportLevel;
  text: string;
  ts: number;
}

export interface LanReportsResponse {
  reports: LanReportRow[];
}

/** SSE event types pushed by `/api/lan/stream`. */
export interface LanStreamInitEvent {
  type: 'init';
  clients: LanClientSnapshot[];
}

export interface LanStreamClientConnectedEvent {
  type: 'client_connected';
  client: LanClientSnapshot;
}

export interface LanStreamClientDisconnectedEvent {
  type: 'client_disconnected';
  clientId: string;
}

export interface LanStreamInternalReportEvent {
  type: 'internal_report';
  clientId: string;
  level: LanReportLevel;
  text: string;
  ts: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Cluster Ticket Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a cluster task ticket. Mirrors the server-side
 * `TicketBackend` enum.
 *
 *   draft     — editing, dispatch disabled
 *   ready     — done editing, can dispatch
 *   dispatched — cluster job created, dispatchedJobId filled
 *   done      — worker finished, result captured
 *   abandoned — won't do, kept as record
 */
export type TicketStatus = 'draft' | 'ready' | 'dispatched' | 'done' | 'abandoned';

export interface TicketFrontmatter {
  id: string;
  title: string;
  status: TicketStatus;
  template?: string;
  project?: string;
  created: string;
  updated: string;
  dispatchedJobId?: string;
  /**
   * Phase 3 multi-agent: ticket dispatched in planner mode. When `true`,
   * dispatch forces the scheduler to pick a planner-role worker template
   * instead of a regular executor.
   */
  usePlanner?: boolean;
  /**
   * Phase 3 multi-agent: optional cap on how many child workers the
   * planner is allowed to spawn. Surfaced to the planner via prompt only
   * — the hub does not hard-enforce this number.
   */
  maxChildren?: number;
  /**
   * Hints to the planner about task complexity, used for executor selection:
   *   trivial | low  → planner may dispatch as a single task directly
   *   medium             → normal executor selection
   *   high              → planner should consider claude-sonnet executor
   */
  estimatedComplexity?: 'trivial' | 'low' | 'medium' | 'high';
}

/** Full ticket including markdown body. Returned by GET /api/tickets/:id. */
export interface Ticket {
  id: string;
  frontmatter: TicketFrontmatter;
  body: string;
}

/** Listing endpoint shape. Frontmatter only — no body. */
export interface TicketsListResponse {
  tickets: TicketFrontmatter[];
}
