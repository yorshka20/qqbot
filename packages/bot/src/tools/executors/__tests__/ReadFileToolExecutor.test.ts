import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileReadService } from '@/services/file';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { READ_FILE_TOOL_MAX_CHARS, ReadFileToolExecutor, readFileTruncationNotice } from '../ReadFileToolExecutor';

const context = { userId: 1, messageType: 'private' } as ToolExecutionContext;

function readCall(path: string): ToolCall {
  return { type: 'read_file', executor: 'read_file', parameters: { path, action: 'read' } };
}

describe('read_file tool output cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-file-tool-'));
  const executor = new ReadFileToolExecutor(new FileReadService({ root: dir, filterPaths: [], filterExtensions: [] }));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a file well above the old 15k slice when it still fits one source file', async () => {
    const body = 'export const n = 1;\n'.repeat(1000);
    writeFileSync(join(dir, 'ordinary.ts'), body);
    expect(body.length).toBeGreaterThan(15_000);
    expect(body.length).toBeLessThan(READ_FILE_TOOL_MAX_CHARS);

    const result = await executor.execute(readCall('ordinary.ts'), context);
    expect(result.success).toBe(true);
    expect(result.reply).toBe(body);
  });

  it('cuts an oversized file and tells the model to narrow search_code', async () => {
    const body = `${'a'.repeat(READ_FILE_TOOL_MAX_CHARS)}TAIL`;
    writeFileSync(join(dir, 'huge.ts'), body);

    const result = await executor.execute(readCall('huge.ts'), context);
    expect(result.success).toBe(true);
    expect(result.reply?.startsWith('a'.repeat(READ_FILE_TOOL_MAX_CHARS))).toBe(true);
    expect(result.reply?.includes('TAIL')).toBe(false);
    expect(result.reply?.endsWith(readFileTruncationNotice())).toBe(true);
    expect(result.reply).toContain('search_code');
  });
});