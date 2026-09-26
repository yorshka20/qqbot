import { describe, expect, it } from 'bun:test';
import { parseMemoryDocument } from './utils';

describe('parseMemoryDocument', () => {
  it('keeps each file section intact, including periods inside a sentence', () => {
    const text = '[context]\n群主是甲。版本 5.0 已上线。\n\n[topic:tech]\n讨论渲染。\n';
    expect(parseMemoryDocument(text)).toEqual([
      { scope: 'context', content: '群主是甲。版本 5.0 已上线。' },
      { scope: 'topic:tech', content: '讨论渲染。' },
    ]);
  });

  it('drops blank separators between sections', () => {
    const text = '[rule]\n不要用表情。\n\n\n[event]\n下周搬家。\n';
    const sections = parseMemoryDocument(text);
    expect(sections.map((section) => section.content)).toEqual(['不要用表情。', '下周搬家。']);
  });
});
