// Tests for normalizeSessionForConfig — the prefixed-vs-bare session id mismatch.
//
// Regression guard: pipeline code holds the canonical prefixed id ("user:1") while
// ConversationConfigService is keyed on the bare id written by `/`-commands ("1").
// Reading config with the prefixed id silently returns the default, which surfaces as
// "the toggle had no effect" rather than as an error.

import { describe, expect, it } from 'bun:test';
import { normalizeSessionForConfig } from './SessionUtils';

describe('normalizeSessionForConfig', () => {
  it('strips the group: prefix and derives the type from it', () => {
    expect(normalizeSessionForConfig('group:1001', 'group')).toEqual({
      sessionId: '1001',
      sessionType: 'group',
    });
  });

  it('strips the user: prefix and derives the type from it', () => {
    expect(normalizeSessionForConfig('user:2002', 'user')).toEqual({
      sessionId: '2002',
      sessionType: 'user',
    });
  });

  it('trusts the prefix over a mismatched sessionType argument', () => {
    expect(normalizeSessionForConfig('group:1001', 'user')).toEqual({
      sessionId: '1001',
      sessionType: 'group',
    });
  });

  it('passes an already-bare id through with the supplied type', () => {
    expect(normalizeSessionForConfig('2002', 'user')).toEqual({
      sessionId: '2002',
      sessionType: 'user',
    });
  });

  it('is idempotent — normalizing twice is a no-op', () => {
    const once = normalizeSessionForConfig('group:1001', 'group');
    expect(normalizeSessionForConfig(once.sessionId, once.sessionType)).toEqual(once);
  });
});
