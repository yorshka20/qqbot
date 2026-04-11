/**
 * ClusterAPIBackend — StaticServer backend for Agent Cluster REST API.
 *
 * Single source of truth for HTTP access to the cluster. Mounted on
 * StaticServer (port 8888) so WebUI can hit it regardless of whether the
 * cluster is currently running. Routes that need a live cluster gate
 * themselves with `requireStarted()`; routes that should work even when
 * the cluster is stopped (control plane: status / start / stop, plus
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
 *   - POST /api/cluster/workers/:id/kill
 *   - POST /api/cluster/help/:id/answer
 */

import type { ClusterManager } from '@/cluster/ClusterManager';
import type { ClusterEventType } from '@/cluster/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import { logger } from '@/utils/logger';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/cluster';

export class ClusterAPIBackend {
  readonly prefix = API_PREFIX;

  private resolveClusterManager(): ClusterManager | null {
    try {
      return getContainer().resolve<ClusterManager>(DITokens.CLUSTER_MANAGER);
    } catch {
      return null;
    }
  }

  /**
   * Returns either the live ClusterManager (when started) or a 503
   * Response that the caller should pipe straight back to the client.
   * Use this in handlers that can't function without a running cluster.
   */
  private requireStarted(cluster: ClusterManager | null): ClusterManager | Response {
    if (!cluster) {
      return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
    }
    if (!cluster.isStarted()) {
      return errorResponse('Agent Cluster not running', 503);
    }
    return cluster;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);
    const cluster = this.resolveClusterManager();

    if (req.method === 'GET') {
      return this.handleGet(subPath, req, cluster);
    }

    if (req.method === 'POST') {
      return this.handlePost(subPath, req, cluster);
    }

    return errorResponse('Method not allowed', 405);
  }

  private handleGet(subPath: string, req: Request, cluster: ClusterManager | null): Response {
    const url = new URL(req.url);

    // ── Always-on routes (work even when cluster is stopped) ──
    switch (subPath) {
      case '':
      case '/':
      case '/status': {
        if (!cluster) {
          return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
        }
        return jsonResponse({
          started: cluster.isStarted(),
          status: cluster.getStatus(),
        });
      }

      case '/templates': {
        if (!cluster) {
          return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
        }
        const config = cluster.getConfig();
        const templates = Object.entries(config.workerTemplates).map(([name, t]) => ({
          name,
          type: t.type,
          command: t.command,
          maxConcurrent: t.maxConcurrent,
          capabilities: t.capabilities,
          costTier: t.costTier,
        }));
        const projectDefaults: Record<string, string> = {};
        for (const [alias, p] of Object.entries(config.projects)) {
          projectDefaults[alias] = p.workerPreference;
        }
        return jsonResponse({ templates, projectDefaults });
      }

      case '/projects': {
        try {
          const container = getContainer();
          const claude = container.resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
          const registry = claude.getProjectRegistry();
          if (!registry) {
            return errorResponse('ProjectRegistry not configured', 400);
          }
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
          return jsonResponse({ defaultAlias, projects });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }

      // Fall through to gated routes below.
    }

    // ── Gated routes (require a started cluster) ──
    const gated = this.requireStarted(cluster);
    if (gated instanceof Response) return gated;
    const live = gated;

    switch (subPath) {
      case '/workers':
        return jsonResponse(live.getHub().workerRegistry.getAll());

      case '/jobs': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const status = url.searchParams.get('status') || undefined;
        const jobs = live.getScheduler().getJobs({ status, limit, offset });
        return jsonResponse(jobs);
      }

      case '/tasks':
        return jsonResponse(live.getScheduler().getActiveTasks());

      case '/events': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const type = url.searchParams.get('type') || undefined;
        const events = live.getHub().eventLog.query({ type: type as ClusterEventType | undefined, limit, offset });
        return jsonResponse(events);
      }

      case '/locks':
        return jsonResponse(live.getHub().lockManager.getActiveLocks());

      case '/help':
        return jsonResponse(live.getHub().getPendingHelpRequests());

      case '/stream':
        return this.handleSSEStream(live);

      default: {
        // /jobs/:id
        const jobMatch = subPath.match(/^\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const job = live.getScheduler().getJob(jobMatch[1]);
          if (!job) return errorResponse('Job not found', 404);
          const tasks = live.getScheduler().getJobTasks(jobMatch[1]);
          return jsonResponse({ ...job, tasks });
        }

        // /tasks/:id/events
        const taskEventsMatch = subPath.match(/^\/tasks\/([^/]+)\/events$/);
        if (taskEventsMatch) {
          const events = live.getHub().eventLog.query({ taskId: taskEventsMatch[1] });
          return jsonResponse(events);
        }

        return errorResponse('Not found', 404);
      }
    }
  }

  private async handlePost(subPath: string, req: Request, cluster: ClusterManager | null): Promise<Response> {
    // ── Always-on control plane (work even when cluster is stopped) ──
    if (subPath === '/start') {
      if (!cluster) {
        return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
      }
      if (!cluster.isStarted()) {
        try {
          await cluster.start();
        } catch (err) {
          logger.error('[ClusterAPIBackend] /start failed:', err);
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }
      return jsonResponse({ started: true });
    }

    if (subPath === '/stop') {
      if (!cluster) {
        return errorResponse('Agent Cluster not configured (or requires SQLite)', 503);
      }
      if (cluster.isStarted()) {
        try {
          await cluster.stop();
        } catch (err) {
          logger.error('[ClusterAPIBackend] /stop failed:', err);
          return errorResponse(err instanceof Error ? err.message : String(err), 500);
        }
      }
      return jsonResponse({ started: false });
    }

    // ── Gated routes (require a started cluster) ──
    const gated = this.requireStarted(cluster);
    if (gated instanceof Response) return gated;
    const live = gated;

    switch (subPath) {
      case '/jobs': {
        let body: {
          project?: string;
          description?: string;
          workerTemplate?: string;
          /**
           * Phase 3: when true, scheduler enforces that the resolved
           * worker template has `role: 'planner'`. Set by the WebUI ticket
           * dispatch flow when the ticket frontmatter has `usePlanner: true`.
           */
          requirePlannerRole?: boolean;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
        if (!body.project || !body.description) {
          return errorResponse('Missing required fields: project, description', 400);
        }
        const task = await live.submitTask(body.project, body.description, {
          workerTemplate: body.workerTemplate,
          requirePlannerRole: body.requirePlannerRole === true ? true : undefined,
        });
        if (!task) {
          return errorResponse(
            'Failed to create task (unknown project, unknown workerTemplate, or requirePlannerRole could not resolve a planner template)',
            400,
          );
        }
        return jsonResponse(task, 201);
      }

      case '/pause': {
        live.pause();
        return jsonResponse({ paused: true });
      }

      case '/resume': {
        live.resume();
        return jsonResponse({ paused: false });
      }

      default: {
        // /workers/:id/kill
        const killMatch = subPath.match(/^\/workers\/([^/]+)\/kill$/);
        if (killMatch) {
          const killed = await live.killWorker(killMatch[1]);
          return jsonResponse({ killed });
        }

        // /help/:id/answer
        const answerMatch = subPath.match(/^\/help\/([^/]+)\/answer$/);
        if (answerMatch) {
          let body: { answer?: string; answeredBy?: string };
          try {
            body = (await req.json()) as { answer?: string; answeredBy?: string };
          } catch {
            return errorResponse('Invalid JSON body', 400);
          }
          if (!body.answer) {
            return errorResponse('Missing required field: answer', 400);
          }
          const answered = live.answerHelpRequest(answerMatch[1], body.answer, body.answeredBy || 'human');
          return jsonResponse({ answered });
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
