/**
 * PlannerService — manages planner workers and hub_ask routing.
 *
 * When a coder worker sends hub_ask, the PlannerService either:
 * 1. Routes to an active planner worker for automated response
 * 2. Notifies a human (via the escalation callback) for human response
 *
 * Also handles spawning planner workers for Job decomposition.
 */

import { logger } from '@/utils/logger';
import type { ClusterConfig } from './config';
import type { ContextHub } from './hub/ContextHub';
import type { HelpRequest } from './types';
import type { WorkerPool } from './WorkerPool';

/**
 * Callback fired by PlannerService when a help request needs human
 * attention. Receives the full HelpRequest. Implementations should send
 * a notification (e.g. QQ message to bot owner) and return when delivery
 * is at least best-effort initiated. Errors should be caught internally;
 * any thrown error will be logged but won't stop other requests from
 * being processed.
 *
 * Wired by `ClusterManager.attachOwnerNotifier()` from bootstrap once
 * MessageAPI is available.
 */
export type EscalationCallback = (request: HelpRequest) => Promise<void> | void;

export class PlannerService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private escalationCallback: EscalationCallback | null = null;
  /**
   * Tracks help request IDs we've already attempted to notify a human
   * about. Without this we'd re-fire the escalation callback on every
   * 10s poll for the entire lifetime of an unanswered request — i.e. the
   * owner would get spammed every 10s.
   *
   * We never remove entries from this set: once a request has been
   * notified, it stays notified. The set is bounded by the (small) total
   * number of help requests over a single cluster session, so memory
   * isn't a concern. On cluster restart the set resets, which means
   * pending unanswered requests get one fresh notification — that's the
   * intended behavior so the owner sees them again after a restart.
   */
  private notifiedAskIds = new Set<string>();

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
    private workerPool: WorkerPool,
  ) {}

  /**
   * Set the escalation callback. Called by ClusterManager from bootstrap
   * once MessageAPI is available. Optional — without a callback, escalation
   * requests still get logged but no notification is sent.
   */
  setEscalationCallback(cb: EscalationCallback): void {
    this.escalationCallback = cb;
  }

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
   * Routes to planner workers if available, otherwise notifies human.
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
        // No planner available — fall back to human escalation. Same path
        // as type === 'escalation'. We treat "no planner alive" as
        // implicit human escalation rather than letting requests rot.
        this.notifyEscalation(request);
      }
    }
  }

  /**
   * Notify a human about a help request. Dedupes by askId so each
   * request fires the callback exactly once across the cluster session.
   */
  private notifyEscalation(request: HelpRequest): void {
    if (this.notifiedAskIds.has(request.id)) {
      return;
    }
    this.notifiedAskIds.add(request.id);

    logger.warn(
      `[PlannerService] Escalation from worker ${request.workerId} (askId=${request.id}, type=${request.type}): ${request.question}`,
    );

    if (!this.escalationCallback) {
      // Bootstrap may not have wired the callback yet (or this cluster
      // is running headless). The request is still in cluster_help_requests
      // and visible via WebUI / QQ /cluster ask list, so it's not lost —
      // just no push notification.
      return;
    }

    // Fire-and-forget. Surface errors but never block other request
    // processing on a single notification failure.
    Promise.resolve(this.escalationCallback(request)).catch((err) => {
      logger.error(`[PlannerService] escalationCallback threw for askId=${request.id}:`, err);
    });
  }
}
