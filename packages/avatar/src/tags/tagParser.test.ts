import { describe, expect, it } from 'bun:test';
import { parseLive2DTags, parseRichTags, stripLive2DTags } from './tagParser';

describe('parseRichTags', () => {
  it('parses [A:wave@0.8]', () => {
    expect(parseRichTags('hello [A:wave@0.8] world')).toEqual([
      { kind: 'action', action: 'wave', emotion: 'neutral', intensity: 0.8 },
    ]);
  });

  it('[A:nod] defaults intensity to 1.0', () => {
    expect(parseRichTags('[A:nod]')).toEqual([{ kind: 'action', action: 'nod', emotion: 'neutral', intensity: 1.0 }]);
  });

  it('parses four tags in order: E, G(named), H, A', () => {
    const result = parseRichTags('[E:happy@0.6] text [G:camera] [H:short][A:nod]');
    expect(result).toEqual([
      { kind: 'emotion', emotion: 'happy', intensity: 0.6 },
      { kind: 'gaze', target: { type: 'named', name: 'camera' } },
      { kind: 'hold', dur: 'short' },
      { kind: 'action', action: 'nod', emotion: 'neutral', intensity: 1.0 },
    ]);
  });

  it('parses [G:0.3,-0.2] as point gaze', () => {
    expect(parseRichTags('[G:0.3,-0.2]')).toEqual([{ kind: 'gaze', target: { type: 'point', x: 0.3, y: -0.2 } }]);
  });

  it('parses [G:clear]', () => {
    expect(parseRichTags('[G:clear]')).toEqual([{ kind: 'gaze', target: { type: 'clear' } }]);
  });

  it('[G:diagonal] → []', () => {
    expect(parseRichTags('[G:diagonal]')).toEqual([]);
  });

  it('[A:] (empty payload) → []', () => {
    expect(parseRichTags('[A:]')).toEqual([]);
  });

  it('[B:foo] (unknown letter) → []', () => {
    expect(parseRichTags('[B:foo]')).toEqual([]);
  });

  it('legacy tag produces action + emotion derivation', () => {
    const result = parseRichTags('[LIVE2D: action=wave, emotion=happy, intensity=0.8]');
    expect(result).toEqual([
      { kind: 'action', action: 'wave', emotion: 'happy', intensity: 0.8 },
      { kind: 'emotion', emotion: 'happy', intensity: 0.6 },
    ]);
  });

  it('legacy tag with neutral emotion produces only action, no derived emotion', () => {
    const result = parseRichTags('[LIVE2D: action=nod, emotion=neutral]');
    expect(result).toEqual([{ kind: 'action', action: 'nod', emotion: 'neutral', intensity: 0.5 }]);
  });

  it('mixed: [A:nod] then legacy tag', () => {
    const result = parseRichTags('[A:nod] then [LIVE2D: action=wave, emotion=happy]');
    expect(result).toEqual([
      { kind: 'action', action: 'nod', emotion: 'neutral', intensity: 1.0 },
      { kind: 'action', action: 'wave', emotion: 'happy', intensity: 0.5 },
      { kind: 'emotion', emotion: 'happy', intensity: 0.6 },
    ]);
  });
});

describe('[K:] head-look tags', () => {
  it('[K: left] → headLook yaw=-15', () => {
    expect(parseRichTags('[K: left]')).toEqual([{ kind: 'headLook', target: { yaw: -15, pitch: 0 } }]);
  });

  it('[K: right] → headLook yaw=15', () => {
    expect(parseRichTags('[K: right]')).toEqual([{ kind: 'headLook', target: { yaw: 15, pitch: 0 } }]);
  });

  it('[K: up] → headLook pitch=-10', () => {
    expect(parseRichTags('[K: up]')).toEqual([{ kind: 'headLook', target: { yaw: 0, pitch: -10 } }]);
  });

  it('[K: down] → headLook pitch=10', () => {
    expect(parseRichTags('[K: down]')).toEqual([{ kind: 'headLook', target: { yaw: 0, pitch: 10 } }]);
  });

  it('[K: clear] → headLook target=null', () => {
    expect(parseRichTags('[K: clear]')).toEqual([{ kind: 'headLook', target: null }]);
  });

  it('[K: -20,5] → headLook numeric pair', () => {
    expect(parseRichTags('[K: -20,5]')).toEqual([{ kind: 'headLook', target: { yaw: -20, pitch: 5 } }]);
  });

  it('[K: bogus] → graceful skip (no headLook entry)', () => {
    expect(parseRichTags('[K: bogus]')).toEqual([]);
  });
});

describe('parseLive2DTags (shim)', () => {
  it('regression: returns exactly one legacy-shaped object', () => {
    const result = parseLive2DTags('[LIVE2D: action=wave, emotion=happy, intensity=0.8]');
    expect(result).toEqual([{ action: 'wave', emotion: 'happy', intensity: 0.8 }]);
    expect(result).toHaveLength(1);
  });
});

describe('stripLive2DTags', () => {
  it('strips valid rich tag and legacy tag, normalizes spaces', () => {
    expect(stripLive2DTags('hello [A:wave] world [LIVE2D: action=nod] end')).toBe('hello world end');
  });

  it('leaves invalid shapes [A:] and [B:foo] intact, strips valid legacy', () => {
    const result = stripLive2DTags('[A:] text [B:foo] [LIVE2D: action=nod]');
    expect(result).toContain('[A:]');
    expect(result).toContain('[B:foo]');
    expect(result).not.toContain('[LIVE2D:');
  });

  it('leaves Chinese brackets 【A:test】 unchanged', () => {
    expect(stripLive2DTags('【A:test】')).toBe('【A:test】');
  });
});
