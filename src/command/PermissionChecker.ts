// Permission checker for command access control

import { logger } from '@/utils/logger';
import type { PermissionChecker as IPermissionChecker } from './CommandManager';
import type { PermissionLevel } from './types';

// Re-export PermissionChecker interface for convenience
export type { PermissionChecker } from './CommandManager';

export interface PermissionConfig {
  owner?: number; // Bot owner user ID
  admins?: number[]; // Bot admin user IDs
}

/**
 * Permission checker implementation
 */
export class DefaultPermissionChecker implements IPermissionChecker {
  private ownerId: number | null = null;
  private adminIds: Set<number> = new Set();

  constructor(config?: PermissionConfig) {
    if (config) {
      this.ownerId = config.owner || null;
      if (config.admins) {
        this.adminIds = new Set(config.admins);
      }
    }
  }

  /**
   * Check if user has required permissions
   */
  checkPermission(
    userId: number,
    groupId: number | undefined,
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
      if (
        this.hasPermission(userId, groupId, messageType, userRole, permission)
      ) {
        return true; // User has at least one required permission
      }
    }

    return false; // User doesn't have any required permission
  }

  /**
   * Check if user has a specific permission
   */
  private hasPermission(
    userId: number,
    groupId: number | undefined,
    messageType: 'private' | 'group',
    userRole: string | undefined,
    permission: PermissionLevel,
  ): boolean {
    switch (permission) {
      case 'user':
        // All users have this permission
        return true;

      case 'group_admin':
        // Only group administrators
        if (messageType !== 'group') {
          return false;
        }
        return userRole === 'admin' || userRole === 'administrator';

      case 'group_owner':
        // Only group owners
        if (messageType !== 'group') {
          return false;
        }
        return userRole === 'owner';

      case 'admin':
        // Bot administrators
        return this.adminIds.has(userId) || userId === this.ownerId;

      case 'owner':
        // Bot owner only
        return userId === this.ownerId;

      default:
        logger.warn(
          `[PermissionChecker] Unknown permission level: ${permission}`,
        );
        return false;
    }
  }

  /**
   * Set owner ID
   */
  setOwner(ownerId: number): void {
    this.ownerId = ownerId;
  }

  /**
   * Add admin ID
   */
  addAdmin(adminId: number): void {
    this.adminIds.add(adminId);
  }

  /**
   * Remove admin ID
   */
  removeAdmin(adminId: number): void {
    this.adminIds.delete(adminId);
  }
}
