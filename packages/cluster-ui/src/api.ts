/**
 * The daemon's HTTP API. Paths and shapes are the `@qqbot/api-types` contract the daemon pins
 * with `jsonResponse<T>`; only the transport differs from a same-origin call: every request
 * carries the session's bearer token.
 */

import type {
  ClusterDaemonHealthResponse,
  ClusterEventListResponse,
  ClusterHelpAnswerBody,
  ClusterHelpAnsweredResponse,
  ClusterHelpRequest,
  ClusterJob,
  ClusterJobCancelledResponse,
  ClusterJobHistoryResponse,
  ClusterJobSubmitBody,
  ClusterJobWithDetail,
  ClusterLock,
  ClusterPausedResponse,
  ClusterStartedResponse,
  ClusterStatusResponse,
  ClusterTask,
  ClusterTaskCancelledResponse,
  ClusterTaskDetail,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryResponse,
  ClusterWorkerKilledResponse,
  ClusterWorkerRegistration,
  ProjectsResponse,
  Ticket,
  TicketCreateBody,
  TicketFrontmatter,
  TicketJobSnapshot,
  TicketResultFileResponse,
  TicketResultsResponse,
  TicketsListResponse,
  TicketTemplateResponse,
  TicketUpdateBody,
} from '@qqbot/api-types';
import { authorizedFetch } from './auth/session';

const CLUSTER = '/api/cluster';
const TICKETS = '/api/tickets';

async function failure(res: Response, action: string): Promise<Error> {
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(err.error ?? `${action} failed: ${res.status}`);
}

async function request<T>(action: string, path: string, init?: RequestInit): Promise<T> {
  const res = await authorizedFetch(path, init);
  if (!res.ok) {
    throw await failure(res, action);
  }
  return res.json() as Promise<T>;
}

function post<T>(action: string, path: string, body?: unknown): Promise<T> {
  return request<T>(
    action,
    path,
    body === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, String(value));
    }
  }
  return search.size > 0 ? `?${search}` : '';
}

const id = encodeURIComponent;

export function getDaemonHealth(): Promise<ClusterDaemonHealthResponse> {
  return request('Get daemon health', '/health');
}

// ── Agent cluster ──

export function getClusterStatus(): Promise<ClusterStatusResponse> {
  return request('Get cluster status', `${CLUSTER}/status`);
}

export function startCluster(): Promise<ClusterStartedResponse> {
  return post('Start cluster', `${CLUSTER}/start`);
}

export function stopCluster(): Promise<ClusterStartedResponse> {
  return post('Stop cluster', `${CLUSTER}/stop`);
}

export function pauseCluster(): Promise<ClusterPausedResponse> {
  return post('Pause cluster', `${CLUSTER}/pause`);
}

export function resumeCluster(): Promise<ClusterPausedResponse> {
  return post('Resume cluster', `${CLUSTER}/resume`);
}

export function listClusterWorkers(): Promise<ClusterWorkerRegistration[]> {
  return request('List cluster workers', `${CLUSTER}/workers`);
}

export function listClusterJobs(opts?: { limit?: number; offset?: number; status?: string }): Promise<ClusterJob[]> {
  return request('List cluster jobs', `${CLUSTER}/jobs${query({ ...opts })}`);
}

export function getClusterProjects(): Promise<ProjectsResponse> {
  return request('Get cluster projects', `${CLUSTER}/projects`);
}

export function getClusterTemplates(): Promise<ClusterTemplatesResponse> {
  return request('Get cluster templates', `${CLUSTER}/templates`);
}

export function getClusterJob(jobId: string): Promise<ClusterJobWithDetail> {
  return request('Get cluster job', `${CLUSTER}/jobs/${id(jobId)}`);
}

export function getClusterTask(taskId: string): Promise<ClusterTaskDetail> {
  return request('Get cluster task', `${CLUSTER}/tasks/${id(taskId)}`);
}

export function listClusterEvents(opts?: {
  limit?: number;
  offset?: number;
  type?: string;
}): Promise<ClusterEventListResponse> {
  return request('List cluster events', `${CLUSTER}/events${query({ ...opts })}`);
}

export function getClusterTaskEvents(taskId: string): Promise<ClusterEventListResponse> {
  return request('Get task events', `${CLUSTER}/tasks/${id(taskId)}/events`);
}

export function listClusterLocks(): Promise<ClusterLock[]> {
  return request('List cluster locks', `${CLUSTER}/locks`);
}

export function listClusterHelpRequests(): Promise<ClusterHelpRequest[]> {
  return request('List cluster help requests', `${CLUSTER}/help`);
}

export function createClusterJob(input: ClusterJobSubmitBody): Promise<ClusterTask> {
  return post('Create cluster job', `${CLUSTER}/jobs`, input);
}

export function killClusterWorker(workerId: string): Promise<ClusterWorkerKilledResponse> {
  return post('Kill worker', `${CLUSTER}/workers/${id(workerId)}/kill`);
}

export function killClusterTask(taskId: string, reason?: string): Promise<ClusterTaskCancelledResponse> {
  return post('Kill task', `${CLUSTER}/tasks/${id(taskId)}/kill`, { reason });
}

export function killClusterJob(jobId: string, reason?: string): Promise<ClusterJobCancelledResponse> {
  return post('Kill job', `${CLUSTER}/jobs/${id(jobId)}/kill`, { reason });
}

export function answerClusterHelpRequest(
  askId: string,
  input: ClusterHelpAnswerBody,
): Promise<ClusterHelpAnsweredResponse> {
  return post('Answer help request', `${CLUSTER}/help/${id(askId)}/answer`, input);
}

/** Paginated job history from the database, not limited to the in-memory window. */
export function listClusterHistoryJobs(opts?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<ClusterJobHistoryResponse> {
  return request('List cluster history jobs', `${CLUSTER}/history/jobs${query({ ...opts })}`);
}

export function listClusterHistoryWorkers(opts?: {
  limit?: number;
  offset?: number;
  jobId?: string;
  project?: string;
}): Promise<ClusterWorkerHistoryResponse> {
  return request('List cluster history workers', `${CLUSTER}/history/workers${query({ ...opts })}`);
}

// ── Tickets ──

export async function listTickets(): Promise<TicketFrontmatter[]> {
  const body = await request<TicketsListResponse>('List tickets', TICKETS);
  return body.tickets;
}

export function getTicket(ticketId: string): Promise<Ticket> {
  return request('Get ticket', `${TICKETS}/${id(ticketId)}`);
}

export async function getTicketTemplate(): Promise<string> {
  const body = await request<TicketTemplateResponse>('Get ticket template', `${TICKETS}/template`);
  return body.content;
}

export function createTicket(input: TicketCreateBody): Promise<Ticket> {
  return post('Create ticket', TICKETS, input);
}

/** An undefined field is preserved; `null` clears a nullable one. */
export function updateTicket(ticketId: string, patch: TicketUpdateBody): Promise<Ticket> {
  return request('Update ticket', `${TICKETS}/${id(ticketId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteTicket(ticketId: string): Promise<void> {
  const res = await authorizedFetch(`${TICKETS}/${id(ticketId)}`, { method: 'DELETE' });
  if (!res.ok) {
    throw await failure(res, 'Delete ticket');
  }
}

export async function listTicketResults(ticketId: string): Promise<string[]> {
  const res = await authorizedFetch(`${TICKETS}/${id(ticketId)}/results`);
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as TicketResultsResponse;
  return body.files;
}

export async function getTicketResult(ticketId: string, filename: string): Promise<string> {
  const body = await request<TicketResultFileResponse>(
    'Get ticket result',
    `${TICKETS}/${id(ticketId)}/results/${id(filename)}`,
  );
  return body.content;
}

/**
 * The last job that ran for a ticket, as written at job terminal time. Unlike
 * `/api/cluster/jobs/:id` it travels with the tickets repo, so any machine sharing it can read it.
 */
export async function getTicketJobSnapshot(ticketId: string): Promise<TicketJobSnapshot | null> {
  const res = await authorizedFetch(`${TICKETS}/${id(ticketId)}/results/job.json`);
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as TicketResultFileResponse;
  try {
    return JSON.parse(body.content) as TicketJobSnapshot;
  } catch {
    return null;
  }
}
