// LivemodeInterceptor — swallows private-chat messages from users who have
// enabled livemode, routing them into the per-user DanmakuBuffer instead of
// the normal reply flow.
//
// Placement: registered as a ProcessStageInterceptor, which runs BEFORE
// CommandSystem/ReplySystem in the PROCESS stage. The interceptor:
//   - skips messages routed to a command (`ctx.command` set) so `/livemode off`
//     can always close the mode out
//   - skips non-private messages (group chat is still handled normally even
//     if the user has livemode on)
//   - pushes the raw text into the user's buffer; the buffer's 3s flush
//     timer fires asynchronously and dispatches to the avatar pipeline via the
//     flush handler installed by bootstrap
//
// No reply is set on the context — SendSystem handles missing/empty replies
// as "nothing to send", so the user sees silence on QQ side while the
// avatar does its thing (matching the mock-livestream UX).

import type { ProcessStageInterceptor } from '@/conversation/ProcessStageInterceptor';
import type { HookContext } from '@/hooks/types';
import type { LivemodeState } from './LivemodeState';

export class LivemodeInterceptor implements ProcessStageInterceptor {
  constructor(private state: LivemodeState) {}

  shouldIntercept(ctx: HookContext): boolean {
    if (ctx.command) return false;
    const event = ctx.message;
    if (event.messageType !== 'private') return false;
    if (!event.userId) return false;
    if (!this.state.isEnabled(event.userId)) return false;
    // Skip empty / whitespace-only content — nothing for the avatar to react to.
    const text = (event.message ?? '').trim();
    return text.length > 0;
  }

  async handle(ctx: HookContext): Promise<void> {
    const event = ctx.message;
    const text = (event.message ?? '').trim();
    const nickname = event.sender?.nickname ?? event.sender?.card;
    this.state.pushMessage(event.userId, text, nickname);
  }
}
