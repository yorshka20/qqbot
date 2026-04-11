import type { Bot } from '@/core/Bot';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { ClusterManager } from './ClusterManager';

/**
 * Wire the cluster's human-escalation mechanism to QQ private messages.
 *
 * When a worker fires a hub_ask request, this routes it to the bot owner via
 * a QQ private message. The owner can reply with `/cluster ask answer <id> <text>`.
 *
 * Placed here (instead of inside ClusterManager's constructor) so the cluster
 * module stays free of any QQ/MessageAPI imports — keeping the option of running
 * cluster headless or behind WebUI only.
 */
export async function wireClusterEscalation(
  clusterManager: ClusterManager,
  config: ReturnType<Bot['getConfig']>,
): Promise<void> {
  try {
    const { MessageAPI } = await import('@/api/methods/MessageAPI');
    const container = getContainer();
    const messageAPI = container.resolve<InstanceType<typeof MessageAPI>>(DITokens.MESSAGE_API);
    const ownerId = config.getConfig().bot?.owner;
    const enabledProtocols = config.getEnabledProtocols();
    const preferredProtocol = enabledProtocols[0]?.name;

    if (!ownerId || !preferredProtocol) {
      logger.warn(
        `[ClusterEscalation] Not wired — bot.owner=${ownerId || 'missing'} preferredProtocol=${preferredProtocol || 'missing'}`,
      );
      return;
    }

    clusterManager.attachEscalationNotifier(async (request) => {
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
      try {
        await messageAPI.sendPrivateMessage(ownerId, lines.join('\n'), preferredProtocol);
      } catch (err) {
        logger.error(
          `[ClusterEscalation] Failed to send escalation notification to owner ${ownerId} via ${preferredProtocol}:`,
          err,
        );
      }
    });
  } catch (err) {
    logger.warn('[ClusterEscalation] Failed to wire escalation notifier (non-fatal):', err);
  }
}
