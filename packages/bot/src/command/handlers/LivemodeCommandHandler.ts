// LivemodeCommandHandler — `/livemode on|off|status` toggles the per-user
// "mock livestream" mode that reroutes private-chat messages into the
// main MessagePipeline as aggregated danmaku batches (see LivemodeState).
//
// Subcommands:
//   /livemode on [--proactive=off]  — enable for the caller. Default
//                                     proactive=on (Phase 2c idle trigger
//                                     is allowed to fire); pass
//                                     --proactive=off to disable it.
//   /livemode off                   — disable for the caller (flushes any
//                                     pending buffered messages first).
//   /livemode status                — report current state for the caller.
//
// Permissions: `user`. It's a user-scoped toy that only affects the caller's
// own private chat, so no owner/admin gate.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { LivemodeState } from '@/integrations/avatar/LivemodeState';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

type Subcommand = 'on' | 'off' | 'status';
const SUBCOMMANDS: Subcommand[] = ['on', 'off', 'status'];

@Command({
  name: 'livemode',
  description:
    'Toggle mock-livestream mode for your private chat. While on, your messages feed the Live2D avatar as aggregated "danmaku" batches instead of producing regular 1:1 replies.',
  usage: '/livemode <on|off|status> [--proactive=on|off]',
  permissions: ['user'],
  aliases: [],
})
@injectable()
export class LivemodeCommandHandler implements CommandHandler {
  name = 'livemode';
  description =
    'Toggle mock-livestream mode for your private chat. While on, your messages feed the Live2D avatar as aggregated "danmaku" batches instead of producing regular 1:1 replies.';
  usage = '/livemode <on|off|status> [--proactive=on|off]';

  constructor(@inject(DITokens.LIVEMODE_STATE) private state: LivemodeState) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const userId = context.userId;
    const sub = (args[0] ?? '').toLowerCase() as Subcommand | '';
    if (!sub) {
      return this.text(`Usage: ${this.usage}\nSubcommands: ${SUBCOMMANDS.join(', ')}`);
    }
    if (!SUBCOMMANDS.includes(sub as Subcommand)) {
      return this.text(`未知子命令: ${sub}。可用: ${SUBCOMMANDS.join(', ')}`);
    }

    switch (sub as Subcommand) {
      case 'on': {
        const proactive = this.parseProactiveFlag(args.slice(1));
        this.state.enable(userId, { proactive });
        return this.text(
          `已进入直播间模式。你的私聊消息将被当作弹幕（3 秒聚合批次）送给 avatar。主动说话: ${
            proactive ? '开启' : '关闭'
          }。发送 /livemode off 退出。`,
        );
      }
      case 'off': {
        const wasEnabled = this.state.isEnabled(userId);
        this.state.disable(userId);
        return this.text(wasEnabled ? '已退出直播间模式。' : '当前未处于直播间模式。');
      }
      case 'status': {
        const enabled = this.state.isEnabled(userId);
        if (!enabled) return this.text('未开启直播间模式。');
        const proactive = this.state.isProactive(userId);
        return this.text(`直播间模式已开启 | 主动说话: ${proactive ? '开启' : '关闭'}`);
      }
    }
  }

  /**
   * Parse `--proactive=on|off` out of trailing args. Default true when the
   * flag is omitted. Any unrecognized value is treated as truthy so typos
   * fail open (user can always re-run with `off`).
   */
  private parseProactiveFlag(rest: string[]): boolean {
    for (const arg of rest) {
      const match = arg.match(/^--proactive=(.+)$/i);
      if (!match) continue;
      const v = match[1].toLowerCase();
      if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
    }
    return true;
  }

  private text(message: string): CommandResult {
    return {
      success: true,
      segments: new MessageBuilder().text(message).build(),
      sentAsForward: false,
    };
  }
}
