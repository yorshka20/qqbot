// Logging utility

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import { getCurrentMessageContext } from '@/context/MessageContextStorage';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
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
  return parts.length > 0 ? '\n' + parts.join('\n') : '';
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

/** Convert foreground ANSI code (e.g. \\x1b[36m) to background code (e.g. \\x1b[46m). Used for prefix highlight. */
function foregroundToBackground(fgEscape: string): string | null {
  // Match CSI + number + m (avoid control char in regex by matching after known prefix)
  if (!fgEscape.startsWith('\x1b[')) {
    return null;
  }
  const match = fgEscape.slice(2).match(/^(\d+)m/);
  if (!match) {
    return null;
  }
  const n = parseInt(match[1], 10);
  // 30-37 foreground -> 40-47 background; 90-97 bright fg -> 100-107 bright bg (not all terms support)
  if (n >= 30 && n <= 37) {
    return `\x1b[${n + 10}m`;
  }
  if (n >= 90 && n <= 97) {
    return `\x1b[${n + 10}m`;
  }
  return null;
}

const levelColors: Record<string, string> = {
  error: colors.red + colors.bright,
  warn: colors.yellow + colors.bright,
  info: colors.cyan + colors.bright,
  debug: colors.gray,
};

/** Prefix for console. When whole-line color is used (see console format), use plain tag; else use background highlight. */
function getMessageContextPrefixConsole(wholeLineColor: boolean): string {
  const ctx = getCurrentMessageContext();
  if (ctx?.logTag && ctx?.logColor) {
    if (wholeLineColor) {
      return `[${ctx.logTag}] `;
    }
    const bg = foregroundToBackground(ctx.logColor);
    if (bg) {
      return `${bg}\x1b[30m[${ctx.logTag}]${colors.reset} `;
    }
    return `${ctx.logColor}[${ctx.logTag}]${colors.reset} `;
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
    this.logsDir = join(process.cwd(), 'logs');
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }

    this.currentDate = getLocalDateString(new Date());

    // File format
    const fileFormat = winston.format.combine(
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

    // Console format with better colors
    const consoleFormat = winston.format.combine(
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
        const wholeLineColor = Boolean(ctx?.logColor);

        let metaStr = '';
        if (stack) {
          metaStr = `\n${dim}${stack}${reset}`;
        } else if (Object.keys(meta).length) {
          metaStr = formatMeta(meta)
            .split('\n')
            .map((line) => `${gray}${line}${reset}`)
            .join('\n');
        }

        const levelStr = `${color}${levelUpper.padEnd(5)}${reset}`;
        const timeStr = `${dim}${timestamp}${reset}`;
        const msgPrefix = getMessageContextPrefixConsole(wholeLineColor);
        let line = `${timeStr} ${levelStr} ${msgPrefix}${message}${metaStr}`;
        if (wholeLineColor && ctx?.logColor) {
          line = `${ctx.logColor}${line}${reset}`;
        }
        return line;
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

      // Create new file transport
      const fileFormat = winston.format.combine(
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

// Get default log level from environment variable or use 'info' as fallback
const defaultLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
let defaultLogger: Logger = new FileLogger(defaultLogLevel);

export function setLogLevel(level: LogLevel): void {
  defaultLogger = new FileLogger(level);
}

export function getLogger(): Logger {
  return defaultLogger;
}

export const logger = defaultLogger;
