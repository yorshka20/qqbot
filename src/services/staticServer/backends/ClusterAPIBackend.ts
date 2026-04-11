/**
 * ClusterAPIBackend — StaticServer backend for Agent Cluster REST API.
 *
 * Provides the same /api/cluster/* routes as ContextHub's ClusterAPIRouter,
 * but runs on StaticServer (port 8888) so WebUI can query cluster state
 * regardless of whether ContextHub is online.
 *
 * Only available when the cluster is started. Start/stop/pause/resume are
 * handled separately by ClusterControlBackend (/api/cluster-control/*).
 *
 * Routes:
 * - GET  /api/cluster/status
 * - GET  /api/cluster/templates
 * - GET  /api/cluster/projects
 * - GET  /api/cluster/workers
 * - GET  /api/cluster/jobs
 * - GET  /api/cluster/jobs/:id
 * - GET  /api/cluster/tasks
 * - GET  /api/cluster/events
 * - GET  /api/cluster/locks
 * - GET  /api/cluster/help
 * - GET  /api/cluster/stream  (SSE)
 * - POST /api/cluster/jobs
 * - POST /api/cluster/pause
 * - POST /api/cluster/resume
 * - POST /api/cluster/workers/:id/kill
 * - POST /api/cluster/help/:id/answer
 */

import type { ClusterManager } from '@/cluster/ClusterManager';
import type { ClusterEventType } from '@/cluster/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
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

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const subPath = pathname.slice(API_PREFIX.length);
    const cluster = this.resolveClusterManager();

    if (!cluster || !cluster.isStarted()) {
      return errorResponse('Agent Cluster not running', 503);
    }

    if (req.method === 'GET') {
      return this.handleGet(subPath, req, cluster);
    }

    if (req.method === 'POST') {
      return this.handlePost(subPath, req, cluster);
    }

    return errorResponse('Method not allowed', 405);
  }

  private handleGet(subPath: string, req: Request, cluster: ClusterManager): Response {
    const url = new URL(req.url);

    switch (subPath) {
      case '/status':
      case '/':
        return jsonResponse(cluster.getStatus());

      case '/templates': {
        // Templates are static config — read directly from ClusterManager's hub config.
        // We access this via the hub's config, which mirrors the original config.
        const hub = cluster.getHub();
        const config = (hub as unknown as { config: { workerTemplates: Record<string, unknown> } }).config;
        const templates = Object.entries(config?.workerTemplates ?? {}).map(([name, t]) => ({
          name,
          ...(t as Record<string, unknown>),
        }));
        return jsonResponse({ templates, projectDefaults: {} });
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

      case '/workers':
        return jsonResponse(cluster.getHub().workerRegistry.getAll());

      case '/jobs': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const status = url.searchParams.get('status') || undefined;
        const jobs = cluster.getScheduler().getJobs({ status, limit, offset });
        return jsonResponse(jobs);
      }

      case '/tasks':
        return jsonResponse(cluster.getScheduler().getActiveTasks());

      case '/events': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const type = url.searchParams.get('type') || undefined;
        const events = cluster.getHub().eventLog.query({ type: type as ClusterEventType | undefined, limit, offset });
        return jsonResponse(events);
      }

      case '/locks':
        return jsonResponse(cluster.getHub().lockManager.getActiveLocks());

      case '/help':
        return jsonResponse(cluster.getHub().getPendingHelpRequests());

      case '/stream':
        return this.handleSSEStream(cluster);

      default: {
        // /jobs/:id
        const jobMatch = subPath.match(/^\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const job = cluster.getScheduler().getJob(jobMatch[1]);
          if (!job) return errorResponse('Job not found', 404);
          const tasks = cluster.getScheduler().getJobTasks(jobMatch[1]);
          return jsonResponse({ ...job, tasks });
        }

        // /tasks/:id/events
        const taskEventsMatch = subPath.match(/^\/tasks\/([^/]+)\/events$/);
        if (taskEventsMatch) {
          const events = cluster.getHub().eventLog.query({ taskId: taskEventsMatch[1] });
          return jsonResponse(events);
        }

        return errorResponse('Not found', 404);
      }
    }
  }

  private async handlePost(subPath: string, req: Request, cluster: ClusterManager): Promise<Response> {
    switch (subPath) {
      case '/jobs': {
        let body: { project?: string; description?: string; workerTemplate?: string };
        try {
          body = (await req.json()) as { project?: string; description?: string; workerTemplate?: string };
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
        if (!body.project || !body.description) {
          return errorResponse('Missing required fields: project, description', 400);
        }
        const task = await cluster.submitTask(body.project, body.description, {
          workerTemplate: body.workerTemplate,
        });
        if (!task) {
          return errorResponse('Failed to create task (unknown project or workerTemplate?)', 400);
        }
        return jsonResponse(task, 201);
      }

      case '/pause': {
        cluster.pause();
        return jsonResponse({ paused: true });
      }

      case '/resume': {
        cluster.resume();
        return jsonResponse({ paused: false });
      }

      default: {
        // /workers/:id/kill
        const killMatch = subPath.match(/^\/workers\/([^/]+)\/kill$/);
        if (killMatch) {
          const killed = await cluster.killWorker(killMatch[1]);
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
          const answered = cluster.answerHelpRequest(answerMatch[1], body.answer, body.answeredBy || 'human');
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
