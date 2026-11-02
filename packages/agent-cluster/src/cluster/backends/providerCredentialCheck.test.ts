import { describe, expect, test } from 'bun:test';
import { interpretClaudeAuthStatus, interpretCodexLoginStatus } from './providerCredentialCheck';

describe('interpretClaudeAuthStatus', () => {
  test('a logged-in subscription is usable and does not leak the account email', () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'team',
      email: 'person@example.com',
    });
    const result = interpretClaudeAuthStatus(stdout, 0);
    expect(result.ok).toBe(true);
    expect(result.credentialSource).toBe('claude auth status: claude.ai, team');
    expect(JSON.stringify(result)).not.toContain('person@example.com');
  });

  test('loggedIn true without a subscription still passes', () => {
    const result = interpretClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }), 0);
    expect(result.ok).toBe(true);
    expect(result.credentialSource).toBe('claude auth status: api_key');
  });

  test('logged out is a login failure, not an expired credential file', () => {
    const stdout = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    const result = interpretClaudeAuthStatus(stdout, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('claude auth login');
    expect(result.reason).not.toContain('expired');
  });

  test('JSON preceded by a banner still parses', () => {
    const stdout = `claude ready\n${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })}`;
    const result = interpretClaudeAuthStatus(stdout, 0);
    expect(result.ok).toBe(true);
  });

  test('unparseable output fails closed without echoing the body', () => {
    const result = interpretClaudeAuthStatus('not-json access-token=secret', 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claude auth status failed (exit 1)');
    expect(result.reason).not.toContain('secret');
  });
});

describe('interpretCodexLoginStatus', () => {
  test('a ChatGPT login is usable', () => {
    const result = interpretCodexLoginStatus('Logged in using ChatGPT\n', 0);
    expect(result.ok).toBe(true);
    expect(result.credentialSource).toBe('codex login status: ChatGPT');
  });

  test('an API-key login is rejected without echoing the masked key', () => {
    const result = interpretCodexLoginStatus('Logged in using an API key - sk-proj-***abcd\n', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('codex logout');
    expect(JSON.stringify(result)).not.toContain('abcd');
  });

  test('logged out points at codex login', () => {
    const result = interpretCodexLoginStatus('Not logged in\n', 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('codex login');
  });

  test('unrecognised output fails closed', () => {
    const result = interpretCodexLoginStatus('Error loading configuration', 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('codex login status failed (exit 1)');
  });
});
