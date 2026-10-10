// Render a deck containing every card type in both appearances, for eyeballing
// a style change.
//
//   NO_FILE_LOG=1 bun run packages/bot/scripts/dev/render-card-deck.ts [outDir]
//
// NO_FILE_LOG=1 matters: the file logger's flush timer keeps the process alive
// after the renders finish.

import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardRenderer } from '@/services/card/CardRenderer';
import type { CardData } from '@/services/card/cardTypes';
import type { CardAppearance } from '@/services/card/styles';

const DECK: CardData[] = [
  { type: 'paragraph', content: '段落块：第一行文本。\n第二行文本，带 **强调** 与 *斜体*。' },
  {
    type: 'qa',
    question: '问题卡：这段 `inline code` 看得清吗？',
    answer: '<p>答案段落，含 <strong>加粗</strong>、<em>标注</em> 与 <code>const x = 1</code>。</p><ul><li>要点一</li><li>要点二</li></ul>',
  },
  { type: 'list', title: '列表卡', items: ['第一项 **加粗**', '第二项<ul><li>嵌套一</li><li>嵌套二</li></ul>', '第三项'] },
  { type: 'info', title: '信息卡 info', content: '<p>普通提示，含 <strong>加粗</strong> 和 <em>标注</em>。</p>', level: 'info' },
  { type: 'info', title: '信息卡 warning', content: '<p>警告提示。</p>', level: 'warning' },
  { type: 'info', title: '信息卡 success', content: '<p>成功提示。</p>', level: 'success' },
  { type: 'info', title: '信息卡 tip', content: '<p>小技巧提示。</p>', level: 'tip' },
  {
    type: 'comparison',
    title: '对比卡',
    leftHeader: '方案甲',
    rightHeader: '方案乙',
    items: [
      { label: '成本', left: '<ul><li>低</li><li>可控</li></ul>', right: '<ul><li>高</li></ul>' },
      { label: '维护', left: '简单', right: '需要专人' },
    ],
  },
  {
    type: 'knowledge',
    term: '知识卡：术语',
    definition: '定义正文，含 **加粗** 与 *标注*，再加一行说明。',
    examples: ['例子一：`code`', '例子二'],
  },
  { type: 'highlight', title: '要点卡', summary: '一句话结论。', detail: '补充说明细节。' },
  { type: 'quote', text: '引用卡：一段被引用的话。', source: '某人' },
  { type: 'steps', title: '步骤卡', steps: ['准备输入', '执行转换', '校验输出'] },
  {
    type: 'stats',
    title: '数据卡',
    data: [
      { label: '总数', value: '1,284' },
      { label: '成功率', value: '98.6%', highlight: true },
      { label: '备注', value: '包含重试请求在内的全部结果' },
    ],
  },
  {
    type: 'markdown',
    title: 'Markdown 卡',
    content:
      '## 二级标题\n\n正文含 **加粗**、*斜体*、~~删除~~ 与 `inline code`。\n\n> 引用块\n\n```ts\nconst x: number = 1;\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| a | b |\n| c | d |\n\n- 列表一\n- 列表二\n',
  },
];

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? '/tmp';
  for (const appearance of ['light', 'dark'] as CardAppearance[]) {
    const buffer = await CardRenderer.getInstance().render(DECK, { provider: 'claude', appearance });
    const path = join(outDir, `card-deck-${appearance}.webp`);
    writeFileSync(path, buffer);
    console.log(`${appearance} → ${path} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }
  await CardRenderer.cleanup();
}

await main();
