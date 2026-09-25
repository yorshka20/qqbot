import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { PluginManager } from '@/plugins/PluginManager';
import type { WhitelistPlugin } from '@/plugins/plugins/WhitelistPlugin';

/**
 * Whitelist capability names for per-group limited permissions.
 * When a group has limited capabilities (whitelistGroupCapabilities set), only these features are allowed.
 * When unset or empty, the group has full access (same as current whitelist behavior).
 */
export const WHITELIST_CAPABILITY = {
  /** LLM reply triggered by @bot, wake word, reaction, provider-name prefix, or color nickname. */
  reply: 'reply',
  /** Command execution (e.g. /echo, builtin commands). */
  command: 'command',
  /** Proactive conversation: schedule and send proactive replies in this group. */
  proactive: 'proactive',
  /** Reaction ("贴表情") on a group message, sent through ReactionPlugin.react(). */
  reaction: 'reaction',
  /** SubAgent spawn on keyword match. */
  subagent: 'subagent',
  /** Echo (TTS) for admin messages. */
  echo: 'echo',
} as const;

export type WhitelistCapability = (typeof WHITELIST_CAPABILITY)[keyof typeof WHITELIST_CAPABILITY];

/** All capability keys in a stable order (for validation or display). */
export const WHITELIST_CAPABILITY_KEYS: WhitelistCapability[] = [
  WHITELIST_CAPABILITY.reply,
  WHITELIST_CAPABILITY.command,
  WHITELIST_CAPABILITY.proactive,
  WHITELIST_CAPABILITY.reaction,
  WHITELIST_CAPABILITY.subagent,
  WHITELIST_CAPABILITY.echo,
];

/**
 * Capability check for callers that hold a groupId but no HookContext — a notice handler, a
 * scheduled analysis, a tool executor. Mirrors `hasWhitelistCapability`, which reads the same
 * decision off metadata the WhitelistPlugin hook already wrote.
 *
 * The config fallback covers the window before the plugin is registered: an empty `groupIds`
 * means the whitelist is not in use, so nothing is gated.
 */
export function groupHasWhitelistCapability(groupId: string, capability: WhitelistCapability): boolean {
  const id = String(groupId);
  const whitelistPlugin = getContainer().resolve(PluginManager)?.getPluginAs<WhitelistPlugin>('whitelist');

  if (!whitelistPlugin) {
    const config = getContainer().resolve<Config>(DITokens.CONFIG);
    const groupIds = (config.getPluginConfig('whitelist') as { groupIds?: string[] } | undefined)?.groupIds;
    return !Array.isArray(groupIds) || groupIds.length === 0 || groupIds.includes(id);
  }

  const caps = whitelistPlugin.getGroupCapabilities(id);
  if (caps === undefined) {
    return false;
  }
  // Empty means the group is whitelisted without restriction.
  return caps.length === 0 || caps.includes(capability);
}
