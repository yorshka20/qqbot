// Admin command to inspect and force-refresh health check status for registered services (providers, RAG, etc.)

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { type HealthCheckManager, type HealthCheckResult, HealthStatus } from '@/core/health';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

const STATUS_ICON: Record<HealthStatus, string> = {
  [HealthStatus.HEALTHY]: '✅',
  [HealthStatus.UNHEALTHY]: '❌',
  [HealthStatus.UNKNOWN]: '❔',
};

function formatResultLine(name: string, result: HealthCheckResult | null, failures: number): string {
  if (!result) {
    return `${STATUS_ICON[HealthStatus.UNKNOWN]} ${name} — no data`;
  }
  const ms = typeof result.responseTime === 'number' ? ` (${result.responseTime}ms)` : '';
  const msg = result.message ? ` — ${result.message}` : '';
  const fails = failures > 0 ? ` [fails=${failures}]` : '';
  return `${STATUS_ICON[result.status]} ${name}${ms}${fails}${msg}`;
}

/**
 * Healthcheck command — list / force-refresh health status of registered services.
 *
 * Motivation: when a provider is marked UNHEALTHY after a transient failure, LLMService
 * skips it via isServiceHealthySync until its cache entry expires. Admins need a way to
 * kick the status back to HEALTHY on demand instead of waiting for the cache TTL.
 *
 * Subcommands:
 *   /healthcheck                 — list current cached status of all registered services
 *   /healthcheck <service>       — force re-probe one service and update its cached status
 *   /healthcheck all             — force re-probe every registered service in parallel
 *   /healthcheck reset <service> — wipe cached status (next probe starts from a clean slate)
 */
@Command({
  name: 'healthcheck',
  description: 'Inspect or force-refresh service health status (admin).',
  usage: '/healthcheck [<service> | all | reset <service>]',
  permissions: ['admin'],
  aliases: ['hc'],
})
@injectable()
export class HealthCheckCommandHandler implements CommandHandler {
  name = 'healthcheck';
  description = 'Inspect or force-refresh service health status (admin).';
  usage = '/healthcheck [<service> | all | reset <service>]';

  constructor(@inject(DITokens.HEALTH_CHECK_MANAGER) private readonly healthCheckManager: HealthCheckManager) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const [sub, ...rest] = args;

    if (!sub) {
      return this.renderList();
    }

    if (sub.toLowerCase() === 'all') {
      return this.refreshAll();
    }

    if (sub.toLowerCase() === 'reset') {
      const target = rest[0]?.trim();
      if (!target) {
        return {
          success: false,
          error: 'Usage: /healthcheck reset <service>',
        };
      }
      return this.resetOne(target);
    }

    return this.refreshOne(sub.trim());
  }

  private renderList(): CommandResult {
    const services = this.healthCheckManager.getRegisteredServices().slice().sort();
    const messageBuilder = new MessageBuilder();
    if (services.length === 0) {
      messageBuilder.text('No services registered with HealthCheckManager.');
      return { success: true, segments: messageBuilder.build() };
    }
    const lines: string[] = ['Health status (cached):'];
    for (const name of services) {
      const cached = this.healthCheckManager.peekCachedResult(name);
      const failures = this.healthCheckManager.getConsecutiveFailures(name);
      lines.push(formatResultLine(name, cached, failures));
    }
    lines.push('');
    lines.push('Use /healthcheck <service> to force a re-probe.');
    messageBuilder.text(lines.join('\n'));
    return { success: true, segments: messageBuilder.build() };
  }

  private async refreshOne(serviceName: string): Promise<CommandResult> {
    const registered = this.healthCheckManager.getRegisteredServices();
    const match = registered.find((n) => n === serviceName) ?? registered.find((n) => n.toLowerCase() === serviceName.toLowerCase());

    if (!match) {
      return {
        success: false,
        error: `Service "${serviceName}" not registered. Known: ${registered.join(', ') || '(none)'}`,
      };
    }

    logger.info(`[HealthCheckCommand] Force refresh requested for ${match}`);
    const result = await this.healthCheckManager.forceRefresh(match);
    const failures = this.healthCheckManager.getConsecutiveFailures(match);

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(['Force refresh result:', formatResultLine(match, result, failures)].join('\n'));
    return { success: true, segments: messageBuilder.build() };
  }

  private async refreshAll(): Promise<CommandResult> {
    const services = this.healthCheckManager.getRegisteredServices().slice().sort();
    if (services.length === 0) {
      const messageBuilder = new MessageBuilder();
      messageBuilder.text('No services registered with HealthCheckManager.');
      return { success: true, segments: messageBuilder.build() };
    }

    logger.info(`[HealthCheckCommand] Force refresh requested for all ${services.length} services`);
    const results = await Promise.all(
      services.map(async (name) => {
        const result = await this.healthCheckManager.forceRefresh(name);
        return { name, result, failures: this.healthCheckManager.getConsecutiveFailures(name) };
      }),
    );

    const lines: string[] = ['Force refresh (all):'];
    for (const { name, result, failures } of results) {
      lines.push(formatResultLine(name, result, failures));
    }
    const messageBuilder = new MessageBuilder();
    messageBuilder.text(lines.join('\n'));
    return { success: true, segments: messageBuilder.build() };
  }

  private resetOne(serviceName: string): CommandResult {
    const registered = this.healthCheckManager.getRegisteredServices();
    const match = registered.find((n) => n === serviceName) ?? registered.find((n) => n.toLowerCase() === serviceName.toLowerCase());

    if (!match) {
      return {
        success: false,
        error: `Service "${serviceName}" not registered. Known: ${registered.join(', ') || '(none)'}`,
      };
    }

    const ok = this.healthCheckManager.resetService(match);
    const messageBuilder = new MessageBuilder();
    messageBuilder.text(ok ? `Reset cached health for "${match}". Next probe starts clean.` : `Failed to reset "${match}".`);
    return { success: ok, segments: messageBuilder.build() };
  }
}
