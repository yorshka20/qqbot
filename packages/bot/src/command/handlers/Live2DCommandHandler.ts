// Live2DCommandHandler — `/live2d <subcommand>` controls the avatar's
// external data sources, currently limited to the Bilibili live-room
// danmaku bridge.
//
// Subcommands:
//   /live2d connect     — start the bridge (open WS, begin buffering)
//   /live2d disconnect  — stop the bridge
//   /live2d reconnect   — stop then start (useful after auth cookies rotate
//                         or to clear an error state)
//   /live2d status      — print the current state (connected? reconnecting?
//                         last error? room id? pipeToLive2D?)
//
// The command lazy-resolves the bridge so it stays functional (with a
// helpful error) even when `bilibili.live.enabled=false` at boot time —
// the handler just reports "not configured" instead of crashing the DI
// container.
//
// Permission: `owner` only. Live-room auth tokens live in the bridge,
// and connect/disconnect affects a shared avatar resource — this isn't
// an end-user toy.

import { inject, injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { BilibiliLiveBridge } from '@/services/bilibili/live/BilibiliLiveBridge';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

type Subcommand = 'connect' | 'disconnect' | 'reconnect' | 'status';

const SUBCOMMANDS: Subcommand[] = ['connect', 'disconnect', 'reconnect', 'status'];

@Command({
  name: 'live2d',
  description: "Control the Live2D avatar's external data sources (currently: Bilibili live-room bridge).",
  usage: '/live2d <connect|disconnect|reconnect|status>',
  permissions: ['owner'],
  aliases: [],
})
@injectable()
export class Live2DCommandHandler implements CommandHandler {
  name = 'live2d';
  description = "Control the Live2D avatar's external data sources (currently: Bilibili live-room bridge).";
  usage = '/live2d <connect|disconnect|reconnect|status>';

  // The bridge is constructed + registered in bootstrap only when
  // `bilibili.live.enabled=true`. We resolve lazily per call so users get
  // a helpful "not configured" message at command time instead of a
  // DI-resolution crash at command registration.
  constructor(@inject(DITokens.CONFIG) private _config: unknown) {
    void this._config;
  }

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    void _context;
    const sub = (args[0] ?? '').toLowerCase() as Subcommand | '';
    if (!sub) {
      return this.text(`Usage: ${this.usage}\nSubcommands: ${SUBCOMMANDS.join(', ')}`);
    }
    if (!SUBCOMMANDS.includes(sub as Subcommand)) {
      return this.text(`未知子命令: ${sub}。可用: ${SUBCOMMANDS.join(', ')}`);
    }

    const bridge = this.resolveBridge();
    if (!bridge) {
      return this.text(
        'Bilibili live bridge 未配置。请在 config 里设置 bilibili.live.enabled=true 并填写 roomId 后重启。',
      );
    }

    switch (sub as Subcommand) {
      case 'status':
        return this.text(this.formatStatus(bridge));
      case 'connect':
        return this.handleConnect(bridge);
      case 'disconnect':
        return this.handleDisconnect(bridge);
      case 'reconnect':
        return this.handleReconnect(bridge);
    }
  }

  private resolveBridge(): BilibiliLiveBridge | null {
    const container = getContainer();
    if (!container.isRegistered(DITokens.BILIBILI_LIVE_BRIDGE)) return null;
    return container.resolve<BilibiliLiveBridge>(DITokens.BILIBILI_LIVE_BRIDGE);
  }

  private async handleConnect(bridge: BilibiliLiveBridge): Promise<CommandResult> {
    if (bridge.isStarted()) {
      return this.text(`Bridge 已启动。当前状态:\n${this.formatStatus(bridge)}`);
    }
    try {
      await bridge.start();
      return this.text(`已触发连接。\n${this.formatStatus(bridge)}`);
    } catch (err) {
      logger.warn('[Live2DCommandHandler] connect failed:', err);
      return this.text(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDisconnect(bridge: BilibiliLiveBridge): Promise<CommandResult> {
    if (!bridge.isStarted()) {
      return this.text('Bridge 未启动，无需断开。');
    }
    try {
      await bridge.stop();
      return this.text('已断开。');
    } catch (err) {
      logger.warn('[Live2DCommandHandler] disconnect failed:', err);
      return this.text(`断开失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleReconnect(bridge: BilibiliLiveBridge): Promise<CommandResult> {
    try {
      await bridge.reconnect();
      return this.text(`已触发重连。\n${this.formatStatus(bridge)}`);
    } catch (err) {
      logger.warn('[Live2DCommandHandler] reconnect failed:', err);
      return this.text(`重连失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private formatStatus(bridge: BilibiliLiveBridge): string {
    const s = bridge.getStatus();
    const state = s.exhausted
      ? `exhausted (${s.reconnectAttempts} attempts — use /live2d reconnect to retry)`
      : !s.started
        ? 'stopped'
        : s.connected
          ? 'connected'
          : s.reconnecting
            ? `reconnecting (attempt ${s.reconnectAttempts})`
            : 'idle';
    const aliases = s.streamerAliases.length > 0 ? s.streamerAliases.join(', ') : '(none)';
    const lines = [
      `[Bilibili live bridge]`,
      `  room: ${s.roomId}`,
      `  state: ${state}`,
      `  pipeToLive2D: ${s.pipeToLive2D}`,
      `  streamerAliases: ${aliases}`,
    ];
    if (s.lastError) lines.push(`  lastError: ${s.lastError}`);
    return lines.join('\n');
  }

  private text(msg: string): CommandResult {
    const builder = new MessageBuilder();
    builder.text(msg);
    return { success: true, segments: builder.build(), sentAsForward: false };
  }
}
