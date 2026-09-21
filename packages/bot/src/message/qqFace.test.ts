import { describe, expect, it } from 'bun:test';
import {
  expandFaceMarkers,
  FACE_VOCABULARY,
  faceIdByName,
  formatFaceVocabulary,
  reactionLabel,
  renderFaceToken,
  resolveReactionId,
  stripFaceMarkers,
} from './qqFace';

describe('renderFaceToken', () => {
  it('renders a known id as its name', () => {
    expect(renderFaceToken('182')).toBe('[表情:笑哭]');
    expect(renderFaceToken(267)).toBe('[表情:头秃]');
  });

  it('renders an id the table does not cover as a #id escape', () => {
    expect(renderFaceToken('489')).toBe('[表情:#489]');
  });

  it('round-trips through the marker expander', () => {
    const { segments } = expandFaceMarkers(renderFaceToken('489'));
    expect(segments).toEqual([{ type: 'face', data: { id: '489' } }]);
  });
});

describe('faceIdByName', () => {
  it('prefers the current-client face when a name is bound twice', () => {
    // 450-457 are 3D reissues of the classic faces and reuse their names.
    expect(faceIdByName('微笑')).toBe('14');
    expect(faceIdByName('发呆')).toBe('3');
    // 340 is retired and only survives in the legacy table; 482 is what clients ship.
    expect(faceIdByName('热化了')).toBe('482');
  });

  it('resolves legacy-only faces that the current table dropped', () => {
    expect(faceIdByName('磕头')).toBe('126');
  });

  it('returns undefined for a name the model invented', () => {
    expect(faceIdByName('开心到起飞')).toBeUndefined();
  });
});

describe('resolveReactionId', () => {
  it('accepts a face name', () => {
    expect(resolveReactionId('笑哭')).toBe('182');
  });

  it('accepts a literal emoji character and returns its codepoint', () => {
    expect(resolveReactionId('👍')).toBe('128077');
  });

  it('passes a bare numeric id through unchanged', () => {
    expect(resolveReactionId('10068')).toBe('10068');
  });

  it('rejects empty and unknown input', () => {
    expect(resolveReactionId('   ')).toBeUndefined();
    expect(resolveReactionId('不存在的表情')).toBeUndefined();
  });
});

describe('reactionLabel', () => {
  it('labels both id families', () => {
    expect(reactionLabel('182')).toBe('笑哭');
    expect(reactionLabel('128077')).toBe('👍');
  });

  it('falls back to the raw id when nothing matches', () => {
    expect(reactionLabel('999999')).toBe('999999');
  });
});

describe('expandFaceMarkers', () => {
  it('leaves text without markers as a single segment', () => {
    const { segments, unresolved } = expandFaceMarkers('今天天气不错');
    expect(segments).toEqual([{ type: 'text', data: { text: '今天天气不错' } }]);
    expect(unresolved).toEqual([]);
  });

  it('splits text around a marker', () => {
    const { segments } = expandFaceMarkers('确实[表情:笑哭]太离谱了');
    expect(segments).toEqual([
      { type: 'text', data: { text: '确实' } },
      { type: 'face', data: { id: '182' } },
      { type: 'text', data: { text: '太离谱了' } },
    ]);
  });

  it('keeps adjacent markers as separate face segments', () => {
    const { segments } = expandFaceMarkers('[表情:笑哭][表情:头秃]');
    expect(segments).toEqual([
      { type: 'face', data: { id: '182' } },
      { type: 'face', data: { id: '267' } },
    ]);
  });

  it('drops an unresolvable marker and reports the name', () => {
    const { segments, unresolved } = expandFaceMarkers('好耶[表情:开心到起飞]啊');
    expect(segments).toEqual([{ type: 'text', data: { text: '好耶啊' } }]);
    expect(unresolved).toEqual(['开心到起飞']);
  });

  it('does not let an unclosed bracket swallow the rest of the reply', () => {
    const text = '[表情:这是一段很长的没有闭合的内容继续写下去';
    expect(expandFaceMarkers(text).segments).toEqual([{ type: 'text', data: { text } }]);
  });

  it('is reusable across calls despite the shared global regex', () => {
    const first = expandFaceMarkers('[表情:笑哭]a');
    const second = expandFaceMarkers('[表情:笑哭]a');
    expect(second.segments).toEqual(first.segments);
  });
});

describe('stripFaceMarkers', () => {
  it('removes markers bound for a surface that cannot render them', () => {
    expect(stripFaceMarkers('# 标题[表情:笑哭]\n正文')).toBe('# 标题\n正文');
  });
});

describe('FACE_VOCABULARY', () => {
  it('lists every name exactly once', () => {
    expect(new Set(FACE_VOCABULARY).size).toBe(FACE_VOCABULARY.length);
  });

  it('offers only names the model can actually send', () => {
    for (const name of FACE_VOCABULARY) {
      expect(faceIdByName(name)).toBeDefined();
    }
  });

  it('covers the faces this deployment sees most', () => {
    for (const name of ['斜眼笑', '头秃', '大怨种', '汪汪', '笑哭', '偷感', '不是吧']) {
      expect(FACE_VOCABULARY).toContain(name);
    }
  });

  it('renders as a name list the prompt can inject', () => {
    expect(formatFaceVocabulary(["笑哭", "头秃"])).toBe("笑哭、头秃");
  });
});
