import { describe, expect, it } from 'bun:test';
import { GROUP_MEMORY_USER_ID } from '../constants';
import { coreScopeOf, isAllowedScope } from '../scopes';

describe('coreScopeOf', () => {
  it('drops the subtag', () => {
    expect(coreScopeOf('preference:food')).toBe('preference');
    expect(coreScopeOf('identity')).toBe('identity');
  });
});

describe('isAllowedScope', () => {
  it('allows group cores in group memory and member cores in member memory', () => {
    expect(isAllowedScope(GROUP_MEMORY_USER_ID, 'rule:bot')).toBe(true);
    expect(isAllowedScope(GROUP_MEMORY_USER_ID, 'identity')).toBe(false);
    expect(isAllowedScope('10000001', 'instruction')).toBe(true);
    expect(isAllowedScope('10000001', 'rule')).toBe(false);
  });

  it('rejects malformed scopes', () => {
    expect(isAllowedScope('10000001', 'preference:Food Taste')).toBe(false);
    expect(isAllowedScope('10000001', '')).toBe(false);
  });
});
