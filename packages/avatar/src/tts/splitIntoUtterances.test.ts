import { describe, expect, test } from 'bun:test';
import { splitIntoUtterances } from './splitIntoUtterances';

describe('splitIntoUtterances', () => {
  test('Chinese multi-sentence', () => {
    const result = splitIntoUtterances('你好啊。今天天气不错！你吃了吗？');
    expect(result).toEqual(['你好啊。', '今天天气不错！', '你吃了吗？']);
  });

  test('English multi-sentence', () => {
    const result = splitIntoUtterances("Hello. How are you? I'm fine.");
    expect(result).toEqual(['Hello.', ' How are you?', " I'm fine."]);
  });

  test('mixed Chinese and English', () => {
    const result = splitIntoUtterances('Hi 小明. 你好 world！');
    expect(result).toEqual(['Hi 小明.', ' 你好 world！']);
  });

  test('long sentence with clause separators', () => {
    // Test a truly long one with clause separators
    const veryLong =
      '这是一个非常长的句子，里面有很多的分隔符，我们可以一起，来进行测试，看看它如何被切分，保证每段都在限制范围内。' +
      '这是一个非常长的句子，里面有很多的分隔符，我们可以一起，来进行测试，看看它如何被切分，保证每段都在限制范围内。' +
      '这是一个非常长的句子，里面有很多的分隔符，我们可以一起，来进行测试，看看它如何被切分，保证每段都在限制范围内。';

    const result = splitIntoUtterances(veryLong, 80);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });

  test('whitespace and empty strings', () => {
    expect(splitIntoUtterances('   ')).toEqual([]);
    expect(splitIntoUtterances('')).toEqual([]);
    expect(splitIntoUtterances('  \n\t  ')).toEqual([]);
  });

  test('long text without punctuation falls back to hard split', () => {
    // No sentence terminators, no clause separators, > 80 chars
    const longText =
      '这是一个没有任何标点符号的长文本我们需要将它硬切成小块每块大约八十个字符左右这是一个没有任何标点符号的长文本我们需要将它硬切成小块每块大约八十个字符左右这是一个没有任何标点符号的长文本';
    const result = splitIntoUtterances(longText, 80);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });
});
