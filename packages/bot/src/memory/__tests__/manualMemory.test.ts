import { describe, expect, it } from 'bun:test';
import { coreScopeOf, parseManualFacts } from '../manualMemory';

describe('parseManualFacts', () => {
  it('reads one fact per line under each scope header', () => {
    const text = '[instruction]\n不要用 emoji。\n回答要核实。\n\n[context]\n群主是甲。\n';
    expect(parseManualFacts(text)).toEqual([
      { scope: 'instruction', content: '不要用 emoji。' },
      { scope: 'instruction', content: '回答要核实。' },
      { scope: 'context', content: '群主是甲。' },
    ]);
  });

  it('keeps names and versions whole instead of splitting on periods', () => {
    expect(parseManualFacts('[context]\n管理员 M.C.G.A. 在用 Qwen3.5 和 laozhang.ai。')).toEqual([
      { scope: 'context', content: '管理员 M.C.G.A. 在用 Qwen3.5 和 laozhang.ai。' },
    ]);
  });

  it('strips list bullets and files lines before any header under context', () => {
    expect(parseManualFacts('开头一行\n[Rule:Bot]\n- 不刷屏\n* 不发广告')).toEqual([
      { scope: 'context', content: '开头一行' },
      { scope: 'rule:bot', content: '不刷屏' },
      { scope: 'rule:bot', content: '不发广告' },
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseManualFacts('  \n\n')).toEqual([]);
  });
});

describe('coreScopeOf', () => {
  it('drops the subtag', () => {
    expect(coreScopeOf('preference:food')).toBe('preference');
    expect(coreScopeOf('identity')).toBe('identity');
  });
});
