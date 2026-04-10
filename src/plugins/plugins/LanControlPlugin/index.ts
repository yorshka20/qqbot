// LAN Control Plugin
//
// Provides the `/lan` command for managing LAN-relay clients connected to
// this host. Phase 2 dispatch model: the user issues commands here, the
// host routes them to specific clients via LanRelayHost.dispatchToClient.
//
// Subcommands:
//   /lan list                 — show all connected clients
//   /lan @<clientId> <text>   — dispatch text to a specific client
//   /lan log <clientId> [n]   — show last N internal reports from a client
//   /lan kick <clientId>      — disconnect a client
//   /lan status               — show host LAN-relay status
//
// Permission: owner only (A6 decision). Clients are "your workers", not
// shared infrastructure — no admin/group escalation.
//
// Plugin is host-only by intent. On client instances it can be skipped via
// `lanRelay.client.disabledPlugins: ["lanControl"]`, but it also no-ops if
// the runtime singleton is not in host mode.

import { randomUUID } from 'node:crypto';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { getLanRelayRuntime } from '@/lan';
import type { LanRelayHost } from '@/lan/host/LanRelayHost';
import type { LanRelayDispatchPayload, LanRelayOriginContext } from '@/lan/types/wire';
import { MessageBuilder } from '@/message/MessageBuilder';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';

const USAGE = `/lan list                  — list connected clients
/lan @<clientId> <text>    — dispatch text to a client
/lan log <clientId> [n]    — show last N reports from client (default 20, max 200)
/lan kick <clientId>       — disconnect a client
/lan status                — show LAN relay status`;

@RegisterPlugin({
  name: 'lanControl',
  version: '1.0.0',
  description: 'Manage LAN-relay clients via /lan command',
})
export class LanControlPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private config!: Config;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.config = container.resolve<Config>(DITokens.CONFIG);
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    const handler = new PluginCommandHandler(
      'lan',
      'Manage LAN-relay clients',
      USAGE,
      async (args: string[], context: CommandContext) => this.execute(args, context),
      this.context,
      ['owner'],
    );
    this.commandManager.register(handler, this.name);
    logger.info('[LanControlPlugin] /lan command registered');
  }

  /**
   * Top-level dispatcher for /lan subcommands.
   * Owner-only at the command-system level, but we double-check here so an
   * accidental capability widening doesn't expose the host registry.
   */
  private async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    // Defensive owner check (PluginCommandHandler also enforces, but cheap to repeat).
    if (!MessageUtils.isOwner(context.userId, this.config.getConfig().bot)) {
      return reply('权限不足：/lan 仅 owner 可用');
    }

    // No-op if runtime is not host (LanControlPlugin should not be loaded on
    // client, but guard in case the user mis-configures).
    const runtime = getLanRelayRuntime();
    if (!runtime || !runtime.isHostMode()) {
      return reply('LAN relay 未启用，或当前不是 host 模式');
    }
    const host = runtime as LanRelayHost;

    if (args.length === 0) {
      return reply(`用法：\n${USAGE}`);
    }

    const first = args[0];

    // /lan @<clientId> <text>  — dispatch
    if (first.startsWith('@')) {
      const clientId = first.slice(1);
      const text = args.slice(1).join(' ').trim();
      if (!clientId) {
        return reply('clientId 不能为空');
      }
      if (!text) {
        return reply(`用法：/lan @${clientId} <text>`);
      }
      return this.dispatchCommand(host, clientId, text, context);
    }

    // Subcommands
    switch (first) {
      case 'list':
        return this.listCommand(host);
      case 'log':
        return this.logCommand(host, args.slice(1));
      case 'kick':
        return this.kickCommand(host, args.slice(1));
      case 'status':
        return this.statusCommand(host);
      default:
        return reply(`未知子命令：${first}\n\n${USAGE}`);
    }
  }

  // ── Subcommand implementations ───────────────────────────────────────

  private async dispatchCommand(
    host: LanRelayHost,
    clientId: string,
    text: string,
    context: CommandContext,
  ): Promise<CommandResult> {
    const client = host.getClient(clientId);
    if (!client) {
      return reply(`client "${clientId}" 未连接`);
    }

    const origin: LanRelayOriginContext = {
      protocol: context.metadata.protocol,
      userId: context.userId,
      groupId: context.groupId,
      sourceMessageId: context.originalMessage?.messageId,
      dispatchedAt: Date.now(),
    };

    const payload: LanRelayDispatchPayload = {
      text,
      origin,
      dispatchId: randomUUID(),
    };

    const ok = host.dispatchToClient(clientId, payload);
    if (!ok) {
      return reply(`dispatch 失败：client "${clientId}" 连接已断开`);
    }
    return reply(`✓ dispatched to ${clientId}`);
  }

  private listCommand(host: LanRelayHost): CommandResult {
    const clients = host.listClients();
    if (clients.length === 0) {
      return reply('📋 LAN clients: (none connected)');
    }
    const lines = [`📋 LAN clients (${clients.length} connected)`, ''];
    for (const c of clients) {
      const uptime = formatDuration(Date.now() - c.startedAt);
      const lastSeen = formatDuration(Date.now() - c.lastSeenAt);
      lines.push(`▸ ${c.clientId}${c.label ? ` (${c.label})` : ''}`);
      lines.push(`   ip:        ${c.lanAddress}`);
      lines.push(`   uptime:    ${uptime}`);
      lines.push(`   last seen: ${lastSeen} ago`);
      if (c.enabledPlugins && c.enabledPlugins.length > 0) {
        const preview = c.enabledPlugins.slice(0, 5).join(', ');
        const more = c.enabledPlugins.length > 5 ? ` (+${c.enabledPlugins.length - 5} more)` : '';
        lines.push(`   plugins:   ${preview}${more}`);
      }
      lines.push('');
    }
    return reply(lines.join('\n').trimEnd());
  }

  private logCommand(host: LanRelayHost, args: string[]): CommandResult {
    const clientId = args[0];
    if (!clientId) {
      return reply('用法：/lan log <clientId> [n]');
    }
    if (!host.hasReportStore()) {
      return reply('host 没有启用 sqlite，internal report 未持久化');
    }
    const n = args[1] ? parseInt(args[1], 10) : undefined;
    const rows = host.getReports(clientId, { limit: Number.isFinite(n) ? n : undefined });
    if (rows.length === 0) {
      return reply(`📭 ${clientId} 没有任何 internal report`);
    }
    const lines = [`📜 ${clientId} — last ${rows.length} report(s) (newest first)`, ''];
    for (const r of rows) {
      const ts = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19);
      lines.push(`[${ts}] [${r.level}] ${r.text}`);
    }
    return reply(lines.join('\n'));
  }

  private kickCommand(host: LanRelayHost, args: string[]): CommandResult {
    const clientId = args[0];
    if (!clientId) {
      return reply('用法：/lan kick <clientId>');
    }
    const ok = host.kickClient(clientId);
    if (!ok) {
      return reply(`client "${clientId}" 未连接`);
    }
    return reply(`✓ kicked ${clientId}`);
  }

  private statusCommand(host: LanRelayHost): CommandResult {
    const clients = host.listClients();
    const lr = this.config.getLanRelayConfig();
    const port = lr?.listenPort ?? '?';
    const lines = [
      '🛰  LAN relay status',
      `   role:    host`,
      `   listen:  ${lr?.listenHost ?? '0.0.0.0'}:${port}`,
      `   clients: ${clients.length} connected`,
    ];
    return reply(lines.join('\n'));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function reply(text: string): CommandResult {
  return {
    success: true,
    segments: new MessageBuilder().text(text).build(),
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}
