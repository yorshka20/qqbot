import { describe, expect, it } from 'bun:test';
import { listCues, renderCues, stripCues } from '../speechCues';

describe('speechCues', () => {
  it('passes cues through for bracket backends', () => {
    expect(renderCues('[happy] 你好呀', 'brackets')).toBe('[happy] 你好呀');
  });

  it('strips cues for backends without cue support', () => {
    expect(renderCues('[excited] 我们赢了 [laughing] 哈哈哈', 'none')).toBe('我们赢了 哈哈哈');
    expect(stripCues('你好[高兴]呀')).toBe('你好呀');
  });

  it('leaves long or multi-line bracket text alone', () => {
    const prose = `[${'x'.repeat(60)}] 正文`;
    expect(stripCues(prose)).toBe(prose);
  });

  it('lists cues in order', () => {
    expect(listCues('[a] one [b] two')).toEqual(['a', 'b']);
  });
});
