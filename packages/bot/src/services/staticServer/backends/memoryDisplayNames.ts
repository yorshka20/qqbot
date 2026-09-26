// Display names for memory owners, read from the latest messages (SQLite `messages` table).

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';

export class MemoryDisplayNames {
  constructor(private readonly db: Database) {}

  /**
   * Latest non-empty group name seen on a message in each group.
   * Names live on message metadata, not on the fact row.
   */
  lookupLatestGroupNames(groupIds: string[]): Map<string, string> {
    const names = new Map<string, string>();
    if (groupIds.length === 0) {
      return names;
    }
    try {
      for (const chunk of chunkIds(groupIds)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = this.db
          .query(
            `WITH ranked AS (
              SELECT groupId,
                json_extract(metadata, '$.groupName') AS groupName,
                ROW_NUMBER() OVER (PARTITION BY groupId ORDER BY createdAt DESC, id DESC) AS rn
              FROM messages
              WHERE groupId IN (${placeholders})
                AND json_extract(metadata, '$.groupName') IS NOT NULL
                AND length(trim(json_extract(metadata, '$.groupName'))) > 0
            )
            SELECT groupId, groupName FROM ranked WHERE rn = 1`,
          )
          .all(...chunk) as Array<{ groupId: string; groupName: string }>;
        for (const row of rows) {
          const name = row.groupName.trim();
          if (name) {
            names.set(String(row.groupId), name);
          }
        }
      }
    } catch (err) {
      logger.warn('[MemoryDisplayNames] group name lookup failed:', err);
    }
    return names;
  }

  /**
   * Latest display name for each (groupId, userId).
   * A group card overrides the account nickname, matching how the group itself
   * shows the member. When that group has no named message, fall back to the
   * latest name this user has used anywhere.
   */
  lookupLatestNicknames(subjects: Array<{ groupId: string; userId: string }>): Map<string, string> {
    const names = new Map<string, string>();
    if (subjects.length === 0) {
      return names;
    }
    try {
      const groupIds = [...new Set(subjects.map((s) => s.groupId))];
      const byGroup = new Map<string, { card: string | null; nickname: string | null }>();
      for (const chunk of chunkIds(groupIds)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = this.db
          .query(
            `WITH ranked AS (
              SELECT groupId, userId,
                json_extract(metadata, '$.sender.card') AS card,
                json_extract(metadata, '$.sender.nickname') AS nickname,
                ROW_NUMBER() OVER (PARTITION BY groupId, userId ORDER BY createdAt DESC, id DESC) AS rn
              FROM messages
              WHERE groupId IN (${placeholders})
                AND ${SENDER_NAME_PRESENT}
            )
            SELECT groupId, userId, card, nickname FROM ranked WHERE rn = 1`,
          )
          .all(...chunk) as Array<{
          groupId: string;
          userId: string;
          card: string | null;
          nickname: string | null;
        }>;
        for (const row of rows) {
          byGroup.set(memorySubjectKey(String(row.groupId), String(row.userId)), {
            card: row.card,
            nickname: row.nickname,
          });
        }
      }

      const missingUserIds = [
        ...new Set(
          subjects
            .filter((subject) => !pickSenderName(byGroup.get(memorySubjectKey(subject.groupId, subject.userId))))
            .map((subject) => subject.userId),
        ),
      ];
      const byUser = new Map<string, { card: string | null; nickname: string | null }>();
      for (const chunk of chunkIds(missingUserIds)) {
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = this.db
          .query(
            `WITH ranked AS (
              SELECT userId,
                json_extract(metadata, '$.sender.card') AS card,
                json_extract(metadata, '$.sender.nickname') AS nickname,
                ROW_NUMBER() OVER (PARTITION BY userId ORDER BY createdAt DESC, id DESC) AS rn
              FROM messages
              WHERE userId IN (${placeholders})
                AND ${SENDER_NAME_PRESENT}
            )
            SELECT userId, card, nickname FROM ranked WHERE rn = 1`,
          )
          .all(...chunk) as Array<{ userId: string; card: string | null; nickname: string | null }>;
        for (const row of rows) {
          byUser.set(String(row.userId), { card: row.card, nickname: row.nickname });
        }
      }

      for (const subject of subjects) {
        const key = memorySubjectKey(subject.groupId, subject.userId);
        const name = pickSenderName(byGroup.get(key)) ?? pickSenderName(byUser.get(subject.userId));
        if (name) {
          names.set(key, name);
        }
      }
    } catch (err) {
      logger.warn('[MemoryDisplayNames] nickname lookup failed:', err);
    }
    return names;
  }
}

const SENDER_NAME_PRESENT = `(
  (json_extract(metadata, '$.sender.card') IS NOT NULL AND length(trim(json_extract(metadata, '$.sender.card'))) > 0)
  OR (json_extract(metadata, '$.sender.nickname') IS NOT NULL AND length(trim(json_extract(metadata, '$.sender.nickname'))) > 0)
)`;

/** sqlite default variable limit is 999; stay under it when binding id lists. */
function chunkIds(ids: string[]): string[][] {
  const size = 400;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

export function memorySubjectKey(groupId: string, userId: string): string {
  return `${groupId}\0${userId}`;
}

function pickSenderName(row: { card: string | null; nickname: string | null } | undefined): string | undefined {
  if (!row) {
    return undefined;
  }
  const card = typeof row.card === 'string' ? row.card.trim() : '';
  if (card) {
    return card;
  }
  const nickname = typeof row.nickname === 'string' ? row.nickname.trim() : '';
  return nickname || undefined;
}
