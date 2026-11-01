// Supplies the logger with the message being handled: the tag and colour its lines carry,
// and which lines to drop. The logger itself knows nothing about messages.

import type { LogContextSource, LogEntryContext, LogLevel, LogTarget } from '@qqbot/shared';
import { setLogContextSource } from '@qqbot/shared';
import { getCurrentMessageContext, type MessageContextValue } from './MessageContextStorage';

/**
 * Per-message log filter. When set, every log call checks the current async
 * message context: if a message context exists and the message's group/user
 * is not whitelisted, the call is dropped (unless the level is in allowLevels).
 * Logs without a message context (bootstrap, plugins, system errors) always pass.
 *
 * Asymmetric semantics by design:
 *   - groupIds: strict allowlist (groups are noisy, opt-in only)
 *   - userIds:  empty → all private chats pass; non-empty → allowlist
 *               (private is owner-controlled and low-volume; the filter exists
 *                to silence groups, not interactions the owner initiated)
 */
export interface MessageLogFilter {
  groupIds: Set<string>;
  userIds: Set<string>;
  /** Levels that always pass through. */
  allowLevels: Set<LogLevel>;
}

let messageLogFilter: MessageLogFilter | null = null;

export function setMessageLogFilter(filter: MessageLogFilter | null): void {
  messageLogFilter = filter;
}

/**
 * Returns true if this log entry should be suppressed for the given transport.
 *
 * Two transports have different needs:
 *   - 'console': pure display; non-whitelisted is dropped without exception
 *   - 'file':    also feeds DailyStatsBackend log parsing; [STATS] lines must
 *                bypass the filter so per-group counters keep working
 *
 * Logs without a message context (bootstrap, plugin startup, system errors
 * outside any pipeline) always pass — they are not "message logs".
 */
function shouldSuppress(target: LogTarget, level: LogLevel, message: string): boolean {
  if (!messageLogFilter) return false;
  if (messageLogFilter.allowLevels.has(level)) return false;
  if (target === 'file' && message.includes('[STATS]')) return false;
  const ctx = getCurrentMessageContext();
  if (!ctx) return false;
  const msg = ctx.message;
  const gid = msg.groupId != null ? String(msg.groupId) : '';
  const uid = msg.userId != null ? String(msg.userId) : '';
  // Group: strict allowlist — group filter exists to silence noisy unrelated groups.
  if (gid) {
    return !messageLogFilter.groupIds.has(gid);
  }
  // Private: low-volume owner channel; empty userIds means "all private chats pass".
  // Non-empty userIds becomes an allowlist for the niche case of focusing on one DM.
  if (messageLogFilter.userIds.size === 0) return false;
  return !(uid && messageLogFilter.userIds.has(uid));
}

function toEntryContext(value: MessageContextValue): LogEntryContext {
  return {
    tag: value.logTag,
    color: value.logColor,
    takeWholeLineBackground: () => {
      if (!value.logWholeLineBackground) {
        return false;
      }
      value.logWholeLineBackground = false;
      return true;
    },
  };
}

/** Called once during bootstrap; until it runs, log lines carry no message tag. */
export function installLogContextSource(): void {
  const source: LogContextSource = {
    current: () => {
      const ctx = getCurrentMessageContext();
      return ctx ? toEntryContext(ctx) : null;
    },
    suppress: shouldSuppress,
  };
  setLogContextSource(source);
}
