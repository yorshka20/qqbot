import { describe, expect, it } from 'bun:test';
import type { IncomingSegment } from '@saltify/milky-types';
import { MessageUtils } from '@/message/MessageUtils';
import { MilkyMessageSegmentParser } from './MilkyMessageSegmentParser';

type ForwardData = Extract<IncomingSegment, { type: 'forward' }>['data'];

function forwardSegment(overrides: Partial<ForwardData> = {}): IncomingSegment {
  return {
    type: 'forward',
    data: {
      forward_id: 'Zm9yd2FyZC1pZC0wMDE=',
      title: '群聊的聊天记录',
      preview: ['测试用户甲: 明天几点集合', '测试用户乙: 九点'],
      summary: '查看2条转发消息',
      ...overrides,
    },
  };
}

describe('MilkyMessageSegmentParser forward placeholder', () => {
  it('carries the forward_id the read_forward tool needs, plus title/summary/preview', () => {
    const text = MilkyMessageSegmentParser.segmentsToText([forwardSegment()]);

    expect(text).toContain('forward_id=Zm9yd2FyZC1pZC0wMDE=');
    expect(text).toContain('群聊的聊天记录');
    expect(text).toContain('查看2条转发消息');
    expect(text).toContain('测试用户甲: 明天几点集合');
    expect(text).toContain('测试用户乙: 九点');
  });

  it('keeps the whole placeholder inside one balanced bracket pair', () => {
    const text = MilkyMessageSegmentParser.segmentsToText([
      forwardSegment({ preview: ['测试用户甲: [动画表情]', '测试用户乙: 收到]]['] }),
    ]);

    expect(text.split('[')).toHaveLength(2);
    expect(text.split(']')).toHaveLength(2);
    expect(text.endsWith(']')).toBe(true);
  });

  it('hides forwarded content from wake-word matching', () => {
    // Forwarded text is quoted foreign content: a nickname or keyword inside it
    // must not trigger a reply the sender never asked for.
    const text = MilkyMessageSegmentParser.segmentsToText([
      forwardSegment({ title: '小助手的聊天记录', preview: ['测试用户甲: 小助手 在吗'] }),
    ]);

    expect(MessageUtils.extractUserText(text)).toBe('');
  });

  it('omits the preview section when the forward has no preview lines', () => {
    const text = MilkyMessageSegmentParser.segmentsToText([forwardSegment({ preview: [] })]);

    expect(text).not.toContain('preview:');
    expect(text).toContain('forward_id=');
  });
});
