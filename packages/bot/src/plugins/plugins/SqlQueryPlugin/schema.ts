// Schema-introspection queries.
//
// Everything here is expressed as SELECTs over sqlite_master / pragma_table_info
// so it travels through the same read-only runner as user queries — there is no
// second, more-privileged path into the database.

import { logger } from '@/utils/logger';
import type { SqlQueryRunner } from './SqlQueryRunner';

/** Row cap for introspection queries; a database with more tables than this is not a real case. */
const INTROSPECTION_ROW_CAP = 500;

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SCHEMA_SUMMARY_SQL = `
SELECT m.name AS tbl, group_concat(p.name || ' ' || p.type, ', ') AS cols
FROM sqlite_master m
JOIN pragma_table_info(m.name) p
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
GROUP BY m.name
ORDER BY m.name
`.trim();

export function isSafeTableName(name: string): boolean {
  return TABLE_NAME_PATTERN.test(name);
}

/** Caller must have filtered `tables` through isSafeTableName first. */
export function buildRowCountSql(tables: string[]): string {
  return tables.map((table) => `SELECT '${table}' AS tbl, count(*) AS n FROM "${table}"`).join(' UNION ALL ');
}

/** Caller must have filtered `tables` through isSafeTableName first. */
export function buildDdlSql(tables: string[]): string {
  const list = tables.map((table) => `'${table}'`).join(', ');
  return `SELECT tbl_name, type, name, sql FROM sqlite_master WHERE tbl_name IN (${list}) AND sql IS NOT NULL ORDER BY tbl_name, type DESC, name`;
}

export async function fetchTableNames(runner: SqlQueryRunner): Promise<string[]> {
  const outcome = await runner.run(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    INTROSPECTION_ROW_CAP,
  );
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.rows.map((row) => String(row.name));
}

export async function fetchRowCounts(runner: SqlQueryRunner, tables: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (tables.length === 0) {
    return counts;
  }
  const outcome = await runner.run(buildRowCountSql(tables), INTROSPECTION_ROW_CAP);
  if (!outcome.ok) {
    logger.warn(`[SqlQueryPlugin] Row counts unavailable, describing schema without them: ${outcome.error}`);
    return counts;
  }
  for (const row of outcome.rows) {
    counts.set(String(row.tbl), Number(row.n));
  }
  return counts;
}

export { INTROSPECTION_ROW_CAP };
