// AgendaReporter - appends per-run entries to a daily markdown report file.
//
// Output: data/agenda/reports/YYYY-MM-DD.md
//
// Daily report format:
//
//   # Bot日报 - 2026-03-10
//
//   ## 执行记录
//
//   ### 08:00:05 ✅ 每日热搜播报
//   - **群**: 123456789
//   - **意图**: 搜索今日微博热搜前10...
//   - **耗时**: 2.3s
//
//   ### 16:30:02 ❌ 午间提醒
//   - **意图**: 提醒大家喝水...
//   - **错误**: LLM调用失败 - No provider available
//
//   ---
//   *今日共执行 2 次，成功 1 次，失败 1 次*

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import type { AgendaItem } from './types';

export interface RunRecord {
  item: AgendaItem;
  startedAt: Date;
  durationMs: number;
  success: boolean;
  error?: string;
}

export class AgendaReporter {
  constructor(private reportsDir: string) {}

  /**
   * Append a run record to today's report file.
   * Creates the file (with header) if it doesn't exist.
   */
  async recordRun(record: RunRecord): Promise<void> {
    try {
      const filePath = this.todayFilePath();
      await this.ensureFileHeader(filePath);
      const entry = this.formatEntry(record);
      await appendFile(filePath, entry, 'utf-8');
    } catch (err) {
      // Never let reporting errors break execution
      logger.warn('[AgendaReporter] Failed to write run record:', err);
    }
  }

  /**
   * Write a summary footer to today's report (call at EOD or on shutdown).
   * Reads the file to count successes/failures.
   */
  async writeSummary(): Promise<void> {
    try {
      const filePath = this.todayFilePath();
      const content = await readFile(filePath, 'utf-8').catch(() => '');
      if (!content) return;

      const successes = (content.match(/✅/g) ?? []).length;
      const failures = (content.match(/❌/g) ?? []).length;
      const total = successes + failures;

      const summary =
        `\n---\n*今日共执行 ${total} 次，成功 ${successes} 次，失败 ${failures} 次*\n`;

      // Avoid duplicate summary lines
      if (content.includes('今日共执行')) return;

      await appendFile(filePath, summary, 'utf-8');
    } catch (err) {
      logger.warn('[AgendaReporter] Failed to write summary:', err);
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  private todayFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.reportsDir, `${date}.md`);
  }

  private async ensureFileHeader(filePath: string): Promise<void> {
    await mkdir(this.reportsDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const header = `# Bot日报 - ${date}\n\n## 执行记录\n\n`;

    try {
      await readFile(filePath, 'utf-8');
      // File exists, no header needed
    } catch {
      await writeFile(filePath, header, 'utf-8');
    }
  }

  private formatEntry(record: RunRecord): string {
    const { item, startedAt, durationMs, success, error } = record;

    const time = startedAt.toTimeString().slice(0, 8); // HH:MM:SS
    const icon = success ? '✅' : '❌';
    const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;

    const intentSnippet = item.intent.length > 50 ? `${item.intent.slice(0, 50)}...` : item.intent;

    const lines: string[] = [
      `### ${time} ${icon} ${item.name}`,
    ];

    if (item.groupId) lines.push(`- **群**: ${item.groupId}`);
    if (item.userId) lines.push(`- **用户**: ${item.userId}`);
    lines.push(`- **意图**: ${intentSnippet}`);
    lines.push(`- **耗时**: ${durationStr}`);

    if (!success && error) {
      lines.push(`- **错误**: ${error}`);
    }

    lines.push('');
    return `${lines.join('\n')}\n`;
  }
}
