// Permission checker for command access control

import { logger } from '@/utils/logger';
import type { PermissionChecker as IPermissionChecker } from './CommandManager';
import type { PermissionLevel } from './types';

export interface PermissionConfig {
  // Bot owner: highest permission level
  owner: string;
  // Bot admins: user IDs that have admin permission level
  admins: string[];
}

/**
 * Permission checker implementation
 */
export class DefaultPermissionChecker implements IPermissionChecker {
  private ownerId: string;
  private adminIds: Set<string> = new Set();

  constructor(config: PermissionConfig) {
    this.ownerId = config.owner;
    if (config.admins) {
      this.adminIds = new Set(config.admins);
    }
  }

  /**
   * Check if user has required permissions
   */
  checkPermission(
    userId: number,
    messageType: 'private' | 'group',
    requiredPermissions: PermissionLevel[],
    userRole?: string,
  ): boolean {
    // If no permissions required, allow all
    if (requiredPermissions.length === 0) {
      return true;
    }

    // Check each required permission
    for (const permission of requiredPermissions) {
      if (this.hasPermission(userId, messageType, userRole, permission)) {
        return true;
      }
    }

    return false;
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
    userId: number,
    messageType: 'private' | 'group',
    userRole: string | undefined,
    permission: PermissionLevel,
  ): boolean {
    switch (permission) {
      case 'user':
        // All users have this permission
        return true;

      case 'group_admin':
        // Only group administrators - check role from QQ protocol data
        // Must be a group message and have a role
        if (messageType !== 'group' || !userRole) {
          return false;
        }
        // Check common admin role values from different QQ protocols
        // Different protocols may return: 'admin', 'administrator', 'moderator', etc.
        const normalizedRole = userRole.toLowerCase();
        return normalizedRole === 'admin' || normalizedRole === 'administrator' || normalizedRole === 'moderator';

      case 'group_owner':
        // Only group owners - check role from QQ protocol data
        // Must be a group message and have a role
        if (messageType !== 'group' || !userRole) {
          return false;
        }
        // Check common owner role values from different QQ protocols
        // Different protocols may return: 'owner', 'master', etc.
        const normalizedOwnerRole = userRole.toLowerCase();
        return normalizedOwnerRole === 'owner' || normalizedOwnerRole === 'master';

      case 'admin':
        // Bot administrators: check by user ID only
        // User must be in admins list or be the owner
        return this.adminIds.has(userId.toString()) || userId.toString() === this.ownerId;

      case 'owner':
        // Bot owner only
        return userId.toString() === this.ownerId;

      default:
        logger.warn(`[PermissionChecker] Unknown permission level: ${permission}`);
        return false;
    }
  }

  /**
   * Set owner ID
   */
  setOwner(ownerId: string): void {
    this.ownerId = ownerId;
  }

  /**
   * Add admin ID
   */
  addAdmin(adminId: string): void {
    this.adminIds.add(adminId);
  }

  /**
   * Remove admin ID
   */
  removeAdmin(adminId: string): void {
    this.adminIds.delete(adminId);
  }
}
