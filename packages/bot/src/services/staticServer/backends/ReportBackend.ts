/**
 * Report backend: REST API (/api/reports) for WeChat reports.
 *
 * API contract:
 * - GET  /api/reports/list          -> { reports: ReportListItem[] }
 * - GET  /api/reports/:id           -> { report: StructuredReport, metadata: ReportMetadata }
 * - GET  /api/reports/:id/markdown  -> raw markdown text
 */

import { getContainer } from '@/core/DIContainer';
import { type ReportFile, type ReportMetadata, WechatDITokens, type WechatReportService } from '@/services/wechat';
import { logger } from '@/utils/logger';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/reports';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

/** Summary info for report list (without full content) */
export interface ReportListItem {
  id: string;
  type: string;
  title: string;
  generatedAt: string;
  period: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

/** Response for GET /api/reports/list */
export interface ReportListResponse {
  reports: ReportListItem[];
}

/** Response for GET /api/reports/:id */
export interface ReportDetailResponse {
  report: ReportFile['report'];
  metadata: ReportMetadata;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' } as const;

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: TEXT_HEADERS });
}

// ---------------------------------------------------------------------------
// ReportBackend
// ---------------------------------------------------------------------------

export class ReportBackend implements Backend {
  readonly prefix = API_PREFIX;
  private reportService: WechatReportService | null = null;

  private getReportService(): WechatReportService | null {
    if (this.reportService) return this.reportService;

    try {
      const container = getContainer();
      this.reportService = container.resolve<WechatReportService>(WechatDITokens.REPORT_SERVICE);
      return this.reportService;
    } catch {
      logger.debug('[ReportBackend] WechatReportService not available');
      return null;
    }
  }

  /**
   * Entry: if pathname is under /api/reports, dispatch to the matching route and return Response.
   * Otherwise return null so the caller can try other handlers.
   */
  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) {
      return null;
    }

    const service = this.getReportService();
    if (!service) {
      return errorResponse('Report service not available', 503);
    }

    // Parse route
    const subPath = pathname.slice(API_PREFIX.length);

    // GET /api/reports/list
    if (req.method === 'GET' && subPath === '/list') {
      return this.handleList(service);
    }

    // GET /api/reports/:id/markdown
    const markdownMatch = subPath.match(/^\/([^/]+)\/markdown$/);
    if (req.method === 'GET' && markdownMatch) {
      const id = markdownMatch[1];
      return this.handleGetMarkdown(service, id!);
    }

    // GET /api/reports/:id
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (req.method === 'GET' && idMatch) {
      const id = idMatch[1];
      return this.handleGetById(service, id!);
    }

    return errorResponse('Not found', 404);
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /** GET /api/reports/list — list all reports with summary info */
  private handleList(service: WechatReportService): Response {
    try {
      const metadata = service.listReportMetadata();

      const reports: ReportListItem[] = metadata.map((m) => {
        // Try to get the title from the full report
        const full = service.getReportById(m.id);
        return {
          id: m.id,
          type: m.type,
          title: full?.report.title ?? `${m.type} - ${m.generatedAt}`,
          generatedAt: m.generatedAt,
          period: m.period,
          stats: m.stats,
        };
      });

      // Sort by generatedAt descending (newest first)
      reports.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

      return jsonResponse<ReportListResponse>({ reports });
    } catch (err) {
      logger.error('[ReportBackend] list error:', err);
      return errorResponse('Failed to list reports', 500);
    }
  }

  /** GET /api/reports/:id — get full structured report */
  private handleGetById(service: WechatReportService, id: string): Response {
    try {
      const reportFile = service.getReportById(id);
      if (!reportFile) {
        return errorResponse('Report not found', 404);
      }

      return jsonResponse<ReportDetailResponse>({
        report: reportFile.report,
        metadata: reportFile.metadata,
      });
    } catch (err) {
      logger.error('[ReportBackend] get error:', err);
      return errorResponse('Failed to get report', 500);
    }
  }

  /** GET /api/reports/:id/markdown — get raw markdown content */
  private handleGetMarkdown(service: WechatReportService, id: string): Response {
    try {
      const reportFile = service.getReportById(id);
      if (!reportFile) {
        return errorResponse('Report not found', 404);
      }

      return textResponse(reportFile.report.markdownContent);
    } catch (err) {
      logger.error('[ReportBackend] get markdown error:', err);
      return errorResponse('Failed to get report markdown', 500);
    }
  }
}
