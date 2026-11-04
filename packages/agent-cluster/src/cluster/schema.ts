/**
 * The cluster's SQLite tables. `createClusterTables` is idempotent and runs before any store
 * is built, in the daemon and in tests alike; column additions for existing databases are the
 * migrations in `ClusterManager`.
 */

import type { Database } from 'bun:sqlite';

export const CLUSTER_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cluster_jobs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  taskCount INTEGER DEFAULT 0,
  tasksCompleted INTEGER DEFAULT 0,
  tasksFailed INTEGER DEFAULT 0,
  metadata TEXT,
  ticketId TEXT,
  integrationBranch TEXT,
  planning TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_tasks (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  workerId TEXT,
  workerTemplate TEXT,
  source TEXT,
  createdAt TEXT NOT NULL,
  claimedAt TEXT,
  startedAt TEXT,
  completedAt TEXT,
  output TEXT,
  error TEXT,
  filesModified TEXT,
  diffSummary TEXT,
  metadata TEXT,
  parentTaskId TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_tasks_parent ON cluster_tasks(parentTaskId)`,
  `CREATE TABLE IF NOT EXISTS cluster_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  type TEXT NOT NULL,
  sourceWorkerId TEXT,
  targetWorkerId TEXT,
  data TEXT NOT NULL,
  jobId TEXT,
  taskId TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_events_worker ON cluster_events(sourceWorkerId, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_events_type ON cluster_events(type, seq)`,
  `CREATE TABLE IF NOT EXISTS cluster_help_requests (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  taskId TEXT,
  type TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  options TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  answeredBy TEXT,
  createdAt TEXT NOT NULL,
  answeredAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_workers (
  workerId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  taskId TEXT,
  role TEXT NOT NULL,
  project TEXT NOT NULL,
  templateName TEXT NOT NULL,
  status TEXT NOT NULL,
  registeredAt TEXT NOT NULL,
  lastSeen TEXT NOT NULL,
  exitedAt TEXT,
  syncCursor INTEGER NOT NULL DEFAULT 0,
  lastHubReportAt TEXT,
  lastReportSummary TEXT,
  lastReportNextSteps TEXT,
  lastReportStatus TEXT,
  tasksCompleted INTEGER NOT NULL DEFAULT 0,
  tasksFailed INTEGER NOT NULL DEFAULT 0,
  totalReports INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_workers_jobId ON cluster_workers(jobId)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_workers_registeredAt ON cluster_workers(registeredAt)`,
  `CREATE TABLE IF NOT EXISTS cluster_locks (
  filePath TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  taskId TEXT,
  claimedAt INTEGER NOT NULL,
  lastRenewed INTEGER NOT NULL,
  ttl INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_messages (
  id TEXT PRIMARY KEY,
  targetWorkerId TEXT NOT NULL,
  type TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_messages_target ON cluster_messages(targetWorkerId, read)`,
  `CREATE TABLE IF NOT EXISTS cluster_worktree_slots (
  project TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  taskId TEXT,
  leasedAt TEXT,
  lockHash TEXT,
  PRIMARY KEY (project, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_worktree_slots_task ON cluster_worktree_slots(taskId)`,
];

export function createClusterTables(db: Database): void {
  for (const sql of CLUSTER_TABLE_STATEMENTS) {
    db.run(sql);
  }
}
