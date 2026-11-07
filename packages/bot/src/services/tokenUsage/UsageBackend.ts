/**
 * Usage backend: REST API (/api/usage) serving the same report as the `/usage` command.
 *
 * API contract:
 * - GET /api/usage?date=YYYY-MM-DD -> { report: UsageDailyReport }   (date defaults to today)
 */

import type { UsageReportResponse } from '@qqbot/api-types';
import { logger } from '@qqbot/shared';
import { getContainer } from '@/core/DIContainer';
import { type Backend, errorResponse, jsonResponse, registerStaticBackend } from '@/services/staticServer/backend';
import { TokenUsageService } from './TokenUsageService';

const API_PREFIX = '/api/usage';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_USER_LIMIT = 100;

export class UsageBackend implements Backend {
  readonly prefix = API_PREFIX;

  constructor(private readonly tokenUsage: TokenUsageService) {}

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) {
      return null;
    }
    if (req.method !== 'GET') {
      return errorResponse('Method not allowed', 405);
    }
    const subPath = pathname.slice(API_PREFIX.length);
    if (subPath === '' || subPath === '/') {
      return this.handleReport(new URL(req.url));
    }
    return errorResponse('Not found', 404);
  }

  private async handleReport(url: URL): Promise<Response> {
    const date = url.searchParams.get('date') ?? this.tokenUsage.getLocalDate();
    if (!DATE_PATTERN.test(date)) {
      return errorResponse('Invalid date, expected YYYY-MM-DD', 400);
    }
    try {
      const report = await this.tokenUsage.getDailyReport(date, TOP_USER_LIMIT);
      return jsonResponse<UsageReportResponse>({ report });
    } catch (err) {
      logger.error('[UsageBackend] Failed to build usage report:', err);
      return errorResponse('Failed to build usage report', 500);
    }
  }
}

registerStaticBackend({
  id: 'usage',
  // container-lookup: not-di-built backends are built by the static server, not the container
  create: () => new UsageBackend(getContainer().resolve(TokenUsageService)),
});
