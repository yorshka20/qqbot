/**
 * Whitelist capability names for per-group limited permissions.
 * When a group has limited capabilities (whitelistGroupCapabilities set), only these features are allowed.
 * When unset or empty, the group has full access (same as current whitelist behavior).
 */
export const WHITELIST_CAPABILITY = {
  /** LLM reply triggered by @bot, wake word, reaction, or provider-name prefix. */
  reply: 'reply',
  /** Command execution (e.g. /echo, builtin commands). */
  command: 'command',
  /** Proactive conversation: schedule and send proactive replies in this group. */
  proactive: 'proactive',
  /** Keyword reaction (e.g. send a reaction image on matched keyword). */
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
