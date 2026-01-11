// Logging utility

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

class FileLogger implements Logger {
  private winstonLogger: winston.Logger;

  constructor(level: LogLevel = 'info') {
    // Ensure logs directory exists
    const logsDir = join(process.cwd(), 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Configure daily rotate file transport
    const fileTransport = new DailyRotateFile({
      filename: join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.printf(
          ({ timestamp, level, message, stack, ...meta }) => {
            let metaStr = '';
            if (stack) {
              metaStr = `\n${stack}`;
            } else if (Object.keys(meta).length) {
              metaStr = ` ${JSON.stringify(meta)}`;
            }
            return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
          },
        ),
      ),
    });

    // Configure console transport
    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.printf(
          ({ timestamp, level, message, stack, ...meta }) => {
            let metaStr = '';
            if (stack) {
              metaStr = `\n${stack}`;
            } else if (Object.keys(meta).length) {
              metaStr = ` ${JSON.stringify(meta)}`;
            }
            return `[${timestamp}] [${level}] ${message}${metaStr}`;
          },
        ),
      ),
    });

    // Create winston logger
    this.winstonLogger = winston.createLogger({
      level,
      transports: [fileTransport, consoleTransport],
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

let defaultLogger: Logger = new FileLogger();

export function setLogLevel(level: LogLevel): void {
  defaultLogger = new FileLogger(level);
}

export function getLogger(): Logger {
  return defaultLogger;
}

export const logger = defaultLogger;
