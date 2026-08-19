// Statement-shape guard for LLM-authored SQL.
//
// The read-only connection in SqlQueryRunner is what actually rejects writes.
// This guard covers the two things a read-only connection still accepts but
// that would do something other than what the caller asked for:
//   - ATTACH / PRAGMA — not writes, but they reach outside the queried database
//   - trailing statements — sqlite3_prepare only compiles the first statement
//     and silently drops the rest, so a two-statement input would half-execute
// Literals and comments are masked before inspection so that a query like
// `WHERE content LIKE '%;%'` is not mistaken for two statements.

const READ_STATEMENT_HEAD = /^(select|with|explain)\b/i;

export type SqlValidation = { ok: true; statement: string } | { ok: false; reason: string };

export function validateReadStatement(input: string): SqlValidation {
  const statement = input.trim();
  if (!statement) {
    return { ok: false, reason: 'sql 不能为空' };
  }

  const masked = maskLiteralsAndComments(statement);
  const bodyEnd = endOfStatementBody(masked);
  if (bodyEnd === 0) {
    return { ok: false, reason: 'sql 不能为空' };
  }

  const body = masked.slice(0, bodyEnd);
  if (body.includes(';')) {
    return { ok: false, reason: '一次只能执行一条语句，请去掉语句中间的分号' };
  }

  const head = body.replace(/^\s+/, '');
  if (!READ_STATEMENT_HEAD.test(head)) {
    const keyword = head.match(/^[A-Za-z_]+/)?.[0] ?? head.slice(0, 16);
    return {
      ok: false,
      reason: `只接受 SELECT / WITH / EXPLAIN 开头的只读查询，收到「${keyword}」。写操作、ATTACH、PRAGMA 均不可用。`,
    };
  }

  return { ok: true, statement: statement.slice(0, bodyEnd).trim() };
}

/** Index just past the last character that is neither whitespace nor a statement separator. */
function endOfStatementBody(masked: string): number {
  let end = masked.length;
  while (end > 0) {
    const c = masked[end - 1];
    if (c === ';' || /\s/.test(c)) {
      end--;
      continue;
    }
    break;
  }
  return end;
}

/**
 * Blank out string literals, quoted identifiers and comments, preserving length
 * so offsets in the masked copy still map onto the original statement.
 */
function maskLiteralsAndComments(sql: string): string {
  const chars = sql.split('');
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];

    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        chars[i] = ' ';
        i++;
      }
      if (i < sql.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      chars[i] = ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          chars[i] = ' ';
          i++;
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i] === quote) {
            chars[i] = ' ';
            i++;
            continue;
          }
          break;
        }
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '[') {
      chars[i] = ' ';
      i++;
      while (i < sql.length && sql[i] !== ']') {
        chars[i] = ' ';
        i++;
      }
      if (i < sql.length) {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    i++;
  }

  return chars.join('');
}
