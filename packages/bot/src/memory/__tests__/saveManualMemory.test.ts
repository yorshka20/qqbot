import 'reflect-metadata';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { Config } from '@/core/config';
import { GROUP_MEMORY_USER_ID, MemoryService } from '../MemoryService';
import type { MemoryRAGService } from '../MemoryRAGService';

function createService(): { service: MemoryService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-manual-'));
  const config = {
    getMemoryConfig: () => ({ dir: relative(process.cwd(), dir) }),
  } as Config;
  return { service: new MemoryService(config), dir };
}

describe('saveManualMemory', () => {
  it('writes the group slot to _global_/manual.txt and awaits indexing', async () => {
    const { service, dir } = createService();
    const calls: Array<{ userId: string; source: string; sections: number }> = [];
    service.setRAGService({
      isEnabled: () => true,
      indexMemorySections: async (
        _groupId: string,
        userId: string,
        sections: Array<{ content: string }>,
        source: string,
      ) => {
        calls.push({ userId, source, sections: sections.length });
      },
    } as unknown as MemoryRAGService);

    const result = await service.saveManualMemory('10000001', GROUP_MEMORY_USER_ID, '[context]\n测试群的背景。\n');

    expect(result.indexed).toBe(true);
    expect(readFileSync(join(dir, '10000001', '_global_', 'manual.txt'), 'utf-8')).toBe('[context]\n测试群的背景。');
    expect(calls).toEqual([{ userId: GROUP_MEMORY_USER_ID, source: 'manual', sections: 1 }]);
    expect(service.getGroupMemoryTextByLayer('10000001', 'auto')).toBe('');
  });

  it('writes a person slot to that user directory and leaves the group file alone', async () => {
    const { service, dir } = createService();
    service.setRAGService({
      isEnabled: () => true,
      indexMemorySections: async () => {},
    } as unknown as MemoryRAGService);

    await service.saveManualMemory('10000001', '10000002', '[preference:food]\n喜欢辣');

    expect(readFileSync(join(dir, '10000001', '10000002', 'manual.txt'), 'utf-8')).toBe('[preference:food]\n喜欢辣');
    expect(service.getGroupMemoryTextByLayer('10000001', 'manual')).toBe('');
  });

  it('still writes the file when indexing fails', async () => {
    const { service, dir } = createService();
    service.setRAGService({
      isEnabled: () => true,
      indexMemorySections: async () => {
        throw new Error('index down');
      },
    } as unknown as MemoryRAGService);

    const result = await service.saveManualMemory('10000001', '10000002', '[identity]\n测试用户甲');

    expect(result.indexed).toBe(false);
    expect(readFileSync(join(dir, '10000001', '10000002', 'manual.txt'), 'utf-8')).toBe('[identity]\n测试用户甲');
  });
});
