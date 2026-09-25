import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { Config } from '@/core/config';
import { DefaultPermissionChecker } from '../DefaultPermissionChecker';

function createChecker(): DefaultPermissionChecker {
  const config = {
    getConfig: () => ({
      bot: { owner: '10000001', admins: ['10000002'] },
      protocols: [
        { name: 'milky' },
        { name: 'discord', owner: '90000001', admins: ['90000002'] },
      ],
    }),
  } as unknown as Config;
  return new DefaultPermissionChecker(config);
}

describe('DefaultPermissionChecker', () => {
  it('uses the global owner and admins on a protocol without overrides', () => {
    const checker = createChecker();
    expect(checker.isOwner('10000001', 'milky')).toBe(true);
    expect(checker.isAdmin(10000002, 'milky')).toBe(true);
    expect(checker.isAdmin('10000001', 'milky')).toBe(true);
    expect(checker.isAdmin('10000003', 'milky')).toBe(false);
    expect(checker.getOwnerId('milky')).toBe('10000001');
  });

  it('applies a protocol override instead of the global ids', () => {
    const checker = createChecker();
    expect(checker.getOwnerId('discord')).toBe('90000001');
    expect(checker.isOwner('90000001', 'discord')).toBe(true);
    expect(checker.isOwner('10000001', 'discord')).toBe(false);
    expect(checker.isAdmin('90000002', 'discord')).toBe(true);
    expect(checker.isAdmin('10000002', 'discord')).toBe(false);
  });

  it('falls back to the global owner when no protocol is given', () => {
    const checker = createChecker();
    expect(checker.getOwnerId()).toBe('10000001');
    expect(checker.checkPermission('10000001', 'private', ['owner'])).toBe(true);
  });

  it('grants admin-level commands to the owner and to admins only', () => {
    const checker = createChecker();
    expect(checker.checkPermission('90000001', 'group', ['admin'], undefined, 'discord')).toBe(true);
    expect(checker.checkPermission('10000003', 'group', ['admin'], undefined, 'milky')).toBe(false);
    expect(checker.checkPermission('10000003', 'group', ['group_admin'], 'admin', 'milky')).toBe(true);
    expect(checker.checkPermission('10000003', 'group', [])).toBe(true);
  });
});
