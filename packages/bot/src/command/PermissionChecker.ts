// Permission checker for command access control

import { logger } from '@/utils/logger';
import type { PermissionChecker as IPermissionChecker } from './CommandManager';
import type { PermissionLevel } from './types';

export interface PermissionConfig {
  // Bot owner: highest permission level (global default)
  owner: string;
  // Bot admins: user IDs that have admin permission level (global default)
  admins: string[];
  // Per-protocol overrides: protocol name -> { owner?, admins? }
  protocolOverrides?: Record<string, { owner?: string; admins?: string[] }>;
}

/**
 * Permission checker implementation
 *
 * Supports per-protocol owner/admin overrides for multi-protocol setups
 * where the same person has different user IDs on different platforms.
 */
export class DefaultPermissionChecker implements IPermissionChecker {
  private globalOwnerId: string;
  private globalAdminIds: Set<string>;
  // protocol -> owner ID
  private protocolOwnerIds = new Map<string, string>();
  // protocol -> admin IDs
  private protocolAdminIds = new Map<string, Set<string>>();

  constructor(config: PermissionConfig) {
    this.globalOwnerId = config.owner;
    this.globalAdminIds = new Set(config.admins ?? []);

    if (config.protocolOverrides) {
      for (const [protocol, override] of Object.entries(config.protocolOverrides)) {
        if (override.owner) {
          this.protocolOwnerIds.set(protocol, override.owner);
        }
        if (override.admins && override.admins.length > 0) {
          this.protocolAdminIds.set(protocol, new Set(override.admins));
        }
      }
    }
  }

  /**
   * Check if user has required permissions
   */
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
        return this.isAdmin(userId.toString(), protocol) || this.isOwner(userId.toString(), protocol);
      }
      case 'owner': {
        // Bot owner only
        return this.isOwner(userId.toString(), protocol);
      }
      default:
        logger.warn(`[PermissionChecker] Unknown permission level: ${permission}`);
        return false;
    }
  }

  /**
   * Check if userId is an owner, considering protocol-specific override first
   */
  private isOwner(userId: string, protocol?: string): boolean {
    if (protocol) {
      const protocolOwner = this.protocolOwnerIds.get(protocol);
      if (protocolOwner !== undefined) {
        return userId === protocolOwner;
      }
    }
    return userId === this.globalOwnerId;
  }

  /**
   * Check if userId is an admin, considering protocol-specific override first
   */
  private isAdmin(userId: string, protocol?: string): boolean {
    if (protocol) {
      const protocolAdmins = this.protocolAdminIds.get(protocol);
      if (protocolAdmins !== undefined) {
        return protocolAdmins.has(userId);
      }
    }
    return this.globalAdminIds.has(userId);
  }

  /**
   * Set global owner ID
   */
  setOwner(ownerId: string): void {
    this.globalOwnerId = ownerId;
  }

  /**
   * Add global admin ID
   */
  addAdmin(adminId: string): void {
    this.globalAdminIds.add(adminId);
  }

  /**
   * Remove global admin ID
   */
  removeAdmin(adminId: string): void {
    this.globalAdminIds.delete(adminId);
  }
}
