/**
 * ClusterAPIRouter — REST API endpoints for WebUI and external consumers.
 *
 * Mounted on the ContextHub HTTP server under /api/cluster/*.
 * Provides cluster status, job/task queries, worker management, help request handling.
 */

import { logger } from '@/utils/logger';
import type { ClusterScheduler } from './ClusterScheduler';
import type { ContextHub, SSESubscriber } from './ContextHub';
import type { WorkerPool } from './WorkerPool';

export class ClusterAPIRouter {
  constructor(
    private hub: ContextHub,
    private workerPool: WorkerPool,
    private scheduler: ClusterScheduler,
  ) {}

  /**
   * Handle API requests under /api/cluster/*.
   * Returns null if the path doesn't match.
   */
  async handle(req: Request, url: URL, headers: Record<string, string>): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith('/api/cluster')) return null;

    const subPath = path.slice('/api/cluster'.length) || '/';

    try {
      if (req.method === 'GET') {
        return this.handleGet(subPath, url, headers);
      }
      if (req.method === 'POST') {
        return this.handlePost(subPath, req, headers);
      }
      return null;
    } catch (err) {
      logger.error('[ClusterAPIRouter] Error:', err);
      return Response.json(
        { error: err instanceof Error ? err.message : 'Internal error' },
        { status: 500, headers },
      );
    }
  }

  private handleGet(subPath: string, url: URL, headers: Record<string, string>): Response | null {
    switch (subPath) {
      case '/status':
      case '/': {
        const status = this.workerPool.getStatus();
        return Response.json(status, { headers });
      }

      case '/workers': {
        const workers = this.hub.workerRegistry.getAll();
        return Response.json(workers, { headers });
      }

      case '/jobs': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const status = url.searchParams.get('status') || undefined;
        const jobs = this.scheduler.getJobs({ status, limit, offset });
        return Response.json(jobs, { headers });
      }

      case '/tasks': {
        const tasks = this.scheduler.getActiveTasks();
        return Response.json(tasks, { headers });
      }

      case '/events': {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const type = url.searchParams.get('type') || undefined;
        const events = this.hub.eventLog.query({
          type: type as any,
          limit,
          offset,
        });
        return Response.json(events, { headers });
      }

      case '/locks': {
        const locks = this.hub.lockManager.getActiveLocks();
        return Response.json(locks, { headers });
      }

      case '/help': {
        const requests = this.hub.getPendingHelpRequests();
        return Response.json(requests, { headers });
      }

      case '/stream': {
        return this.handleSSEStream();
      }

      default: {
        // /jobs/:id
        const jobMatch = subPath.match(/^\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const job = this.scheduler.getJob(jobMatch[1]);
          if (!job) return Response.json({ error: 'Job not found' }, { status: 404, headers });
          const tasks = this.scheduler.getJobTasks(jobMatch[1]);
          return Response.json({ ...job, tasks }, { headers });
        }

        // /tasks/:id/events
        const taskEventsMatch = subPath.match(/^\/tasks\/([^/]+)\/events$/);
        if (taskEventsMatch) {
          const events = this.hub.eventLog.query({ taskId: taskEventsMatch[1] });
          return Response.json(events, { headers });
        }

        return null;
      }
    }
  }

  private async handlePost(
    subPath: string,
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response | null> {
    switch (subPath) {
      case '/jobs': {
        const body = (await req.json()) as { project: string; description: string };
        if (!body.project || !body.description) {
          return Response.json({ error: 'Missing required fields: project, description' }, { status: 400, headers });
        }
        const task = await this.scheduler.submitTask(body.project, body.description);
        if (!task) {
          return Response.json({ error: 'Failed to create task (unknown project?)' }, { status: 400, headers });
        }
        return Response.json(task, { status: 201, headers });
      }

      case '/pause': {
        this.workerPool.pause();
        return Response.json({ paused: true }, { headers });
      }

      case '/resume': {
        this.workerPool.resume();
        return Response.json({ paused: false }, { headers });
      }

      default: {
        // /workers/:id/kill
        const killMatch = subPath.match(/^\/workers\/([^/]+)\/kill$/);
        if (killMatch) {
          const killed = await this.workerPool.killWorker(killMatch[1]);
          return Response.json({ killed }, { headers });
        }

        // /help/:id/answer
        const answerMatch = subPath.match(/^\/help\/([^/]+)\/answer$/);
        if (answerMatch) {
          const body = (await req.json()) as { answer: string; answeredBy?: string };
          if (!body.answer) {
            return Response.json({ error: 'Missing required field: answer' }, { status: 400, headers });
          }
          const answered = this.hub.answerHelpRequest(answerMatch[1], body.answer, body.answeredBy || 'human');
          return Response.json({ answered }, { headers });
        }

        return null;
      }
    }
  }

  private handleSSEStream(): Response {
    const hub = this.hub;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const subscriber: SSESubscriber = {
          send(event: string, data: unknown) {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          },
          close() {
            try {
              controller.close();
            } catch {
              // Already closed
            }
          },
        };

        hub.addSSESubscriber(subscriber);

        // Send initial status
        const status = hub.workerRegistry.getAll();
        subscriber.send('init', { workers: status });
      },
      cancel() {
        // Cleanup happens when subscriber fails to send
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
