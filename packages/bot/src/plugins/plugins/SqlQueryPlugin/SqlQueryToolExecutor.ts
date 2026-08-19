// query_database tool executor - read-only SQL access to the bot's own SQLite database.

import type { ToolCall, ToolExecutor, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import { formatRowsAsTable } from './formatRows';
import type { SqlQueryRunner } from './SqlQueryRunner';
import { buildDdlSql, fetchRowCounts, INTROSPECTION_ROW_CAP, isSafeTableName, SCHEMA_SUMMARY_SQL } from './schema';
import { validateReadStatement } from './validateSql';

export interface SqlQueryToolLimits {
  /** Rows returned when the call omits `limit`. */
  defaultRows: number;
  /** Ceiling the caller's `limit` is clamped to. */
  maxRows: number;
  maxOutputChars: number;
}

export class SqlQueryToolExecutor implements ToolExecutor {
  name = 'query_database';

  constructor(
    private readonly runner: SqlQueryRunner,
    private readonly limits: SqlQueryToolLimits,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const action = call.parameters?.action;
    if (action === 'describe') {
      return this.describe(call);
    }
    if (action === 'query') {
      return this.query(call);
    }
    return this.error('action 必须为 query 或 describe', 'invalid action');
  }

  /** Free-form read query written by the caller. */
  private async query(call: ToolCall): Promise<ToolResult> {
    const raw = typeof call.parameters?.sql === 'string' ? call.parameters.sql : '';
    const validation = validateReadStatement(raw);
    if (!validation.ok) {
      return this.error(validation.reason, 'invalid sql');
    }

    const limit = this.resolveLimit(call.parameters?.limit);
    logger.info(`[SqlQueryPlugin] query limit=${limit}: ${validation.statement.replace(/\s+/g, ' ').slice(0, 300)}`);

    const outcome = await this.runner.run(validation.statement, limit);
    if (!outcome.ok) {
      return this.error(`查询失败：${outcome.error}`, outcome.error);
    }

    if (outcome.rows.length === 0) {
      const columns = outcome.columns.length > 0 ? outcome.columns.join(', ') : '(无)';
      return this.success(`查询成功但没有匹配的行（${outcome.elapsedMs}ms）。返回列：${columns}`);
    }

    const header = outcome.truncated
      ? `查询成功，返回前 ${outcome.rows.length} 行（已达 limit=${limit}，可能还有更多；需要总量请改用 count(*)）（${outcome.elapsedMs}ms）`
      : `查询成功，共 ${outcome.rows.length} 行（${outcome.elapsedMs}ms）`;

    return this.success(`${header}\n${formatRowsAsTable(outcome.columns, outcome.rows, this.limits.maxOutputChars)}`);
  }

  /** Schema listing: all tables in summary form, or full DDL for the named ones. */
  private async describe(call: ToolCall): Promise<ToolResult> {
    const requested = this.parseTableNames(call.parameters?.tables);
    if (requested.invalid.length > 0) {
      return this.error(`表名不合法：${requested.invalid.join(', ')}`, 'invalid table name');
    }

    if (requested.valid.length === 0) {
      return this.describeAll();
    }
    return this.describeTables(requested.valid);
  }

  private async describeAll(): Promise<ToolResult> {
    const outcome = await this.runner.run(SCHEMA_SUMMARY_SQL, INTROSPECTION_ROW_CAP);
    if (!outcome.ok) {
      return this.error(`读取表结构失败：${outcome.error}`, outcome.error);
    }

    const tables = outcome.rows.map((row) => String(row.tbl));
    const counts = await fetchRowCounts(this.runner, tables.filter(isSafeTableName));

    const lines = outcome.rows.map((row) => {
      const table = String(row.tbl);
      const count = counts.get(table);
      const size = count === undefined ? '' : `（${count} 行）`;
      return `- ${table}${size}: ${String(row.cols)}`;
    });

    return this.success(
      [
        `数据库共 ${tables.length} 张表。需要完整 DDL 和索引时，用 action=describe 并传 tables=["表名"]。`,
        ...lines,
      ].join('\n'),
    );
  }

  private async describeTables(tables: string[]): Promise<ToolResult> {
    const outcome = await this.runner.run(buildDdlSql(tables), INTROSPECTION_ROW_CAP);
    if (!outcome.ok) {
      return this.error(`读取表结构失败：${outcome.error}`, outcome.error);
    }
    if (outcome.rows.length === 0) {
      return this.error(`没有找到这些表：${tables.join(', ')}`, 'unknown tables');
    }

    const counts = await fetchRowCounts(this.runner, tables);
    const sections = tables.map((table) => {
      const ddl = outcome.rows.filter((row) => String(row.tbl_name) === table).map((row) => String(row.sql));
      const count = counts.get(table);
      const size = count === undefined ? '' : `（${count} 行）`;
      return [`=== ${table}${size} ===`, ...ddl].join('\n');
    });

    return this.success(sections.join('\n\n'));
  }

  private resolveLimit(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return Math.min(this.limits.defaultRows, this.limits.maxRows);
    }
    return Math.min(Math.floor(raw), this.limits.maxRows);
  }

  private parseTableNames(raw: unknown): { valid: string[]; invalid: string[] } {
    if (!Array.isArray(raw)) {
      return { valid: [], invalid: [] };
    }
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const entry of raw) {
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (!name) {
        continue;
      }
      if (isSafeTableName(name)) {
        valid.push(name);
      } else {
        invalid.push(name);
      }
    }
    return { valid, invalid };
  }

  private success(reply: string): ToolResult {
    return { success: true, reply };
  }

  private error(reply: string, error: string): ToolResult {
    return { success: false, reply, error };
  }
}
