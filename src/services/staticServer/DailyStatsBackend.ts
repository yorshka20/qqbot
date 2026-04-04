/**
 * Daily stats backend: REST API (/api/stats) for log-based daily statistics.
 *
 * Parses log files from logs/YYYY-MM-DD/ directory to extract:
 * - Error counts and details
 * - Messages received/sent counts
 * - LLM provider call counts and token usage
 * - Hourly activity distribution
 * - Pipeline/hook execution stats
 *
 * API contract:
 * - GET /api/stats?date=YYYY-MM-DD         -> { stats: DailyStats }
 * - GET /api/stats/dates                    -> { dates: string[] }
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils/logger';

const API_PREFIX = '/api/stats';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface ErrorEntry {
  timestamp: string;
  component: string;
  message: string;
}

export interface ProviderStats {
  provider: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptChars: number;
  responseChars: number;
}

export interface HourlyActivity {
  hour: number;
  messagesReceived: number;
  messagesSent: number;
  llmCalls: number;
}

export interface GroupActivity {
  groupName: string;
  groupId: string;
  messageCount: number;
}

export interface DailyStats {
  date: string;
  summary: {
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalLLMCalls: number;
    totalErrors: number;
    totalWarnings: number;
    totalTokensUsed: number;
    totalPromptChars: number;
    totalResponseChars: number;
  };
  providerStats: ProviderStats[];
  hourlyActivity: HourlyActivity[];
  topGroups: GroupActivity[];
  recentErrors: ErrorEntry[];
  logFileCount: number;
}

interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(\w+)\] (.*)$/;
// All [STATS]-tagged patterns — source logs are marked with [STATS] to prevent accidental removal.
const MESSAGE_RECEIVED_RE = /\[STATS\] ===========>\[Message\] Group: (.+?) \((\d+)\)/;
const MESSAGE_SENT_RE = /\[STATS\] ✅ \[HookManager\] All handlers completed for hook: onMessageSent/;
const PROVIDER_GENERATING_RE =
  /\[STATS\] \[(\w+Provider)\] Generating (?:with model|stream with model|with vision, model|stream with vision, model|with model \(chat\/completions\)): (.+)/;
const LLM_USAGE_RE =
  /\[STATS\] \[LLMService\] usage \| provider=(\S+) \| promptTokens=(\d+) \| completionTokens=(\d+) \| totalTokens=(\d+) \| promptChars=(\d+) \| responseChars=(\d+)/;
const ERROR_COMPONENT_RE = /\[([^\]]+)\] (.+)/;

/** Map provider class names to short names. */
function normalizeProviderName(className: string): string {
  return className.replace(/Provider$/, '').toLowerCase();
}

function parseLogFiles(logsDir: string, date: string): DailyStats {
  const dateDir = join(logsDir, date);

  const stats: DailyStats = {
    date,
    summary: {
      totalMessagesReceived: 0,
      totalMessagesSent: 0,
      totalLLMCalls: 0,
      totalErrors: 0,
      totalWarnings: 0,
      totalTokensUsed: 0,
      totalPromptChars: 0,
      totalResponseChars: 0,
    },
    providerStats: [],
    hourlyActivity: Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      messagesReceived: 0,
      messagesSent: 0,
      llmCalls: 0,
    })),
    topGroups: [],
    recentErrors: [],
    logFileCount: 0,
  };

  if (!existsSync(dateDir)) {
    return stats;
  }

  const files = readdirSync(dateDir)
    .filter((f) => f.endsWith('.log'))
    .sort();
  stats.logFileCount = files.length;

  const providerMap = new Map<string, ProviderStats>();
  const groupMap = new Map<string, GroupActivity>();

  for (const file of files) {
    const filePath = join(dateDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const match = LOG_LINE_RE.exec(line);
      if (!match) continue;

      const [, timestamp, level, rest] = match;
      const hour = Number.parseInt(timestamp.split(' ')[1].split(':')[0], 10);

      // Count errors and warnings
      if (level === 'ERROR') {
        stats.summary.totalErrors++;
        // Extract component and message
        const errMatch = ERROR_COMPONENT_RE.exec(rest.replace(/^\[msg:\w+\] /, ''));
        if (errMatch && stats.recentErrors.length < 50) {
          stats.recentErrors.push({
            timestamp,
            component: errMatch[1],
            message: errMatch[2].slice(0, 200),
          });
        }
      }
      if (level === 'WARN') {
        stats.summary.totalWarnings++;
      }

      // Strip message context prefix (e.g., [msg:abc123])
      const body = rest.replace(/^\[msg:\w+\] /, '');

      // Messages received
      const recvMatch = MESSAGE_RECEIVED_RE.exec(body);
      if (recvMatch) {
        stats.summary.totalMessagesReceived++;
        stats.hourlyActivity[hour].messagesReceived++;
        const [, groupName, groupId] = recvMatch;
        const key = groupId;
        const existing = groupMap.get(key);
        if (existing) {
          existing.messageCount++;
        } else {
          groupMap.set(key, { groupName, groupId, messageCount: 1 });
        }
        continue;
      }

      // Messages sent
      if (MESSAGE_SENT_RE.test(body)) {
        stats.summary.totalMessagesSent++;
        stats.hourlyActivity[hour].messagesSent++;
        continue;
      }

      // LLM provider calls (from provider "Generating with model" logs)
      const provMatch = PROVIDER_GENERATING_RE.exec(body);
      if (provMatch) {
        const providerName = normalizeProviderName(provMatch[1]);
        stats.summary.totalLLMCalls++;
        stats.hourlyActivity[hour].llmCalls++;
        if (!providerMap.has(providerName)) {
          providerMap.set(providerName, {
            provider: providerName,
            callCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            promptChars: 0,
            responseChars: 0,
          });
        }
        const entry = providerMap.get(providerName);
        if (entry) entry.callCount++;
        continue;
      }

      // LLM usage stats (from LLMService structured log)
      const usageMatch = LLM_USAGE_RE.exec(body);
      if (usageMatch) {
        const [, provider, pt, ct, tt, pc, rc] = usageMatch;
        const provName = provider.toLowerCase();
        if (!providerMap.has(provName)) {
          providerMap.set(provName, {
            provider: provName,
            callCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            promptChars: 0,
            responseChars: 0,
          });
        }
        const ps = providerMap.get(provName);
        if (ps) {
          ps.promptTokens += Number(pt);
          ps.completionTokens += Number(ct);
          ps.totalTokens += Number(tt);
          ps.promptChars += Number(pc);
          ps.responseChars += Number(rc);
        }
        stats.summary.totalTokensUsed += Number(tt);
        stats.summary.totalPromptChars += Number(pc);
        stats.summary.totalResponseChars += Number(rc);
      }
    }
  }

  // Sort providers by call count
  stats.providerStats = [...providerMap.values()].sort((a, b) => b.callCount - a.callCount);

  // Sort groups by message count, take top 20
  stats.topGroups = [...groupMap.values()].sort((a, b) => b.messageCount - a.messageCount).slice(0, 20);

  return stats;
}

function getAvailableDates(logsDir: string): string[] {
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
}

// ---------------------------------------------------------------------------
// DailyStatsBackend
// ---------------------------------------------------------------------------

export class DailyStatsBackend {
  private readonly logsDir: string;

  constructor() {
    this.logsDir = join(process.cwd(), 'logs');
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    const subPath = pathname.slice(API_PREFIX.length);

    // GET /api/stats/dates
    if (subPath === '/dates') {
      return this.handleDates();
    }

    // GET /api/stats?date=YYYY-MM-DD
    if (subPath === '' || subPath === '/') {
      const url = new URL(req.url);
      return this.handleStats(url);
    }

    return errorResponse('Not found', 404);
  }

  private handleDates(): Response {
    try {
      const dates = getAvailableDates(this.logsDir);
      return jsonResponse({ dates });
    } catch (err) {
      logger.error('[DailyStatsBackend] dates error:', err);
      return errorResponse('Failed to list dates', 500);
    }
  }

  private handleStats(url: URL): Response {
    try {
      // Default to today's date
      const now = new Date();
      const defaultDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const date = url.searchParams.get('date') ?? defaultDate;

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return errorResponse('Invalid date format. Use YYYY-MM-DD', 400);
      }

      const stats = parseLogFiles(this.logsDir, date);
      return jsonResponse({ stats });
    } catch (err) {
      logger.error('[DailyStatsBackend] stats error:', err);
      return errorResponse('Failed to parse stats', 500);
    }
  }
}
