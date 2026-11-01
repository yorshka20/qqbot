// `/api/memory` — reading and correcting memory. Fact counts repeat at every level
// (global, group, slot) so a page can show totals without walking the facts.

export type MemoryFactStatus = 'active' | 'superseded' | 'retired';
export type MemoryFactDurability = 'stable' | 'transient';

export interface MemoryFactCounts {
  activeFacts: number;
  supersededFacts: number;
  retiredFacts: number;
}

export interface MemoryGlobalStats extends MemoryFactCounts {
  manualSlots: number;
}

export interface MemoryGroupStats extends MemoryFactCounts {
  groupId: string;
  groupName?: string;
  slotCount: number;
  manualSlots: number;
}

export interface MemorySlotSummary extends MemoryFactCounts {
  userId: string;
  nickname?: string;
  isGroupMemory: boolean;
  hasManualText: boolean;
}

export interface MemoryFactEntry {
  id: string;
  scope: string;
  content: string;
  durability: MemoryFactDurability;
  status: MemoryFactStatus;
  statusReason?: string;
  supersededBy?: string;
  firstSeen: number;
  lastConfirmedAt: number;
  confirmCount: number;
  hitCount: number;
  lastHitAt?: number;
  reviewedAt?: number;
}

/** `GET /api/memory/stats` */
export interface MemoryStatsResponse {
  stats: MemoryGlobalStats;
}

/** `GET /api/memory/groups` */
export interface MemoryGroupsResponse {
  groups: MemoryGroupStats[];
}

/** `GET /api/memory/group/:groupId` */
export interface MemoryGroupDetail {
  groupId: string;
  groupName?: string;
  slots: MemorySlotSummary[];
}

/** `GET /api/memory/group/:groupId/user/:userId` */
export interface MemorySlotDetail {
  groupId: string;
  groupName?: string;
  userId: string;
  nickname?: string;
  isGroupMemory: boolean;
  manualText: string;
  facts: MemoryFactEntry[];
}

/** Body of `PUT /api/memory/fact/:id`; an absent field keeps its current value. */
export interface MemoryFactPatch {
  content?: string;
  scope?: string;
  durability?: MemoryFactDurability;
}

/** `PUT /api/memory/group/:groupId[/user/:userId]/manual` */
export interface MemoryManualSavedResponse {
  saved: boolean;
}

/** `PUT /api/memory/fact/:id` */
export interface MemoryFactUpdatedResponse {
  fact: MemoryFactEntry;
}

/** `DELETE /api/memory/fact/:id` */
export interface MemoryFactDeletedResponse {
  deleted: boolean;
}
