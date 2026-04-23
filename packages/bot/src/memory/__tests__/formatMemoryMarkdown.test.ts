import { describe, expect, it } from 'bun:test';
import { buildSpeakerTag, formatMemoryMarkdown } from '../formatMemoryMarkdown';

describe('formatMemoryMarkdown', () => {
  it('emits only the group block when there are no speakers', () => {
    const out = formatMemoryMarkdown({
      groupMemoryText: '[identity]\n群昵称：测试群',
    });
    expect(out).toBe('## 关于本群的记忆\n[identity]\n群昵称：测试群');
    expect(out).not.toContain('## 关于用户的记忆');
  });

  it('emits only the user block when group memory is empty', () => {
    const out = formatMemoryMarkdown({
      groupMemoryText: '   ',
      userSections: [{ uid: '123', nick: '张三', memoryText: '[preference:food]\n爱吃火锅' }],
    });
    expect(out).toBe('## 关于用户的记忆\n### [speaker:123:张三]\n[preference:food]\n爱吃火锅');
  });

  it('emits group + multiple speakers in order (bilibili multi-user batch)', () => {
    const out = formatMemoryMarkdown({
      groupMemoryText: '[rule]\n不透剧',
      userSections: [
        { uid: '111', nick: '米哈游工作室', memoryText: '[preference:game]\n喜欢崩铁' },
        { uid: '222', nick: '路人A', memoryText: '[history]\n第一次来' },
      ],
    });
    expect(out).toBe(
      [
        '## 关于本群的记忆',
        '[rule]',
        '不透剧',
        '',
        '## 关于用户的记忆',
        '### [speaker:111:米哈游工作室]',
        '[preference:game]',
        '喜欢崩铁',
        '',
        '### [speaker:222:路人A]',
        '[history]',
        '第一次来',
      ].join('\n'),
    );
  });

  it('drops speakers whose memoryText is empty or whitespace', () => {
    const out = formatMemoryMarkdown({
      userSections: [
        { uid: '111', nick: 'keep', memoryText: '[scope]\nfact' },
        { uid: '222', nick: 'drop-empty', memoryText: '' },
        { uid: '333', nick: 'drop-ws', memoryText: '   \n  ' },
      ],
    });
    expect(out).toContain('[speaker:111:keep]');
    expect(out).not.toContain('222');
    expect(out).not.toContain('333');
  });

  it('returns empty string when every slot is empty (so assembler drops the whole memory_context wrapper)', () => {
    expect(formatMemoryMarkdown({})).toBe('');
    expect(formatMemoryMarkdown({ groupMemoryText: '', userSections: [] })).toBe('');
    expect(
      formatMemoryMarkdown({
        groupMemoryText: '   ',
        userSections: [{ uid: '1', memoryText: '' }],
      }),
    ).toBe('');
  });

  it('strips structural chars [ ] : < > from the nick', () => {
    expect(buildSpeakerTag('42', 'a[b]c:d<e>f')).toBe('[speaker:42:abcdef]');
    expect(buildSpeakerTag('42', '[[nested]]')).toBe('[speaker:42:nested]');
  });

  it('preserves the trailing colon for an empty / stripped-to-empty nick (matches serializeEntry arity)', () => {
    expect(buildSpeakerTag('42')).toBe('[speaker:42:]');
    expect(buildSpeakerTag('42', '')).toBe('[speaker:42:]');
    expect(buildSpeakerTag('42', ':::')).toBe('[speaker:42:]');
  });

  it('keeps arbitrary unicode (incl. emoji) in the nick — only structural chars are dropped', () => {
    expect(buildSpeakerTag('42', '米哈游-小麦🎮')).toBe('[speaker:42:米哈游-小麦🎮]');
  });
});
