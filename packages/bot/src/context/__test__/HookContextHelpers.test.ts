import { describe, expect, it } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { hasWhitelistCapability, isNoReplyPath } from '../HookContextHelpers';

function makeContext(metadataOverrides: {
  postProcessOnly?: boolean;
  whitelistDenied?: boolean;
  whitelistGroupCapabilities?: string[];
}): HookContext {
  const metadata = new HookMetadataMap();
  if (metadataOverrides.postProcessOnly !== undefined) {
    metadata.set('postProcessOnly', metadataOverrides.postProcessOnly);
  }
  if (metadataOverrides.whitelistDenied !== undefined) {
    metadata.set('whitelistDenied', metadataOverrides.whitelistDenied);
  }
  if (metadataOverrides.whitelistGroupCapabilities !== undefined) {
    metadata.set('whitelistGroupCapabilities', metadataOverrides.whitelistGroupCapabilities);
  }
  return {
    message: {} as HookContext['message'],
    context: {} as HookContext['context'],
    metadata,
    source: 'qq-private' as const,
  };
}

describe('isNoReplyPath', () => {
  it('returns true when whitelistDenied is true', () => {
    expect(isNoReplyPath(makeContext({ whitelistDenied: true }))).toBe(true);
  });

  it('returns true when postProcessOnly is true', () => {
    expect(isNoReplyPath(makeContext({ postProcessOnly: true }))).toBe(true);
  });

  it('returns true when both postProcessOnly and whitelistDenied are true', () => {
    expect(isNoReplyPath(makeContext({ postProcessOnly: true, whitelistDenied: true }))).toBe(true);
  });

  it('returns false when neither flag is set', () => {
    expect(isNoReplyPath(makeContext({}))).toBe(false);
  });

  it('returns false when both flags are explicitly false', () => {
    expect(isNoReplyPath(makeContext({ postProcessOnly: false, whitelistDenied: false }))).toBe(false);
  });
});

describe('hasWhitelistCapability', () => {
  it('returns false when whitelistDenied is true', () => {
    expect(hasWhitelistCapability(makeContext({ whitelistDenied: true }), 'reply')).toBe(false);
  });

  it('returns true when whitelistGroupCapabilities is unset (full access)', () => {
    expect(hasWhitelistCapability(makeContext({}), 'reply')).toBe(true);
  });

  it('returns true when whitelistGroupCapabilities is empty array (full access)', () => {
    expect(hasWhitelistCapability(makeContext({ whitelistGroupCapabilities: [] }), 'reply')).toBe(true);
  });

  it('returns true when capability is in whitelistGroupCapabilities', () => {
    expect(hasWhitelistCapability(makeContext({ whitelistGroupCapabilities: ['command', 'reply'] }), 'reply')).toBe(
      true,
    );
  });

  it('returns false when capability is not in whitelistGroupCapabilities', () => {
    expect(hasWhitelistCapability(makeContext({ whitelistGroupCapabilities: ['command'] }), 'reply')).toBe(false);
  });
});
