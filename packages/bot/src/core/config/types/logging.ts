// Logging configuration

export interface MessageLogFilterConfig {
  /** When true, logs emitted inside a message's pipeline context are dropped unless the message's group/user is whitelisted. */
  enabled: boolean;
  /** Whitelisted group ids (string or number). */
  groupIds?: Array<string | number>;
  /** Whitelisted private-chat user ids. */
  userIds?: Array<string | number>;
  /** Log levels that always pass through, even for non-whitelisted messages. Defaults to ['warn', 'error']. */
  allowLevels?: Array<'debug' | 'info' | 'warn' | 'error'>;
}

export interface LoggingConfig {
  messageFilter?: MessageLogFilterConfig;
}
