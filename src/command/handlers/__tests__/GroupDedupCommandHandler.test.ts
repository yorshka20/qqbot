import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIService } from '@/ai';
import { GroupDedupCommandHandler } from '@/command/handlers/GroupDedupCommandHandler';
import type { CommandContext } from '@/command/types';
import { FileReadService } from '@/services/file';

function createContext(): CommandContext {
  return {
    userId: 1,
    groupId: 1,
    messageType: 'group',
    rawMessage: '/dedup_group 123456',
    messageScene: 'group',
    metadata: {
      protocol: 'milky',
      senderRole: 'admin',
    },
    conversationContext: {} as CommandContext['conversationContext'],
  } as CommandContext;
}

function getText(result: Awaited<ReturnType<GroupDedupCommandHandler['execute']>>): string {
  const textSeg = result.segments?.find((seg) => seg.type === 'text');
  const text = textSeg?.data?.text;
  return typeof text === 'string' ? text : '';
}

function createAiServiceMock(): AIService {
  return {
    renderCardToSegments: async () => [{ type: 'text', data: { text: 'card' } }],
  } as unknown as AIService;
}

describe('GroupDedupCommandHandler', () => {
  it('reads and deduplicates from current project output/downloads/{groupId}', async () => {
    const oldCwd = process.cwd();
    const tempRoot = join(tmpdir(), `qqbot-dedup-${Date.now()}-1`);

    try {
      mkdirSync(join(tempRoot, 'output/downloads/123456'), { recursive: true });
      process.chdir(tempRoot);

      const groupDir = join(tempRoot, 'output/downloads/123456');
      const oldestFile = join(groupDir, 'a.txt');
      const duplicateFile = join(groupDir, 'b.txt');
      const uniqueFile = join(groupDir, 'c.txt');

      writeFileSync(oldestFile, 'same-content');
      writeFileSync(duplicateFile, 'same-content');
      writeFileSync(uniqueFile, 'unique-content');
      utimesSync(oldestFile, 1000, 1000);
      utimesSync(duplicateFile, 2000, 2000);

      const handler = new GroupDedupCommandHandler(new FileReadService(), createAiServiceMock());
      const result = await handler.execute(['123456'], createContext());

      expect(result.success).toBe(true);
      expect(existsSync(oldestFile)).toBe(true);
      expect(existsSync(uniqueFile)).toBe(true);
      expect(existsSync(duplicateFile)).toBe(false);
      expect(readFileSync(oldestFile, 'utf8')).toBe('same-content');

      const text = getText(result);
      expect(text).toContain('群 123456 去重完成');
      expect(text).toContain('扫描文件：3 个');
      expect(text).toContain('发现重复：1 个');
    } finally {
      process.chdir(oldCwd);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns friendly output when output/downloads/{groupId} does not exist', async () => {
    const oldCwd = process.cwd();
    const tempRoot = join(tmpdir(), `qqbot-dedup-${Date.now()}-2`);

    try {
      mkdirSync(tempRoot, { recursive: true });
      process.chdir(tempRoot);

      const handler = new GroupDedupCommandHandler(new FileReadService(), createAiServiceMock());
      const result = await handler.execute(['123456'], createContext());

      expect(result.success).toBe(true);
      const text = getText(result);
      expect(text).toContain('群 123456 去重完成');
      expect(text).toContain('扫描文件：0 个');
      expect(text).toContain('目录状态：未找到 output/downloads/123456');
    } finally {
      process.chdir(oldCwd);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
