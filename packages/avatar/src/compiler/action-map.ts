import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../utils/repoRoot';
import type { ActionMapEntry, ParamTarget } from './types';

export class ActionMap {
  private readonly entries: Record<string, ActionMapEntry>;

  constructor(filePath?: string) {
    const resolved = filePath ?? path.resolve(getRepoRoot(), 'config/avatar/action-map.json');
    const raw = readFileSync(resolved, 'utf8');
    this.entries = JSON.parse(raw) as Record<string, ActionMapEntry>;
  }

  has(name: string): boolean {
    return name in this.entries;
  }

  getDuration(name: string): number | undefined {
    return this.entries[name]?.defaultDuration;
  }

  resolveAction(action: string, emotion: string, intensity: number): ParamTarget[] {
    void emotion;
    const entry = this.entries[action];
    if (!entry) return [];
    return entry.params.map((p) => ({
      paramId: p.paramId,
      targetValue: p.targetValue * intensity,
      weight: p.weight,
    }));
  }
}
