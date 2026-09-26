import { describe, expect, it } from 'bun:test';
import { renderSlot } from '../renderSlot';

describe('renderSlot', () => {
  it('puts manual facts first under their own heading, then automatic facts by scope order', () => {
    const text = renderSlot(
      [{ scope: 'instruction', content: '不要用 emoji' }],
      [
        { scope: 'context', content: '群原本是技术群' },
        { scope: 'identity:work', content: '做运营商工作' },
      ],
    );
    expect(text).toBe(
      [
        '【人工维护，与其他条目冲突时以此为准】',
        '[instruction]',
        '- 不要用 emoji',
        '',
        '【自动整理】',
        '[identity:work]',
        '- 做运营商工作',
        '',
        '[context]',
        '- 群原本是技术群',
      ].join('\n'),
    );
  });

  it('has no headings when there is no manual memory', () => {
    expect(renderSlot([], [{ scope: 'rule', content: '不刷屏' }])).toBe('[rule]\n- 不刷屏');
  });
});
