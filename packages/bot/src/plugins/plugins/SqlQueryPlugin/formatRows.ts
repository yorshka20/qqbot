// Renders query rows as a compact pipe table for LLM consumption.

const MAX_CELL_CHARS = 160;

export function formatRowsAsTable(columns: string[], rows: Array<Record<string, unknown>>, maxChars: number): string {
  if (columns.length === 0) {
    return '(查询没有返回任何列)';
  }

  const lines = [columns.join(' | '), columns.map(() => '---').join(' | ')];
  let used = lines.reduce((total, line) => total + line.length + 1, 0);
  let shown = 0;

  for (const row of rows) {
    const line = columns.map((column) => formatCell(row[column])).join(' | ');
    if (used + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
    shown++;
  }

  if (shown < rows.length) {
    lines.push(`…（输出长度受限，仅显示 ${shown}/${rows.length} 行）`);
  }

  return lines.join('\n');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_CELL_CHARS ? `${flattened.slice(0, MAX_CELL_CHARS)}…` : flattened;
}
