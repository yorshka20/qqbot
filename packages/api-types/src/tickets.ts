// `/api/tickets` — cluster task tickets, one directory per ticket on disk.

/**
 * Ticket lifecycle:
 *   draft      — editing, dispatch disabled
 *   ready      — done editing, can dispatch
 *   dispatched — cluster job created, `dispatchedJobId` filled
 *   done       — worker finished, result captured
 *   abandoned  — won't do, kept as a record
 */
export type TicketStatus = 'draft' | 'ready' | 'dispatched' | 'done' | 'abandoned';

export type TicketComplexity = 'trivial' | 'low' | 'medium' | 'high';

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
   * Cap on how many child workers the planner may spawn. Only meaningful when the
   * chosen `template` has `role: 'planner'`; surfaced to the planner through its
   * prompt, and not enforced by the hub.
   */
  maxChildren?: number;
  /** Hint the planner uses to pick an executor. */
  estimatedComplexity?: TicketComplexity;
}

/** Plan artifact a planner wrote for the ticket (`tickets/<id>/plan.md`). */
export interface TicketPlan {
  /** Whole `plan.md`, frontmatter included. */
  content: string;
  /** `plan_version` from the plan's frontmatter, when it parses. */
  version?: number;
}

/**
 * `GET /api/tickets/:id`. `plan` is null when no plan exists; archived revisions
 * (`plan-v<N>.md`) are not included.
 */
export interface Ticket {
  id: string;
  frontmatter: TicketFrontmatter;
  body: string;
  plan?: TicketPlan | null;
}

/** `GET /api/tickets` — frontmatter only, no body. */
export interface TicketsListResponse {
  tickets: TicketFrontmatter[];
}

/** `GET /api/tickets/template` */
export interface TicketTemplateResponse {
  content: string;
}

/** `GET /api/tickets/:id/results` */
export interface TicketResultsResponse {
  files: string[];
}

/** `GET /api/tickets/:id/results/:file` */
export interface TicketResultFileResponse {
  filename: string;
  content: string;
}

/** `POST /api/tickets` — the server allocates the id from the title. */
export interface TicketCreateBody {
  title: string;
  status?: TicketStatus;
  template?: string;
  project?: string;
  body?: string;
  maxChildren?: number;
  estimatedComplexity?: TicketComplexity;
}

/**
 * `PUT /api/tickets/:id`. An absent field keeps its value; `null` clears it.
 */
export interface TicketUpdateBody {
  title?: string;
  status?: TicketStatus;
  template?: string | null;
  project?: string | null;
  body?: string;
  dispatchedJobId?: string | null;
  maxChildren?: number | null;
  estimatedComplexity?: TicketComplexity | null;
}

/** `DELETE /api/tickets/:id` */
export interface TicketDeletedResponse {
  deleted: boolean;
}

/**
 * `results/job.json` — written by the cluster's ticket writeback at job terminal
 * time, and read over `GET /api/tickets/:id/results/job.json`. Unlike the live
 * `/api/cluster/jobs/:id` route this survives the cluster instance and travels
 * with the tickets repo, so any machine sharing it can render the run.
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
    integrationBranch?: string;
  };
  tasks: Array<{
    id: string;
    shortId: string;
    parentTaskId?: string;
    workerId?: string;
    workerTemplate?: string;
    source: string;
    status: string;
    branch?: string;
    mergedAt?: string;
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
