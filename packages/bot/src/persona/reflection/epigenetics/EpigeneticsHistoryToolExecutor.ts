// EpigeneticsHistoryToolExecutor — read-only reflection-scope tool.
// Returns timeline of last N days of persona reflections + summary diff.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import type { EpigeneticsStore } from './EpigeneticsStore';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_FETCH = 200;

@Tool({
  name: 'epigenetics_history',
  description:
    '读取 persona 的 epigenetics 历史快照，按 reflection 日志倒推过去 N 天的 trait/affinity 演化。Read-only。',
  executor: 'epigenetics_history',
  visibility: { reflection: true },
  parameters: {
    personaId: { type: 'string', required: true, description: 'Persona ID' },
    days: { type: 'number', required: false, description: '查询天数（默认 7，最大 30）' },
  },
  whenToUse: '反思时回顾 persona 的长期 trait / tone 演化趋势',
})
@injectable()
export class EpigeneticsHistoryToolExecutor extends BaseToolExecutor {
  name = 'epigenetics_history';

  constructor(@inject(DITokens.EPIGENETICS_STORE) private store: EpigeneticsStore) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const personaId = String(call.parameters?.personaId ?? '').trim();
    if (!personaId) {
      return this.error('参数 personaId 必填', 'missing personaId');
    }
    const rawDays = typeof call.parameters?.days === 'number' ? (call.parameters.days as number) : DEFAULT_DAYS;
    const days = Math.max(1, Math.min(MAX_DAYS, rawDays));
    const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      const reflections = (await this.store.getRecentReflections(personaId, MAX_FETCH)).filter(
        (r) => r.timestamp >= sinceTs,
      );

      const timeline = reflections.map((r) => ({
        ts: r.timestamp,
        trigger: r.trigger,
        summary: r.insightMd.slice(0, 80),
        currentTone: r.appliedPatch?.currentTone ?? null,
        traitKeys: Object.keys(r.appliedPatch?.traitDeltas ?? {}),
      }));

      // Diff: sum of trait deltas across the window (per trait key)
      const traitDeltasSum: Record<string, number> = {};
      for (const r of reflections) {
        const td = r.appliedPatch?.traitDeltas;
        if (!td) continue;
        for (const [k, v] of Object.entries(td)) {
          if (typeof v === 'number') {
            traitDeltasSum[k] = (traitDeltasSum[k] ?? 0) + v;
          }
        }
      }

      // Tone transitions: order ASC, list distinct adjacent tones
      const ascending = [...reflections].reverse(); // store returns DESC
      const toneTransitions: string[] = [];
      let lastTone: string | null = null;
      for (const r of ascending) {
        const t = r.appliedPatch?.currentTone ?? null;
        if (t && t !== lastTone) {
          toneTransitions.push(String(t));
          lastTone = t;
        }
      }

      // Reply: render markdown summary (head 5 + tail 5 of timeline)
      const head = timeline.slice(0, 5);
      const tail = timeline.slice(-5);
      const renderRow = (e: (typeof timeline)[number]) =>
        `- ${new Date(e.ts).toISOString()} [${e.trigger}] tone=${e.currentTone ?? '-'} traits=${e.traitKeys.join('/') || '-'} | ${e.summary}`;
      const lines: string[] = [
        `# Epigenetics history for persona=${personaId}, last ${days} day(s)`,
        `Total reflections: ${timeline.length}`,
        '',
        '## Trait deltas sum',
        Object.entries(traitDeltasSum).length === 0
          ? '（无 trait 变化）'
          : Object.entries(traitDeltasSum)
              .map(([k, v]) => `- ${k}: ${v.toFixed(3)}`)
              .join('\n'),
        '',
        '## Tone transitions',
        toneTransitions.length === 0 ? '（无 tone 切换）' : toneTransitions.join(' → '),
        '',
        '## Timeline (head)',
        head.map(renderRow).join('\n') || '（空）',
        '',
        '## Timeline (tail)',
        tail.map(renderRow).join('\n') || '（空）',
      ];

      return this.success(lines.join('\n'), {
        personaId,
        days,
        count: timeline.length,
        timeline,
        traitDeltasSum,
        toneTransitions,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.error(`epigenetics_history 读取失败: ${msg}`, msg);
    }
  }
}
