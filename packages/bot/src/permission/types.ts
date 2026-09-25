export type PermissionLevel = 'user' | 'group_admin' | 'group_owner' | 'admin' | 'owner';

/**
 * The single authority on who the bot owner and admins are. Every identity check goes
 * through it so protocol-specific overrides (the same person has a different user id on
 * each platform) apply everywhere, not only in the command system.
 */
export interface PermissionChecker {
  checkPermission(
    userId: number | string,
    messageType: 'private' | 'group',
    requiredPermissions: PermissionLevel[],
    userRole?: string,
    protocol?: string,
  ): boolean;
  isOwner(userId: number | string, protocol?: string): boolean;
  /** True for admins and for the owner. */
  isAdmin(userId: number | string, protocol?: string): boolean;
  /** The owner's user id on `protocol`, falling back to the global owner. */
  getOwnerId(protocol?: string): string;
}
