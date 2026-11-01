/**
 * The base layer every qqbot package sits on: logging, the log files on disk, the repo
 * root, time and id helpers, the error hierarchy and the HTTP client. Nothing here knows
 * about conversations, protocols or the bot's config — the logger reaches per-entry
 * context through `setLogContextSource`, which the bot installs.
 *
 * The health-check framework is `@qqbot/shared/health`, deliberately not re-exported
 * here: it is a tsyringe singleton, and tsyringe throws on import without a
 * reflect-metadata polyfill, which most of this barrel's importers have no reason to load.
 */

export * from './dateTime';
export * from './duration';
export * from './errors';
export * from './http/HttpClient';
export * from './logFiles';
export * from './logger';
export * from './randomUUID';
export * from './repoRoot';
