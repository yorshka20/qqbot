// Lightweight standalone logger for @qqbot/avatar.
// Avoids a reverse dependency on @qqbot/bot's winston-based logger.
// Keep the method surface aligned with what AvatarService uses.
export const logger = {
  info: (message: string, ...args: unknown[]) => console.log('[avatar]', message, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn('[avatar]', message, ...args),
  error: (message: string, ...args: unknown[]) => console.error('[avatar]', message, ...args),
  debug: (message: string, ...args: unknown[]) => console.debug('[avatar]', message, ...args),
};
