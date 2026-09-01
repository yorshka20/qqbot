import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { PromptManager } from '@/ai';
import type { AgendaService } from '../AgendaService';
import { ScheduleFileService } from '../ScheduleFileService';

const FILE = `# Bot Schedule

---

## 有启用字段的任务
- 触发: \`cron 0 2 * * *\`
- 冷却: \`1min\`
- 启用: \`true\`

派发 ticket。

---

## 没有启用字段的任务
- 触发: \`cron 0 8 * * *\`
- 群: \`10000001\`
- 冷却: \`82800000\`
- 执行: \`action group_report\`

生成汇报。
`;

let path: string;
let service: ScheduleFileService;

async function enabledOf(name: string): Promise<boolean | undefined> {
  const parsed = service.parseSchedule(await readFile(path, 'utf-8'));
  return parsed.find((i) => i.name === name)?.enabled;
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-file-'));
  path = join(dir, 'schedule.md');
  await writeFile(path, FILE, 'utf-8');
  service = new ScheduleFileService(path, null as unknown as AgendaService, null as unknown as PromptManager);
});

describe('ScheduleFileService.setItemEnabledByName', () => {
  it('rewrites an existing 启用 line', async () => {
    expect(await service.setItemEnabledByName('有启用字段的任务', false)).toBe(true);
    expect(await enabledOf('有启用字段的任务')).toBe(false);
  });

  it('inserts a 启用 line after the metadata block when absent', async () => {
    expect(await service.setItemEnabledByName('没有启用字段的任务', false)).toBe(true);
    expect(await enabledOf('没有启用字段的任务')).toBe(false);

    // The inserted line must not land in the intent paragraph
    const section = (await readFile(path, 'utf-8')).split('## 没有启用字段的任务')[1];
    expect(section.indexOf('- 启用:')).toBeLessThan(section.indexOf('生成汇报。'));
  });

  it('keeps other sections and their fields untouched', async () => {
    await service.setItemEnabledByName('没有启用字段的任务', false);

    const other = service
      .parseSchedule(await readFile(path, 'utf-8'))
      .find((i) => i.name === '有启用字段的任务');
    expect(other?.enabled).toBe(true);

    const target = service
      .parseSchedule(await readFile(path, 'utf-8'))
      .find((i) => i.name === '没有启用字段的任务');
    expect(target?.actionTarget).toBe('group_report');
    expect(target?.groupId).toBe('10000001');
    expect(target?.intent).toBe('生成汇报。');
  });

  it('round-trips back to enabled', async () => {
    await service.setItemEnabledByName('没有启用字段的任务', false);
    await service.setItemEnabledByName('没有启用字段的任务', true);
    expect(await enabledOf('没有启用字段的任务')).toBe(true);
  });

  it('reports a missing section instead of writing', async () => {
    expect(await service.setItemEnabledByName('不存在的任务', false)).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe(FILE);
  });
});
