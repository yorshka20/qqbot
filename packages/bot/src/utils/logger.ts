// Logging utility

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import winston from 'winston';
import { getCurrentMessageContext } from '@/context/MessageContextStorage';
import { getRepoRoot } from '@/utils/repoRoot';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Per-message log filter. When set, every log call checks the current async
 * message context: if a message context exists and the message's group/user
 * is not whitelisted, the call is dropped (unless the level is in allowLevels).
 * Logs without a message context (bootstrap, plugins, system errors) always pass.
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
function shouldSuppress(target: 'console' | 'file', level: LogLevel, message: string): boolean {
  if (!messageLogFilter) return false;
  if (messageLogFilter.allowLevels.has(level)) return false;
  if (target === 'file' && message.includes('[STATS]')) return false;
  const ctx = getCurrentMessageContext();
  if (!ctx) return false;
  const msg = ctx.message;
  const gid = msg.groupId != null ? String(msg.groupId) : '';
  const uid = msg.userId != null ? String(msg.userId) : '';
  if (gid && messageLogFilter.groupIds.has(gid)) return false;
  if (!gid && uid && messageLogFilter.userIds.has(uid)) return false;
  return true;
}

/** Build a winston format that drops entries via shouldSuppress() for the given transport. */
function buildSuppressFormat(target: 'console' | 'file') {
  return winston.format((info) => {
    const lvl = info.level as LogLevel;
    const msg = typeof info.message === 'string' ? info.message : String(info.message);
    return shouldSuppress(target, lvl, msg) ? false : info;
  })();
}

// Helper function to format JSON data
function formatJSON(data: unknown): string {
  try {
    if (typeof data === 'object' && data !== null) {
      return JSON.stringify(data, null, 2);
    }
    return String(data);
  } catch {
    return String(data);
  }
}

// Helper function to format meta data
function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null) {
      if (typeof value === 'object') {
        parts.push(`${key}:\n${formatJSON(value)}`);
      } else {
        parts.push(`${key}=${String(value)}`);
      }
    }
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

// Get local date string in YYYY-MM-DD format
function getLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Get log file path with date and time
function getLogFilePath(logsDir: string): string {
  const now = new Date();
  const dateStr = getLocalDateString(now); // YYYY-MM-DD (local time)
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
  return join(logsDir, `${dateStr}/${dateStr}-${timeStr}.log`);
}

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const levelColors: Record<string, string> = {
  error: colors.red + colors.bright,
  warn: colors.yellow + colors.bright,
  info: colors.cyan + colors.bright,
  debug: colors.gray,
};

/** Prefix for console: [logTag] with background only (no text color). ctx.logColor is already an ANSI background code. */
function getMessageContextPrefixConsole(): string {
  const ctx = getCurrentMessageContext();
  if (ctx?.logTag && ctx?.logColor) {
    // Background + white text for tag, then reset
    return `${ctx.logColor}\x1b[37m[${ctx.logTag}]${colors.reset} `;
  }
  return '';
}

/** Prefix for file: plain [logTag] when current async chain has message context with logTag. */
function getMessageContextPrefixFile(): string {
  const ctx = getCurrentMessageContext();
  if (ctx?.logTag) {
    return `[${ctx.logTag}] `;
  }
  return '';
}

class FileLogger implements Logger {
  private winstonLogger: winston.Logger;
  private logsDir: string;
  private currentDate: string;
  private fileTransport: winston.transports.FileTransportInstance;

  constructor(level: LogLevel = 'info') {
    // Ensure logs directory exists
    this.logsDir = join(getRepoRoot(), 'logs');
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }

    this.currentDate = getLocalDateString(new Date());

    // File format — suppress format runs first so non-whitelisted entries are dropped
    // before printf (with [STATS] bypass for daily-stats parsing).
    const fileFormat = winston.format.combine(
      buildSuppressFormat('file'),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let metaStr = '';
        if (stack) {
          metaStr = `\n${stack}`;
        } else if (Object.keys(meta).length) {
          metaStr = formatMeta(meta);
        }
        const msgPrefix = getMessageContextPrefixFile();
        return `[${timestamp}] [${level.toUpperCase()}] ${msgPrefix}${message}${metaStr}`;
      }),
    );

    // Create file transport with new file on startup
    const logFilePath = getLogFilePath(this.logsDir);
    // Ensure date directory exists
    const dateDir = join(this.logsDir, this.currentDate);
    if (!existsSync(dateDir)) {
      mkdirSync(dateDir, { recursive: true });
    }
    // Delete file if exists to create new file instead of appending
    if (existsSync(logFilePath)) {
      unlinkSync(logFilePath);
    }
    this.fileTransport = new winston.transports.File({
      filename: logFilePath,
      format: fileFormat,
      options: { flags: 'w' }, // Create new file, don't append
    });

    // Console format — suppress format runs first; no [STATS] bypass for console
    // (display-only — daily stats reads from the file transport, not the console).
    const consoleFormat = winston.format.combine(
      buildSuppressFormat('console'),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const levelUpper = level.toUpperCase();
        const color = levelColors[level] || colors.white;
        const reset = colors.reset;
        const dim = colors.dim;
        const gray = colors.gray;
        const ctx = getCurrentMessageContext();

        let metaStr = '';
        let metaStrPlain = '';
        if (stack) {
          metaStr = `\n${dim}${stack}${reset}`;
          metaStrPlain = `\n${stack}`;
        } else if (Object.keys(meta).length) {
          const formatted = formatMeta(meta);
          metaStr = formatted
            .split('\n')
            .map((line) => `${gray}${line}${reset}`)
            .join('\n');
          metaStrPlain = formatted;
        }

        // First log for this message: whole-line BACKGROUND (no text color). Then turn off so rest are prefix-only.
        if (ctx?.logColor && ctx?.logWholeLineBackground) {
          ctx.logWholeLineBackground = false;
          const plainPrefix = ctx.logTag ? `[${ctx.logTag}] ` : '';
          const plainLine = `${timestamp} ${levelUpper.padEnd(5)} ${plainPrefix}${message}${metaStrPlain}`;
          // Background + white text for whole line (readable on dark terminal)
          const bgAndFg = ctx.logColor.endsWith('m') ? `${ctx.logColor.slice(0, -1)};37m` : `${ctx.logColor}\x1b[37m`;
          return `${bgAndFg}${plainLine}${reset}`;
        }

        // Subsequent logs: only prefix has background; rest of line normal (no extra text color)
        const levelStr = `${color}${levelUpper.padEnd(5)}${reset}`;
        const timeStr = `${dim}${timestamp}${reset}`;
        const msgPrefix = getMessageContextPrefixConsole();
        return `${timeStr} ${levelStr} ${msgPrefix}${message}${metaStr}`;
      }),
    );

    // Configure console transport
    const consoleTransport = new winston.transports.Console({
      format: consoleFormat,
    });

    // Create winston logger
    this.winstonLogger = winston.createLogger({
      level,
      transports: [this.fileTransport, consoleTransport],
    });

    // Check date periodically for long-running processes
    setInterval(() => {
      this.checkDateChange();
    }, 60000); // Check every minute
  }

  private checkDateChange(): void {
    const today = getLocalDateString(new Date());
    if (today !== this.currentDate) {
      // Date changed, create new file transport
      this.currentDate = today;
      const newLogFilePath = getLogFilePath(this.logsDir);

      // Ensure new date directory exists
      const dateDir = join(this.logsDir, this.currentDate);
      if (!existsSync(dateDir)) {
        mkdirSync(dateDir, { recursive: true });
      }

      // Remove old file transport
      this.winstonLogger.remove(this.fileTransport);

      // Create new file transport (same suppress-then-format chain as on init)
      const fileFormat = winston.format.combine(
        buildSuppressFormat('file'),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          let metaStr = '';
          if (stack) {
            metaStr = `\n${stack}`;
          } else if (Object.keys(meta).length) {
            metaStr = formatMeta(meta);
          }
          const msgPrefix = getMessageContextPrefixFile();
          return `[${timestamp}] [${level.toUpperCase()}] ${msgPrefix}${message}${metaStr}`;
        }),
      );

      // Delete file if exists to create new file instead of appending
      if (existsSync(newLogFilePath)) {
        unlinkSync(newLogFilePath);
      }
      this.fileTransport = new winston.transports.File({
        filename: newLogFilePath,
        format: fileFormat,
        options: { flags: 'w' }, // Create new file, don't append
      });

      // Add new file transport
      this.winstonLogger.add(this.fileTransport);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.winstonLogger.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.winstonLogger.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.winstonLogger.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.winstonLogger.error(message, ...args);
  }
}

class ConsoleOnlyLogger implements Logger {
  private winstonLogger: winston.Logger;

  constructor(level: LogLevel = 'info') {
    const consoleFormat = winston.format.combine(
      buildSuppressFormat('console'),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const levelUpper = level.toUpperCase();
        const color = levelColors[level] || colors.white;
        const reset = colors.reset;
        const dim = colors.dim;

        let metaStr = '';
        if (stack) {
          metaStr = `\n${dim}${stack}${reset}`;
        } else if (Object.keys(meta).length) {
          const formatted = formatMeta(meta);
          metaStr = formatted
            .split('\n')
            .map((line) => `${colors.gray}${line}${reset}`)
            .join('\n');
        }

        const levelStr = `${color}${levelUpper.padEnd(5)}${reset}`;
        const timeStr = `${dim}${timestamp}${reset}`;
        return `${timeStr} ${levelStr} ${message}${metaStr}`;
      }),
    );

    this.winstonLogger = winston.createLogger({
      level,
      transports: [new winston.transports.Console({ format: consoleFormat })],
    });
  }

  debug(message: string, ...args: unknown[]): void {
    this.winstonLogger.debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    this.winstonLogger.info(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.winstonLogger.warn(message, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    this.winstonLogger.error(message, ...args);
  }
}

// Get default log level from environment variable or use 'info' as fallback
const defaultLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const disableFileLog = process.env.NO_FILE_LOG === '1';
let defaultLogger: Logger = disableFileLog ? new ConsoleOnlyLogger(defaultLogLevel) : new FileLogger(defaultLogLevel);

export function setLogLevel(level: LogLevel): void {
  defaultLogger = new FileLogger(level);
}

export function getLogger(): Logger {
  return defaultLogger;
}

export const logger = defaultLogger;
