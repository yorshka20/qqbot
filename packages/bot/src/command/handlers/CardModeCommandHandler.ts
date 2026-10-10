// CardModeCommandHandler — `/cardmode auto|light|dark|status` picks the light or
// dark palette used by every rendered card. The choice is bot-wide, not
// per-session: several render paths (agent delivery, help, /cat) have no session.

import { inject, injectable } from 'tsyringe';
import type { CardAppearanceMode } from '@/core/config';
import { MessageBuilder } from '@/message/MessageBuilder';
import { CardAppearanceService } from '@/services/card';
import { Command } from '../decorators';
import type { CommandHandler, CommandResult } from '../types';

const MODES: CardAppearanceMode[] = ['auto', 'dark', 'light'];

@Command({
  name: 'cardmode',
  description: 'Set the light/dark appearance of rendered cards (auto follows the configured night window).',
  usage: '/cardmode <auto|light|dark|status>',
  permissions: ['admin'],
})
@injectable()
export class CardModeCommandHandler implements CommandHandler {
  name = 'cardmode';
  description = 'Set the light/dark appearance of rendered cards (auto follows the configured night window).';
  usage = '/cardmode <auto|light|dark|status>';

  constructor(@inject(CardAppearanceService) private appearance: CardAppearanceService) {}

  execute(args: string[]): CommandResult {
    const arg = (args[0] ?? '').toLowerCase();
    if (!arg || arg === 'status') {
      return this.text(this.status());
    }
    if (!MODES.includes(arg as CardAppearanceMode)) {
      return this.text(`未知选项: ${arg}。可用: ${MODES.join(', ')}, status`);
    }

    this.appearance.setMode(arg as CardAppearanceMode);
    return this.text(`已切换卡片外观。\n${this.status()}`);
  }

  private status(): string {
    const mode = this.appearance.getMode();
    const effective = this.appearance.resolve() === 'dark' ? '深色' : '浅色';
    const window = `暗色时段: ${this.appearance.describeDarkWindow()}`;
    const persistence = '运行时设置，重启后回到配置默认值。';
    return mode === 'auto'
      ? `卡片外观: auto（当前 ${effective}）| ${window}\n${persistence}`
      : `卡片外观: ${mode}（固定 ${effective}）| ${window}\n${persistence}`;
  }

  private text(message: string): CommandResult {
    return {
      success: true,
      segments: new MessageBuilder().text(message).build(),
      sentAsForward: false,
    };
  }
}
