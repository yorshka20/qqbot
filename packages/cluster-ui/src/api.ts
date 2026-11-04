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
  ClusterJobHistoryResponse,
  ClusterJobSubmitBody,
  ClusterJobWithDetail,
  ClusterLock,
  ClusterPausedResponse,
  ClusterStartedResponse,
  ClusterStatusResponse,
  ClusterTask,
  ClusterTaskAcknowledgedResponse,
  ClusterTaskCancelledResponse,
  ClusterTaskDetail,
  ClusterTaskMessagedResponse,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryResponse,
  ClusterWorkerKilledResponse,
  EnrichedWorkerRegistration,
  ProjectsResponse,
  Ticket,
  TicketCreateBody,
  TicketFrontmatter,
  TicketResultFileResponse,
  TicketResultsResponse,
  TicketsListResponse,
  TicketUpdateBody,
} from '@qqbot/api-types';
import { authorizedFetch } from './auth/session';

/** `POST /api/cluster/probe`: the daemon declares this shape itself, it is not in `@qqbot/api-types`. */
export interface TemplateProbeResult {
  templateName: string;
  type: string;
  ok: boolean;
  durationMs: number;
  reason?: string;
  credentialSource?: string;
  endpoint?: string;
  model?: string;
}

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

export function probeClusterTemplates(): Promise<TemplateProbeResult[]> {
  return post('Probe templates', `${CLUSTER}/probe`, {});
}

export function listClusterWorkers(): Promise<EnrichedWorkerRegistration[]> {
  return request('List cluster workers', `${CLUSTER}/workers`);
}

/** Pending, claimed and running tasks only: a task leaves this list the moment it ends. */
export function listClusterActiveTasks(): Promise<ClusterTask[]> {
  return request('List active tasks', `${CLUSTER}/tasks`);
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

export function getClusterTaskEvents(taskId: string): Promise<ClusterEventListResponse> {
  return request('Get task events', `${CLUSTER}/tasks/${id(taskId)}/events`);
}

export function listClusterLocks(): Promise<ClusterLock[]> {
  return request('List cluster locks', `${CLUSTER}/locks`);
}

/** `?status=all` lists answered and expired requests too, newest first. */
export function listClusterHelpRequests(status?: 'pending' | 'all'): Promise<ClusterHelpRequest[]> {
  return request('List cluster help requests', `${CLUSTER}/help${query({ status })}`);
}

export function acknowledgeClusterTask(taskId: string): Promise<ClusterTaskAcknowledgedResponse> {
  return post('Acknowledge task', `${CLUSTER}/tasks/${id(taskId)}/acknowledge`);
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

/** A message to a running task's worker; the route refuses (409) a task that has no live worker. */
export function sendClusterTaskMessage(taskId: string, text: string): Promise<ClusterTaskMessagedResponse> {
  return post('Send task message', `${CLUSTER}/tasks/${id(taskId)}/messages`, { text });
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

export function createTicket(body: TicketCreateBody): Promise<Ticket> {
  return post('Create ticket', TICKETS, body);
}

/** An undefined field is preserved; `null` clears a nullable one. */
export function updateTicket(ticketId: string, patch: TicketUpdateBody): Promise<Ticket> {
  return request('Update ticket', `${TICKETS}/${id(ticketId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
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
