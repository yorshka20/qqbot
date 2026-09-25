import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { PermissionChecker, PermissionLevel } from './types';

/**
 * Owner and admins come from `bot.owner` / `bot.admins`; a protocol entry's own
 * `owner` / `admins` override them on that protocol.
 */
@singleton()
export class DefaultPermissionChecker implements PermissionChecker {
  private readonly globalOwnerId: string;
  private readonly globalAdminIds: Set<string>;
  private readonly protocolOwnerIds = new Map<string, string>();
  private readonly protocolAdminIds = new Map<string, Set<string>>();

  constructor(@inject(DITokens.CONFIG) config: Config) {
    const botConfig = config.getConfig();
    this.globalOwnerId = botConfig.bot.owner;
    this.globalAdminIds = new Set(botConfig.bot.admins);

    for (const protocol of botConfig.protocols) {
      if (protocol.owner) {
        this.protocolOwnerIds.set(protocol.name, protocol.owner);
      }
      if (protocol.admins && protocol.admins.length > 0) {
        this.protocolAdminIds.set(protocol.name, new Set(protocol.admins));
      }
    }
  }

  checkPermission(
    userId: number | string,
    messageType: 'private' | 'group',
    requiredPermissions: PermissionLevel[],
    userRole?: string,
    protocol?: string,
  ): boolean {
    // If no permissions required, allow all
    if (requiredPermissions.length === 0) {
      return true;
    }

    // Check each required permission
    for (const permission of requiredPermissions) {
      if (this.hasPermission(userId, messageType, userRole, permission, protocol)) {
        return true;
      }
    }

    return false;
  }

  isOwner(userId: number | string, protocol?: string): boolean {
    return userId.toString() === this.getOwnerId(protocol);
  }

  isAdmin(userId: number | string, protocol?: string): boolean {
    if (this.isOwner(userId, protocol)) {
      return true;
    }
    const admins = (protocol && this.protocolAdminIds.get(protocol)) || this.globalAdminIds;
    return admins.has(userId.toString());
  }

  getOwnerId(protocol?: string): string {
    return (protocol && this.protocolOwnerIds.get(protocol)) || this.globalOwnerId;
  }

  /**
   * Check if user has a specific permission
   *
   * Permission levels:
   * - 'user': All users have this permission
   * - 'group_admin': Only group administrators (from QQ protocol data)
   * - 'group_owner': Only group owners (from QQ protocol data)
   * - 'admin': Bot administrators (configured user IDs)
   * - 'owner': Bot owner only (configured user ID)
   */
  private hasPermission(
    userId: number | string,
    messageType: 'private' | 'group',
    userRole: string | undefined,
    permission: PermissionLevel,
    protocol?: string,
  ): boolean {
    switch (permission) {
      case 'user': {
        // All users have this permission
        return true;
      }
      case 'group_admin': {
        // Only group administrators - check role from QQ protocol data
        // Must be a group message and have a role
        if (messageType !== 'group' || !userRole) {
          return false;
        }
        // Check common admin role values from different QQ protocols
        // Different protocols may return: 'admin', 'administrator', 'moderator', etc.
        const normalizedRole = userRole.toLowerCase();
        return normalizedRole === 'admin' || normalizedRole === 'administrator' || normalizedRole === 'moderator';
      }
      case 'group_owner': {
        // Only group owners - check role from QQ protocol data
        // Must be a group message and have a role
        if (messageType !== 'group' || !userRole) {
          return false;
        }
        // Check common owner role values from different QQ protocols
        // Different protocols may return: 'owner', 'master', etc.
        const normalizedOwnerRole = userRole.toLowerCase();
        return normalizedOwnerRole === 'owner' || normalizedOwnerRole === 'master';
      }
      case 'admin': {
        // Bot administrators: check by user ID only
        // User must be in admins list or be the owner
        return this.isAdmin(userId, protocol);
      }
      case 'owner': {
        // Bot owner only
        return this.isOwner(userId, protocol);
      }
      default:
        logger.warn(`[PermissionChecker] Unknown permission level: ${permission}`);
        return false;
    }
  }
}
