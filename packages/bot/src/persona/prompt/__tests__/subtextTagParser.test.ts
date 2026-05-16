import { describe, expect, it } from 'bun:test';
import { parseSubtextTags } from '../subtextTagParser';

describe('parseSubtextTags', () => {
  it('case 1: both tags present', () => {
    const result = parseSubtextTags('reply [SUBTEXT: secret] [META: a, b]');
    expect(result.visible).not.toContain('secret');
    expect(result.visible).not.toContain('[SUBTEXT:');
    expect(result.visible).not.toContain('[META:');
    expect(result.subtext).toBe('secret');
    expect(result.replyTags).toEqual(['a', 'b']);
  });

  it('case 2: only SUBTEXT', () => {
    const result = parseSubtextTags('reply [SUBTEXT: s]');
    expect(result.subtext).toBe('s');
    expect(result).not.toHaveProperty('replyTags');
  });

  it('case 3: only META', () => {
    const result = parseSubtextTags('reply [META: a, b]');
    expect(result).not.toHaveProperty('subtext');
    expect(result.replyTags).toEqual(['a', 'b']);
  });

  it('case 4: empty META content → no replyTags', () => {
    const result = parseSubtextTags('r [META: ]');
    expect(result).not.toHaveProperty('replyTags');
  });

  it('case 5: all-empty META items → no replyTags', () => {
    const result = parseSubtextTags('r [META: , , ]');
    expect(result).not.toHaveProperty('replyTags');
  });

  it('case 6: no tags → visible is unchanged, no extra fields', () => {
    const result = parseSubtextTags('plain reply');
    expect(result.visible).toBe('plain reply');
    expect(result).not.toHaveProperty('subtext');
    expect(result).not.toHaveProperty('replyTags');
  });

  it('case 7: trailing whitespace trimmed', () => {
    const result = parseSubtextTags('hi [SUBTEXT: s]   ');
    expect(result.visible).toBe('hi');
  });

  it('case 8: kebab tags preserved', () => {
    const result = parseSubtextTags('r [META: deflecting, probing, affection-test]');
    expect(result.replyTags).toEqual(['deflecting', 'probing', 'affection-test']);
  });
});
