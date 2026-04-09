/**
 * PlannerService — manages planner workers and hub_ask routing.
 *
 * When a coder worker sends hub_ask, the PlannerService either:
 * 1. Routes to an active planner worker for automated response
 * 2. Queues for human response via WebUI/QQ notification
 *
 * Also handles spawning planner workers for Job decomposition.
 */

import { logger } from '@/utils/logger';
import type { ContextHub } from './ContextHub';
import type { ClusterConfig } from './config';
import type { HelpRequest } from './types';
import type { WorkerPool } from './WorkerPool';

export class PlannerService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
    private workerPool: WorkerPool,
  ) {}

  /**
   * Start monitoring for hub_ask requests that need planner attention.
   */
  start(): void {
    // Poll for pending help requests and route to planner or escalate
    this.pollTimer = setInterval(() => {
      this.processHelpRequests();
    }, 10_000); // every 10 seconds

    logger.info('[PlannerService] Started');
  }

  /**
   * Stop the planner service.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('[PlannerService] Stopped');
  }

  /**
   * Process pending help requests.
   * Routes to planner workers if available, otherwise queues for human.
   */
  private processHelpRequests(): void {
    const pending = this.hub.getPendingHelpRequests();
    if (pending.length === 0) return;

    // Find active planner workers
    const planners = this.hub.workerRegistry.getActive().filter((w) => w.role === 'planner');

    for (const request of pending) {
      if (request.type === 'escalation') {
        // Escalations always go to human — don't auto-answer
        this.notifyEscalation(request);
        continue;
      }

      if (planners.length > 0) {
        // Route to first available planner
        const planner = planners[0];
        this.hub.messageBox.send(
          planner.workerId,
          'hub',
          `Worker ${request.workerId} 请求帮助 (${request.type}): ${request.question}`,
          'message',
          'warning',
        );
        logger.debug(`[PlannerService] Routed help request ${request.id} to planner ${planner.workerId}`);
      } else {
        // No planner available — request stays pending for human via WebUI
        logger.debug(`[PlannerService] No planner available for help request ${request.id}`);
      }
    }
  }

  /**
   * Notify about an escalation request (would send QQ message in production).
   */
  private notifyEscalation(request: HelpRequest): void {
    logger.warn(`[PlannerService] Escalation from worker ${request.workerId}: ${request.question}`);
    // In a full implementation, this would send a QQ notification
    // via the InternalEventBus or directly through MessageAPI
  }
}
