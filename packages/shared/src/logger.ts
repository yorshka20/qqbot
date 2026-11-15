// Logging utility

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import winston from 'winston';
import { botLogsDir, localDateString, logFilePathAt } from './logFiles';
import { LogLineRenderer } from './logRender';

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
  /** Short tag written in front of the message; the console colours it from the text alone. */
  tag?: string;
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

/** Called with the path of each log file the process opens: its first one, then one per local day. */
export type LogFileListener = (path: string) => void;

/**
 * An entry as text: `[date time] [LEVEL] [tag] message`, then its stack or meta on the lines
 * after. The file stores exactly this; the console renders the same text (`LogLineRenderer`).
 */
function entryLine({ timestamp, level, message, stack, ...meta }: winston.Logform.TransformableInfo): string {
  let metaStr = '';
  if (stack) {
    metaStr = `\n${stack}`;
  } else if (Object.keys(meta).length) {
    metaStr = formatMeta(meta);
  }
  const tag = currentContext()?.tag;
  return `[${timestamp}] [${level.toUpperCase()}] ${tag ? `[${tag}] ` : ''}${message}${metaStr}`;
}

/** The suppress format runs first, so an entry the context source drops never reaches printf. */
function entryFormat(target: LogTarget, print: (info: winston.Logform.TransformableInfo) => string) {
  return winston.format.combine(
    buildSuppressFormat(target),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(print),
  );
}

const consoleRenderer = new LogLineRenderer();

function consoleTransport(): winston.transport {
  return new winston.transports.Console({
    format: entryFormat('console', (info) => consoleRenderer.render(entryLine(info))),
  });
}

/**
 * Writes `logs/<date>/<date>-<time>.log`. The file opens with the first entry the level lets
 * through, not on import: every CLI that imports `@qqbot/shared` gets this logger, and one that
 * never logs must leave no file behind. A new file opens at the first entry of each local day.
 */
class FileLogger implements Logger {
  private readonly winstonLogger: winston.Logger;
  private readonly logsDir = botLogsDir();
  private fileTransport: winston.transports.FileTransportInstance | null = null;
  private filePath: string | null = null;
  private fileDate = '';
  private readonly listeners = new Set<LogFileListener>();

  constructor(level: LogLevel, consoleOutput: boolean) {
    this.winstonLogger = winston.createLogger({
      level,
      transports: consoleOutput ? [consoleTransport()] : [],
    });
  }

  /** `listener` hears the file open now, if one is, and every one opened after. */
  onFile(listener: LogFileListener): void {
    this.listeners.add(listener);
    if (this.filePath) {
      listener(this.filePath);
    }
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.winstonLogger.isLevelEnabled(level)) {
      return;
    }
    const today = localDateString(new Date());
    if (today !== this.fileDate) {
      this.openFile(today);
    }
    this.winstonLogger.log(level, message, ...args);
  }

  private openFile(today: string): void {
    if (this.fileTransport) {
      this.winstonLogger.remove(this.fileTransport);
    }
    const path = logFilePathAt(this.logsDir, new Date());
    mkdirSync(dirname(path), { recursive: true });
    // A process started twice within one second gets the same name; start the file over.
    if (existsSync(path)) {
      unlinkSync(path);
    }
    this.fileTransport = new winston.transports.File({
      filename: path,
      format: entryFormat('file', entryLine),
      options: { flags: 'w' },
    });
    this.winstonLogger.add(this.fileTransport);
    this.fileDate = today;
    this.filePath = path;
    for (const listener of this.listeners) {
      listener(path);
    }
  }

  setLevel(level: LogLevel): void {
    this.winstonLogger.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }
}

class ConsoleOnlyLogger implements Logger {
  private winstonLogger: winston.Logger;

  constructor(level: LogLevel = 'info') {
    this.winstonLogger = winston.createLogger({ level, transports: [consoleTransport()] });
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

/** Hear which log file this process writes to; never called when file logging is off. */
export function onLogFile(listener: LogFileListener): void {
  if (defaultLogger instanceof FileLogger) {
    defaultLogger.onFile(listener);
  }
}

export const logger: Logger = defaultLogger;
