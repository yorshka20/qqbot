// Logging utility

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import winston from 'winston';
import { botLogsDir, localDateString, logFilePathAt } from './logFiles';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The two transports differ in what they may drop; see `LogContextSource.suppress`. */
export type LogTarget = 'console' | 'file';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LogSection {
  label: string;
  content: string;
}

/**
 * Body of a log entry made of labelled parts, appended to the entry's header line so the whole
 * block is one log call. Each part opens with a `── [label] ──` line; the WebUI log viewer
 * (packages/webui/src/pages/docs/log/parseLog.ts) matches that exact marker to fold the parts
 * one by one, so the two must change together.
 */
export function formatLogSections(sections: LogSection[]): string {
  return sections.map((s) => `── [${s.label}] ──\n${s.content}`).join('\n');
}

/** What the logger may know about the entry it is writing. */
export interface LogEntryContext {
  /** Short tag written in front of the message. */
  tag?: string;
  /** ANSI background code for the tag on the console; carries no foreground colour. */
  color?: string;
  /**
   * True the first time it is asked for one context: that console line takes the
   * background across its whole width, every later line only on the tag. Calling it
   * consumes the turn, so only call it when a line will actually use it.
   */
  takeWholeLineBackground(): boolean;
}

/**
 * Where the logger gets the per-entry context and the decision to drop an entry.
 * The application installs one at startup; with none installed every entry is written,
 * untagged. This is the seam that keeps the logger free of any knowledge of messages,
 * conversations or whatever else the application tags its logs by.
 */
export interface LogContextSource {
  /** Context of the entry being written, or null outside any. */
  current(): LogEntryContext | null;
  /**
   * True when this entry must not reach that transport. The two differ: the console is
   * display only, while the file is also parsed for statistics, so a source may let
   * entries through to the file that it drops from the console.
   */
  suppress(target: LogTarget, level: LogLevel, message: string): boolean;
}

let contextSource: LogContextSource | null = null;

export function setLogContextSource(source: LogContextSource | null): void {
  contextSource = source;
}

function currentContext(): LogEntryContext | null {
  return contextSource?.current() ?? null;
}

/** Build a winston format that drops the entries the context source rejects. */
function buildSuppressFormat(target: LogTarget) {
  return winston.format((info) => {
    if (!contextSource) {
      return info;
    }
    const lvl = info.level as LogLevel;
    const msg = typeof info.message === 'string' ? info.message : String(info.message);
    return contextSource.suppress(target, lvl, msg) ? false : info;
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

/** Console prefix: the tag on its background only (no text colour). */
function contextPrefixConsole(): string {
  const ctx = currentContext();
  if (ctx?.tag && ctx.color) {
    return `${ctx.color}\x1b[37m[${ctx.tag}]${colors.reset} `;
  }
  return '';
}

/** File prefix: the plain tag. */
function contextPrefixFile(): string {
  const ctx = currentContext();
  return ctx?.tag ? `[${ctx.tag}] ` : '';
}

class FileLogger implements Logger {
  private winstonLogger: winston.Logger;
  private logsDir: string;
  private currentDate: string;
  private fileTransport: winston.transports.FileTransportInstance;

  constructor(level: LogLevel, consoleOutput: boolean) {
    // Ensure logs directory exists
    this.logsDir = botLogsDir();
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }

    this.currentDate = localDateString(new Date());

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
        const msgPrefix = contextPrefixFile();
        return `[${timestamp}] [${level.toUpperCase()}] ${msgPrefix}${message}${metaStr}`;
      }),
    );

    // Create file transport with new file on startup
    const logFilePath = logFilePathAt(this.logsDir, new Date());
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
        const ctx = currentContext();

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

        // First line of a context: whole-line background, then prefix-only for the rest.
        if (ctx?.color && ctx.takeWholeLineBackground()) {
          const plainPrefix = ctx.tag ? `[${ctx.tag}] ` : '';
          const plainLine = `${timestamp} ${levelUpper.padEnd(5)} ${plainPrefix}${message}${metaStrPlain}`;
          // Background + white text for the whole line (readable on a dark terminal)
          const bgAndFg = ctx.color.endsWith('m') ? `${ctx.color.slice(0, -1)};37m` : `${ctx.color}\x1b[37m`;
          return `${bgAndFg}${plainLine}${reset}`;
        }

        // Subsequent logs: only prefix has background; rest of line normal (no extra text color)
        const levelStr = `${color}${levelUpper.padEnd(5)}${reset}`;
        const timeStr = `${dim}${timestamp}${reset}`;
        const msgPrefix = contextPrefixConsole();
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
      transports: consoleOutput ? [this.fileTransport, consoleTransport] : [this.fileTransport],
    });

    // Check date periodically for long-running processes
    setInterval(() => {
      this.checkDateChange();
    }, 60000); // Check every minute
  }

  private checkDateChange(): void {
    const today = localDateString(new Date());
    if (today !== this.currentDate) {
      // Date changed, create new file transport
      this.currentDate = today;
      const newLogFilePath = logFilePathAt(this.logsDir, new Date());

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
          const msgPrefix = contextPrefixFile();
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

  setLevel(level: LogLevel): void {
    this.winstonLogger.level = level;
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

  setLevel(level: LogLevel): void {
    this.winstonLogger.level = level;
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
// Under a service manager stdout is an unrotated capture file; the log files already hold every
// entry, so a copy there would only grow without bound.
const consoleOutput = process.env.NO_CONSOLE_LOG !== '1';
const createLogger = (level: LogLevel): FileLogger | ConsoleOnlyLogger =>
  disableFileLog ? new ConsoleOnlyLogger(level) : new FileLogger(level, consoleOutput);
// One instance for the whole process: a FileLogger owns its log file and a date-check timer, so
// building a second one would open a second file and leak the first one's timer.
const defaultLogger = createLogger(defaultLogLevel);

export function setLogLevel(level: LogLevel): void {
  defaultLogger.setLevel(level);
}

export const logger: Logger = defaultLogger;
