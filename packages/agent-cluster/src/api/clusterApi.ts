/**
 * ClusterApi — the cluster's REST API, mounted on the daemon's server under `/api/cluster`.
 *
 * Routes that need a live cluster gate themselves with `requireStarted()`; routes that
 * should work even when the cluster is stopped (control plane: status / start / stop, plus
 * static config snapshots like templates / projects) skip the gate.
 *
 * Routes:
 *   Always available:
 *   - GET  /api/cluster/status            { started, status }
 *   - GET  /api/cluster/templates         worker templates + projectDefaults
 *   - GET  /api/cluster/projects          ProjectRegistry snapshot
 *   - POST /api/cluster/start             idempotent
 *   - POST /api/cluster/stop              idempotent
 *
 *   Require started cluster (else 503):
 *   - GET  /api/cluster/workers
 *   - GET  /api/cluster/jobs
 *   - GET  /api/cluster/jobs/:id
 *   - GET  /api/cluster/tasks
 *   - GET  /api/cluster/tasks/:id/events
 *   - GET  /api/cluster/events
 *   - GET  /api/cluster/locks
 *   - GET  /api/cluster/help
 *   - GET  /api/cluster/stream            SSE
 *   - POST /api/cluster/jobs              submit task
 *   - POST /api/cluster/pause
 *   - POST /api/cluster/resume
 *   - POST /api/cluster/probe          { templates?: string[] } → WorkerProbeResult[]
 *   - POST /api/cluster/workers/:id/kill
 *   - POST /api/cluster/tasks/:id/kill
 *   - POST /api/cluster/jobs/:id/kill
 *   - POST /api/cluster/tasks/:id/messages  { text, from? } → a directive to the task's running worker
 *   - POST /api/cluster/tasks/:id/acknowledge  a person saw this task; the inbox drops it
 *   - GET  /api/cluster/help?status=all      answered requests too
 *   - POST /api/cluster/help/:id/answer
 */

import type {
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
  ClusterTaskAcknowledgedResponse,
  ClusterTaskCancelledResponse,
  ClusterTaskDetail,
  ClusterTaskMessageBody,
  ClusterTaskMessagedResponse,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryResponse,
  ClusterWorkerKilledResponse,
  ClusterWorkerTemplate,
  EnrichedWorkerRegistration,
  ProjectsResponse,
} from '@qqbot/api-types';
import { logger } from '@qqbot/shared';
import type { ClusterManager } from '../cluster/ClusterManager';
import type { HubRoute } from '../cluster/hub/ContextHub';
import type { ClusterEventType, TaskRecord, WorkerRegistration } from '../cluster/types';
import { templateModel } from '../cluster/WorkerPool';
import type { WorkerProbeResult } from '../cluster/WorkerProbe';
import type { ProjectRegistry } from '../codingAgent/ProjectRegistry';
import { errorResponse, jsonResponse } from './http';

const API_PREFIX = '/api/cluster';

export class ClusterApi implements HubRoute {
  readonly prefix = API_PREFIX;

  constructor(
    private readonly cluster: ClusterManager,
    private readonly projectRegistry: ProjectRegistry,
  ) {}

  private enrichWorkerRegistrations(
    cluster: ClusterManager,
    workers: WorkerRegistration[],
  ): EnrichedWorkerRegistration[] {
    const sched = cluster.getScheduler();
    return workers.map((w) => {
      const hintedId = w.currentTaskId ?? w.lastBoundTaskId;
      let task = hintedId ? sched.findTask(hintedId) : undefined;
      if (!task) {
        task = sched.findLatestTaskForWorker(w.workerId);
      }
      let boundJobId: string | undefined;
      let boundTicketId: string | undefined;
      let boundTaskSummary: string | undefined;
      let resolvedTaskId: string | undefined;
      if (task) {
        resolvedTaskId = task.id;
        boundJobId = task.jobId;
        const desc = task.description || '';
        boundTaskSummary = desc.length > 280 ? `${desc.slice(0, 280)}…` : desc;
        const job = sched.resolveJob(task.jobId);
        boundTicketId = job?.ticketId;
      }
      return {
        ...w,
        spawnedAt: w.stats.registeredAt,
        boundJobId,
        boundTicketId,
        boundTaskSummary,
        resolvedTaskId,
      };
    });
  }

  /**
   * Cap a task's `output` / `description` for the `/jobs/:id` list response.
   * The WebUI polls that route every 2s while a job row is expanded, so an
   * unbounded worker stdout would be re-sent in full on every tick; `GET
   * /tasks/:id` (the single-task audit view) still returns the full record.
   */
  private capTaskForList(t: TaskRecord): TaskRecord & { outputBytes?: number; outputTruncated?: boolean } {
    const OUT_CAP = 16384;
    const DESC_CAP = 2000;
    const full = t.output ?? '';
    return {
      ...t,
      description:
        t.description && t.description.length > DESC_CAP ? `${t.description.slice(0, DESC_CAP)}…` : t.description,
      output: full.length > OUT_CAP ? full.slice(-OUT_CAP) : t.output || undefined,
      outputBytes: full.length || undefined,
      outputTruncated: full.length > OUT_CAP || undefined,
    };
  }

  /**
   * Returns either the live ClusterManager (when started) or a 503
   * Response that the caller should pipe straight back to the client.
   * Use this in handlers that can't function without a running cluster.
   */
  private requireStarted(): ClusterManager | Response {
    if (!this.cluster.isStarted()) {
      return errorResponse('Agent Cluster not running', 503);
    }
    return this.cluster;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method === 'GET') {
      return this.handleGet(subPath, req);
    }

    if (req.method === 'POST') {
      return this.handlePost(subPath, req);
    }

    return errorResponse('Method not allowed', 405);
  }

  private handleGet(subPath: string, req: Request): Response {
    const url = new URL(req.url);

    // ── Always-on routes (work even when cluster is stopped) ──
    switch (subPath) {
      case '':
      case '/':
      case '/status': {
        return jsonResponse<ClusterStatusResponse>({
          started: this.cluster.isStarted(),
          status: this.cluster.getStatus(),
        });
      }

      case '/templates': {
        const config = this.cluster.getConfig();
        const templates: ClusterWorkerTemplate[] = Object.entries(config.workerTemplates).map(([name, t]) => ({
          name,
          type: t.type,
          role: t.role ?? 'executor',
          command: t.command,
          model: templateModel(t),
          maxConcurrent: t.maxConcurrent,
          capabilities: t.capabilities,
          costTier: t.costTier,
        }));
        const projectDefaults: Record<string, string> = {};
        for (const [alias, p] of Object.entries(config.projects)) {
          projectDefaults[alias] = p.workerPreference;
        }
        return jsonResponse<ClusterTemplatesResponse>({ templates, projectDefaults });
      }

      case '/projects': {
        try {
          const registry = this.projectRegistry;
          const defaultAlias = registry.getDefaultProject();
          const projects = registry.list().map((p) => ({
            alias: p.alias,
            path: p.path,
            type: p.type,
            description: p.description,
            hasClaudeMd: p.hasClaudeMd,
            promptTemplateKey: p.promptTemplateKey,
            isDefault: p.alias === defaultAlias,
            isConfig: registry.isConfigProject(p.alias),
          }));
          projects.sort((a, b) => a.alias.localeCompare(b.alias));
          return jsonResponse<ProjectsResponse>({ defaultAlias, projects });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }

      // Fall through to gated routes below.
    }

    // ── Gated routes (require a started cluster) ──
    const gated = this.requireStarted();
    if (gated instanceof Response) return gated;
    const live = gated;

    switch (subPath) {
      case '/workers':
        return jsonResponse<EnrichedWorkerRegistration[]>(
          this.enrichWorkerRegistrations(live, live.getHub().workerRegistry.getAll()),
        );

      case '/jobs': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const status = url.searchParams.get('status') || undefined;
        const jobs = live.getScheduler().getJobs({ status, limit, offset });
        return jsonResponse<ClusterJob[]>(jobs);
      }

      case '/tasks':
        return jsonResponse<ClusterTask[]>(live.getScheduler().getActiveTasks());

      case '/events': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const type = url.searchParams.get('type') || undefined;
        const events = live.getHub().eventLog.query({ type: type as ClusterEventType | undefined, limit, offset });
        return jsonResponse<ClusterEventListResponse>(events);
      }

      case '/locks':
        return jsonResponse<ClusterLock[]>(live.getHub().lockManager.getActiveLocks());

      case '/help': {
        // `?status=all` includes answered and expired requests, newest first; default is pending only.
        const status = new URL(req.url).searchParams.get('status') === 'all' ? 'all' : 'pending';
        return jsonResponse<ClusterHelpRequest[]>(live.getHub().getHelpRequests(status));
      }

      case '/stream':
        return this.handleSSEStream(live);

      default: {
        // /history/jobs — paginated job history from DB
        if (subPath === '/history/jobs') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);
          const status = url.searchParams.get('status') || undefined;
          const result = live.getScheduler().getJobsFromDb({ limit, offset, status });
          return jsonResponse<ClusterJobHistoryResponse>(result);
        }

        // /history/workers — paginated worker history from DB
        if (subPath === '/history/workers') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);
          const jobId = url.searchParams.get('jobId') || undefined;
          const project = url.searchParams.get('project') || undefined;
          const result = live.getHub().workerRegistry.getWorkersFromDb({ limit, offset, jobId, project });
          return jsonResponse<ClusterWorkerHistoryResponse>(result);
        }

        // /jobs/:id/workers — workers for a specific job
        const jobWorkersMatch = subPath.match(/^\/jobs\/([^/]+)\/workers$/);
        if (jobWorkersMatch) {
          const jobId = jobWorkersMatch[1];
          const workers = live.getHub().workerRegistry.getWorkersByJobId(jobId);
          return jsonResponse<EnrichedWorkerRegistration[]>(this.enrichWorkerRegistrations(live, workers));
        }

        // /jobs/:id
        const jobMatch = subPath.match(/^\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const job = live.getScheduler().getJob(jobMatch[1]);
          if (!job) return errorResponse('Job not found', 404);
          const tasks = live
            .getScheduler()
            .getJobTasks(jobMatch[1])
            .map((t) => this.capTaskForList(t));
          const workers = live.getHub().workerRegistry.getWorkersByJobId(jobMatch[1]);
          return jsonResponse<ClusterJobWithDetail>({
            ...job,
            tasks,
            workers: this.enrichWorkerRegistrations(live, workers),
          });
        }

        // /tasks/:id — single task detail (includes full description, output, metadata)
        const taskMatch = subPath.match(/^\/tasks\/([^/]+)$/);
        if (taskMatch) {
          const task = live.getScheduler().findTask(taskMatch[1]);
          if (!task) return errorResponse('Task not found', 404);
          // Include child tasks if this is a planner task
          const children = live.getScheduler().getChildTasks(taskMatch[1]);
          return jsonResponse<ClusterTaskDetail>({ ...task, children: children.length > 0 ? children : undefined });
        }

        // /tasks/:id/events
        const taskEventsMatch = subPath.match(/^\/tasks\/([^/]+)\/events$/);
        if (taskEventsMatch) {
          const events = live.getHub().eventLog.query({ taskId: taskEventsMatch[1] });
          return jsonResponse<ClusterEventListResponse>(events);
        }

        return errorResponse('Not found', 404);
      }
    }
  }

  private async handlePost(subPath: string, req: Request): Promise<Response> {
    // ── Always-on control plane (work even when cluster is stopped) ──
    if (subPath === '/start') {
      if (!this.cluster.isStarted()) {
        try {
          await this.cluster.start();
        } catch (err) {
          logger.error('[ClusterApi] /start failed:', err);
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }
      return jsonResponse<ClusterStartedResponse>({ started: true });
    }

    // Workers are detached processes and keep running; only scheduling stops.
    if (subPath === '/stop') {
      if (this.cluster.isStarted()) {
        try {
          await this.cluster.stop();
        } catch (err) {
          logger.error('[ClusterApi] /stop failed:', err);
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }
      return jsonResponse<ClusterStartedResponse>({ started: false });
    }

    // ── Gated routes (require a started cluster) ──
    const gated = this.requireStarted();
    if (gated instanceof Response) return gated;
    const live = gated;

    switch (subPath) {
      case '/jobs': {
        let body: Partial<ClusterJobSubmitBody>;
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
        if (!body.project || !body.description) {
          return errorResponse('Missing required fields: project, description', 400);
        }
        if (body.planning !== undefined && body.planning !== 'interactive' && body.planning !== 'auto') {
          return errorResponse("planning must be 'interactive' or 'auto'", 400);
        }
        const task = await live.submitTask(body.project, body.description, {
          workerTemplate: body.workerTemplate,
          requirePlannerRole: body.requirePlannerRole === true ? true : undefined,
          ticketId: body.ticketId?.trim() || undefined,
          planning: body.planning,
        });
        if (!task) {
          return errorResponse(
            'Failed to create task (unknown project, unknown or disabled workerTemplate, or requirePlannerRole could not resolve a planner template)',
            400,
          );
        }
        return jsonResponse<ClusterTask>(task, 201);
      }

      case '/pause': {
        live.pause();
        return jsonResponse<ClusterPausedResponse>({ paused: true });
      }

      case '/resume': {
        live.resume();
        return jsonResponse<ClusterPausedResponse>({ paused: false });
      }

      case '/probe': {
        const body = (await req.json().catch(() => ({}))) as { templates?: unknown };
        const templates = Array.isArray(body.templates)
          ? body.templates.filter((t): t is string => typeof t === 'string')
          : undefined;
        const results = await live.probeWorkerTemplates(templates ? { templates } : undefined);
        return jsonResponse<WorkerProbeResult[]>(results);
      }

      default: {
        // /workers/:id/kill
        const killMatch = subPath.match(/^\/workers\/([^/]+)\/kill$/);
        if (killMatch) {
          const killed = await live.killWorker(killMatch[1]);
          return jsonResponse<ClusterWorkerKilledResponse>({ killed });
        }

        // /tasks/:id/kill
        const taskKillMatch = subPath.match(/^\/tasks\/([^/]+)\/kill$/);
        if (taskKillMatch) {
          const body = (await req.json().catch(() => ({}))) as { reason?: string };
          const result = await live.getScheduler().cancelTask(taskKillMatch[1], body.reason);
          if (!result.ok) {
            if (result.code === 'not_found') return errorResponse('Task not found', 404);
            return errorResponse(`Task already terminal (status: ${result.status})`, 409);
          }
          return jsonResponse<ClusterTaskCancelledResponse>({
            cancelled: true,
            taskId: taskKillMatch[1],
            cascadedChildren: result.cascadedChildren,
          });
        }

        // /jobs/:id/kill
        const jobKillMatch = subPath.match(/^\/jobs\/([^/]+)\/kill$/);
        if (jobKillMatch) {
          const body = (await req.json().catch(() => ({}))) as { reason?: string };
          const result = await live.getScheduler().cancelJob(jobKillMatch[1], body.reason);
          if (!result.ok) {
            if (result.code === 'not_found') return errorResponse('Job not found', 404);
            return errorResponse(`Job already terminal (status: ${result.status})`, 409);
          }
          return jsonResponse<ClusterJobCancelledResponse>({
            cancelled: true,
            jobId: jobKillMatch[1],
            cancelledTasks: result.cancelledTasks,
          });
        }

        // /tasks/:id/messages
        const messageMatch = subPath.match(/^\/tasks\/([^/]+)\/messages$/);
        if (messageMatch) {
          const body = (await req.json().catch(() => ({}))) as Partial<ClusterTaskMessageBody>;
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return errorResponse('Missing required field: text', 400);
          const task = live.getScheduler().findTask(messageMatch[1]);
          if (!task) return errorResponse('Task not found', 404);
          if (task.status !== 'running' || !task.workerId) {
            return errorResponse(`Task is ${task.status}; only a running worker can take a message`, 409);
          }
          live.getHub().messageWorker(task.workerId, task.id, text, body.from?.trim() || 'owner');
          return jsonResponse<ClusterTaskMessagedResponse>({ delivered: true, workerId: task.workerId });
        }

        // /tasks/:id/acknowledge
        const ackMatch = subPath.match(/^\/tasks\/([^/]+)\/acknowledge$/);
        if (ackMatch) {
          const acknowledgedAt = live.getScheduler().acknowledgeTask(ackMatch[1]);
          if (!acknowledgedAt) return errorResponse('Task not found', 404);
          live.getHub().taskAcknowledged(ackMatch[1], acknowledgedAt);
          return jsonResponse<ClusterTaskAcknowledgedResponse>({ taskId: ackMatch[1], acknowledgedAt });
        }

        // /help/:id/answer
        const answerMatch = subPath.match(/^\/help\/([^/]+)\/answer$/);
        if (answerMatch) {
          let body: Partial<ClusterHelpAnswerBody>;
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return errorResponse('Invalid JSON body', 400);
          }
          if (!body.answer) {
            return errorResponse('Missing required field: answer', 400);
          }
          const answered = live.answerHelpRequest(answerMatch[1], body.answer, body.answeredBy || 'human');
          return jsonResponse<ClusterHelpAnsweredResponse>({ answered });
        }

        return errorResponse('Not found', 404);
      }
    }
  }

  private handleSSEStream(cluster: ClusterManager): Response {
    const hub = cluster.getHub();

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            closed = true;
          }
        };

        // Send initial worker state
        send('init', { workers: hub.workerRegistry.getAll() });

        // Register with hub SSE manager if available
        hub.addSSESubscriber({
          send,
          close: () => {
            closed = true;
          },
        });
      },
      cancel() {
        // cleanup handled by subscriber close
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
