// A call does not size its own output budget: reasoning is charged against the same cap, so a
// budget sized for the answer truncates it. Unset means the provider's ceiling.

import { describe, expect, it } from 'bun:test';
import { clampMaxTokens, PREMIUM_MAX_TOKENS_CEILING } from '../maxTokens';

describe('clampMaxTokens', () => {
  it('gives an unset budget the default ceiling', () => {
    expect(clampMaxTokens(undefined)).toBe(50_000);
  });

  it("gives an unset budget a premium provider's ceiling", () => {
    expect(clampMaxTokens(undefined, PREMIUM_MAX_TOKENS_CEILING)).toBe(PREMIUM_MAX_TOKENS_CEILING);
  });

  it('keeps an explicit budget below the ceiling and cuts one above it', () => {
    expect(clampMaxTokens(1_000)).toBe(1_000);
    expect(clampMaxTokens(900_000)).toBe(50_000);
    expect(clampMaxTokens(900_000, PREMIUM_MAX_TOKENS_CEILING)).toBe(PREMIUM_MAX_TOKENS_CEILING);
  });
});
