/**
 * CodingAgentAPIBackend — StaticServer backend for coding-agent task records.
 *
 * Read-only over the tasks themselves: the WebUI shows what `/claude`, `/codex`, `/dsh`
 * and `delegate_agent_task` ran and what the CLI printed. Dispatch stays in chat — the
 * WebUI cannot say which chat a result should go back to. The one write route is cancel.
 *
 * Routes:
 *   GET  /api/agents/status                { enabled, executors, running, pending, queue }
 *   GET  /api/agents/tasks?limit&status     task records, newest first (capped for the list)
 *   GET  /api/agents/tasks/:id              one record, whole
 *   GET  /api/agents/tasks/:id/events       its lifecycle / progress timeline
 *   GET  /api/agents/tasks/:id/output       its raw stdout / stderr (tail-capped)
 *   POST /api/agents/tasks/:id/cancel       cancel a task this process is running
 *
 * Records outlive the process, so they answer even when the service is not running; only
 * `/status` and `/tasks` need it, and they report `enabled: false` rather than 503 so the
 * page can say so.
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { CodingAgentService } from '@/services/codingAgent/CodingAgentService';
import type { TaskRecordListing } from '@/services/codingAgent/CodingAgentTaskStore';
import { AGENT_EXECUTOR_NAMES } from '@/services/codingAgent/types';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/agents';

/**
 * How much of a transcript one request returns. A three-hour task can print megabytes, and
 * the WebUI polls; the tail is what an operator wants, and the whole file is on disk.
 */
const MAX_TRANSCRIPT_CHARS = 200_000;

/** The list shows enough of a prompt to recognize the task; the detail view has it whole. */
const LIST_PROMPT_CHARS = 300;
const LIST_RESULT_CHARS = 400;

export class CodingAgentAPIBackend implements Backend {
  readonly prefix = API_PREFIX;

  /**
   * The service is absent when `codingAgent.enabled` is false, so it is resolved per request
   * rather than held. Injectable so a test can drive the routes without the global container.
   */
  constructor(private readonly resolveService: () => CodingAgentService | null = resolveCodingAgentService) {}

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);
    const service = this.resolveService();

    if (req.method === 'GET') {
      return this.handleGet(subPath, req, service);
    }
    if (req.method === 'POST') {
      return this.handlePost(subPath, service);
    }
    return errorResponse('Method not allowed', 405);
  }

  private handleGet(subPath: string, req: Request, service: CodingAgentService | null): Response {
    const url = new URL(req.url);

    if (subPath === '' || subPath === '/' || subPath === '/status') {
      return this.handleStatus(service);
    }

    if (subPath === '/tasks') {
      if (!service) {
        return jsonResponse({ enabled: false, tasks: [] });
      }
      const limit = parsePositiveInt(url.searchParams.get('limit'), 100);
      const status = url.searchParams.get('status');
      const tasks = service
        .getTaskStore()
        .list(limit)
        .filter((task) => !status || task.status === status)
        .map(capForList);
      return jsonResponse({ enabled: true, tasks });
    }

    const eventsMatch = subPath.match(/^\/tasks\/([^/]+)\/events$/);
    if (eventsMatch) {
      const listing = this.findTask(service, eventsMatch[1]);
      return listing ? jsonResponse(service?.getTaskStore().readEvents(listing.directory) ?? []) : notFound();
    }

    const outputMatch = subPath.match(/^\/tasks\/([^/]+)\/output$/);
    if (outputMatch) {
      const listing = this.findTask(service, outputMatch[1]);
      if (!listing || !service) {
        return notFound();
      }
      const { stdout, stderr } = service.getTaskStore().readOutput(listing.directory);
      return jsonResponse({
        stdout: tail(stdout, MAX_TRANSCRIPT_CHARS),
        stderr: tail(stderr, MAX_TRANSCRIPT_CHARS),
        stdoutTruncated: stdout.length > MAX_TRANSCRIPT_CHARS,
        stderrTruncated: stderr.length > MAX_TRANSCRIPT_CHARS,
      });
    }

    const taskMatch = subPath.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const listing = this.findTask(service, taskMatch[1]);
      return listing ? jsonResponse(listing) : notFound();
    }

    return notFound();
  }

  private handlePost(subPath: string, service: CodingAgentService | null): Response {
    const cancelMatch = subPath.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (!cancelMatch) {
      return notFound();
    }
    // Cancel acts on a task this process is running; a record of a finished task is not
    // something to cancel, however recent it looks.
    const cancelled = service?.cancelTask(cancelMatch[1]) ?? false;
    return jsonResponse({ cancelled });
  }

  private handleStatus(service: CodingAgentService | null): Response {
    if (!service) {
      return jsonResponse({ enabled: false, executors: [] });
    }
    const status = service.getStatus();
    return jsonResponse({
      enabled: true,
      defaultExecutor: status.defaultExecutor,
      executors: AGENT_EXECUTOR_NAMES.map((name) => ({
        name,
        displayName: service.getExecutor(name).displayName,
      })),
      runningTasks: status.runningTasks,
      pendingTasks: status.pendingTasks,
      queue: status.queueInfo,
    });
  }

  /** A task record by id, or null when nothing ever ran under that id. */
  private findTask(service: CodingAgentService | null, taskId: string): TaskRecordListing | null {
    return service?.getTaskStore().get(taskId) ?? null;
  }
}

function resolveCodingAgentService(): CodingAgentService | null {
  try {
    return getContainer().resolve<CodingAgentService>(DITokens.CODING_AGENT_SERVICE);
  } catch {
    return null;
  }
}

function notFound(): Response {
  return errorResponse('Task not found', 404);
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function capForList(task: TaskRecordListing): TaskRecordListing {
  return {
    ...task,
    prompt: truncate(task.prompt, LIST_PROMPT_CHARS) ?? '',
    result: truncate(task.result, LIST_RESULT_CHARS),
    error: truncate(task.error, LIST_RESULT_CHARS),
  };
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}
