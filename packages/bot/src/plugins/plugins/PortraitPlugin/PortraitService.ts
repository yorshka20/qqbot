// Portrait scoring: keyword-driven per-(group,user,dimension) accrual, read back
// as radar axes normalized against the group's per-axis maximum.

import type { Config, PortraitDimensionConfig } from '@/core/config';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { ModelAccessor, UserPortraitScore } from '@/database/models/types';

const DEFAULT_COOLDOWN_SECONDS = 60;

/** One radar axis for a user: raw accrued score + value normalized to 0..100 vs group max. */
export interface PortraitAxis {
  dimensionId: string;
  name: string;
  raw: number;
  value: number;
}

export interface UserPortrait {
  axes: PortraitAxis[];
  /** True when the user has any non-zero score across the configured dimensions. */
  hasData: boolean;
}

export class PortraitService {
  constructor(
    private readonly databaseManager: DatabaseManager,
    private readonly config: Config,
  ) {}

  private get cooldownMs(): number {
    const seconds = this.config.getPortraitConfig()?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    return Math.max(0, seconds) * 1000;
  }

  private get dimensions(): PortraitDimensionConfig[] {
    return this.config.getPortraitConfig()?.dimensions ?? [];
  }

  private getAccessor(): ModelAccessor<UserPortraitScore> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter.isConnected()) {
      throw new Error('[PortraitService] Database not connected');
    }
    return adapter.getModel('userPortraitScore');
  }

  /** Sum of points from every rule the message text hits, for one dimension. */
  private gainedPoints(dimension: PortraitDimensionConfig, lowerText: string): number {
    let gained = 0;
    for (const rule of dimension.rules) {
      if (rule.keywords.some((kw) => kw && lowerText.includes(kw.toLowerCase()))) {
        gained += rule.points;
      }
    }
    return gained;
  }

  /**
   * Process one group message: accrue score across all dimensions whose keywords
   * it hits and whose cooldown has elapsed.
   */
  async awardFromMessage(groupId: string, userId: string, text: string): Promise<void> {
    const dimensions = this.dimensions;
    if (dimensions.length === 0 || !text.trim()) {
      return;
    }

    const lowerText = text.toLowerCase();
    const accessor = this.getAccessor();
    const now = Date.now();
    const cooldownMs = this.cooldownMs;

    for (const dimension of dimensions) {
      const gained = this.gainedPoints(dimension, lowerText);
      if (gained <= 0) {
        continue;
      }

      const row = await accessor.findOne({ groupId, userId, dimensionId: dimension.id });
      if (row) {
        const lastGrant = new Date(row.lastGrantAt).getTime();
        if (Number.isFinite(lastGrant) && now - lastGrant < cooldownMs) {
          continue;
        }
        await accessor.update(row.id, { score: row.score + gained, lastGrantAt: new Date(now).toISOString() });
      } else {
        await accessor.create({
          groupId,
          userId,
          dimensionId: dimension.id,
          score: gained,
          lastGrantAt: new Date(now).toISOString(),
        });
      }
    }
  }

  /**
   * Build a user's radar: each configured dimension becomes an axis, the user's
   * raw score normalized against the group's max score on that axis (percentile).
   * Axes with no data anywhere in the group render at 0.
   */
  async getUserPortrait(groupId: string, userId: string): Promise<UserPortrait> {
    const dimensions = this.dimensions;
    const accessor = this.getAccessor();
    const rows = await accessor.find({ groupId });

    const groupMax = new Map<string, number>();
    const userScore = new Map<string, number>();
    for (const row of rows) {
      groupMax.set(row.dimensionId, Math.max(groupMax.get(row.dimensionId) ?? 0, row.score));
      if (row.userId === userId) {
        userScore.set(row.dimensionId, row.score);
      }
    }

    let hasData = false;
    const axes: PortraitAxis[] = dimensions.map((dim) => {
      const raw = userScore.get(dim.id) ?? 0;
      const max = groupMax.get(dim.id) ?? 0;
      if (raw > 0) {
        hasData = true;
      }
      const value = max > 0 ? Math.round((raw / max) * 100) : 0;
      return { dimensionId: dim.id, name: dim.name, raw, value };
    });

    return { axes, hasData };
  }
}
