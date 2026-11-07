import type { ClusterHelpRequest } from '@qqbot/api-types';
import { logger } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config, ProtocolName } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { PermissionChecker } from '@/permission';
import type { ClusterClient } from './ClusterClient';

const TAG = '[ClusterEscalation]';

interface OwnerTarget {
  ownerId: string;
  protocol: ProtocolName;
}

/**
 * Routes the cluster's human-escalation requests (`hub_ask`) to the bot owner as QQ private
 * messages. The owner answers with `/cluster ask answer <id> <text>`.
 *
 * The daemon's SSE stream announces each new request (`help_request`), but the pending list is
 * the source of truth: every announcement and every (re)connection reconciles against
 * `GET /api/cluster/help`, so a request raised while the bot was disconnected is still
 * delivered. The daemon holds the delivery state (`notifiedAt`), so a bot restart does not
 * send a request again.
 */
@singleton()
export class ClusterEscalation {
  private abort: AbortController | null = null;
  // Guards overlapping syncPending runs; delivery across restarts is the daemon's `notifiedAt`.
  private readonly notified = new Set<string>();

  constructor(
    @inject(DITokens.CLUSTER_CLIENT) private readonly client: ClusterClient,
    @inject(MessageAPI) private readonly messageAPI: MessageAPI,
    @inject(DITokens.PERMISSION_CHECKER) private readonly permissionChecker: PermissionChecker,
    @inject(DITokens.CONFIG) private readonly config: Config,
  ) {}

  start(): void {
    if (this.abort) {
      return;
    }
    const target = this.ownerTarget();
    if (!target) {
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    void this.client.events(
      (event) => {
        if (event.event === 'help_request') {
          void this.syncPending(target);
        }
      },
      abort.signal,
      () => void this.syncPending(target),
    );
    logger.info(`${TAG} forwarding cluster help requests to owner ${target.ownerId} via ${target.protocol}`);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private ownerTarget(): OwnerTarget | null {
    const protocol = this.config.getEnabledProtocols()[0]?.name;
    const ownerId = this.permissionChecker.getOwnerId(protocol);
    if (!ownerId || !protocol) {
      logger.warn(`${TAG} not started — bot.owner=${ownerId || 'missing'} protocol=${protocol || 'missing'}`);
      return null;
    }
    return { ownerId, protocol };
  }

  private async syncPending(target: OwnerTarget): Promise<void> {
    let pending: ClusterHelpRequest[];
    try {
      pending = await this.client.getPendingHelpRequests();
    } catch (err) {
      logger.warn(`${TAG} could not list pending help requests:`, err);
      return;
    }
    const pendingIds = new Set(pending.map((r) => r.id));
    for (const id of this.notified) {
      if (!pendingIds.has(id)) {
        this.notified.delete(id);
      }
    }
    for (const request of pending) {
      if (request.notifiedAt || this.notified.has(request.id)) {
        continue;
      }
      this.notified.add(request.id);
      try {
        await this.messageAPI.sendPrivateMessage(target.ownerId, renderHelpRequest(request), target.protocol);
      } catch (err) {
        this.notified.delete(request.id);
        logger.error(`${TAG} failed to notify owner ${target.ownerId} via ${target.protocol}:`, err);
        continue;
      }
      try {
        await this.client.markHelpRequestNotified(request.id);
      } catch (err) {
        logger.warn(`${TAG} could not record that owner was told about ${request.id}:`, err);
      }
    }
  }
}

function renderHelpRequest(request: ClusterHelpRequest): string {
  const lines = [
    `[Cluster] Worker ${request.workerId} 请求帮助`,
    `类型: ${request.type}`,
    `askId: ${request.id}`,
    '',
    `问题: ${request.question}`,
  ];
  if (request.context) {
    lines.push('', `上下文: ${request.context}`);
  }
  if (request.options?.length) {
    lines.push('', '选项:');
    request.options.forEach((opt, i) => {
      lines.push(`  ${i + 1}. ${opt}`);
    });
  }
  lines.push('', `回复: /cluster ask answer ${request.id} <你的答复>`);
  return lines.join('\n');
}
