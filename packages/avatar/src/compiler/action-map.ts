import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionMapEntry, ActionSummary, ParamTarget } from './types';

export class ActionMap {
  private readonly entries: Record<string, ActionMapEntry>;

  constructor(filePath?: string) {
    const resolved = filePath ?? fileURLToPath(new URL('../../assets/default-action-map.json', import.meta.url));
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
      channel: p.channel,
      targetValue: p.targetValue * intensity,
      weight: p.weight,
      oscillate: p.oscillate,
    }));
  }

  /**
   * Public summary of every loaded action, used by consumers (PreviewServer
   * `/action-map` route, future prompt generation, etc.) to discover what
   * triggers are currently available without hardcoding names. Channel list
   * is deduplicated in original order.
   */
  listActions(): ActionSummary[] {
    const out: ActionSummary[] = [];
    for (const [name, entry] of Object.entries(this.entries)) {
      const channels: string[] = [];
      const seen = new Set<string>();
      for (const p of entry.params) {
        if (seen.has(p.channel)) continue;
        seen.add(p.channel);
        channels.push(p.channel);
      }
      out.push({
        name,
        defaultDuration: entry.defaultDuration,
        category: entry.category,
        channels,
      });
    }
    return out;
  }
}
