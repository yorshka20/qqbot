// RelationshipHistoryToolExecutor — read-only reflection-scope tool.
// Returns affinity / familiarity event timeline for a (persona, user) pair.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import type { EpigeneticsStore } from '../epigenetics/EpigeneticsStore';

const DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 90;
const MAX_EVENTS = 200;

@Tool({
  name: 'relationship_history',
  description: '读取 persona ↔ 特定 user 的 affinity / familiarity 演化轨迹（按事件流）。Read-only。',
  executor: 'relationship_history',
  visibility: { reflection: true },
  parameters: {
    personaId: { type: 'string', required: true, description: 'Persona ID' },
    userId: { type: 'string', required: true, description: '目标 User ID' },
    sinceDays: { type: 'number', required: false, description: '查多少天的事件（默认 30，最大 90）' },
  },
  whenToUse: '反思时回顾与某个 user 的关系演化（affinity 涨跌、familiarity 累积）',
})
@injectable()
export class RelationshipHistoryToolExecutor extends BaseToolExecutor {
  name = 'relationship_history';

  constructor(@inject(DITokens.EPIGENETICS_STORE) private store: EpigeneticsStore) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const personaId = String(call.parameters?.personaId ?? '').trim();
    const userId = String(call.parameters?.userId ?? '').trim();
    if (!personaId || !userId) {
      return this.error('参数 personaId / userId 必填', 'missing personaId or userId');
    }
    const rawSince =
      typeof call.parameters?.sinceDays === 'number' ? (call.parameters.sinceDays as number) : DEFAULT_SINCE_DAYS;
    const sinceDays = Math.max(1, Math.min(MAX_SINCE_DAYS, rawSince));
    const sinceTs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

    try {
      const events = await this.store.getRelationshipEvents(personaId, userId, {
        sinceTs,
        limit: MAX_EVENTS,
      });
      const current = await this.store.getRelationship(personaId, userId);

      const renderRow = (e: (typeof events)[number]) =>
        `- ${new Date(e.ts).toISOString()} [${e.eventType}/${e.source}] affinity ${e.oldAffinity.toFixed(3)}→${e.newAffinity.toFixed(3)}  familiarity ${e.oldFamiliarity.toFixed(3)}→${e.newFamiliarity.toFixed(3)}`;

      const lines: string[] = [
        `# Relationship history persona=${personaId} user=${userId}, last ${sinceDays} day(s)`,
        `Events: ${events.length}`,
        '',
        '## Current snapshot',
        current
          ? `- affinity=${current.affinity.toFixed(3)}  familiarity=${current.familiarity.toFixed(3)}  tags=[${current.tags.join(', ')}]`
          : '（暂无关系记录）',
        '',
        '## Events (DESC)',
        events.length === 0 ? '（无事件）' : events.slice(0, 30).map(renderRow).join('\n'),
        events.length > 30 ? `（仅显示最近 30 条，总共 ${events.length} 条）` : '',
      ];

      return this.success(lines.join('\n').trimEnd(), {
        personaId,
        userId,
        sinceDays,
        eventCount: events.length,
        events,
        currentAffinity: current?.affinity ?? null,
        currentFamiliarity: current?.familiarity ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.error(`relationship_history 读取失败: ${msg}`, msg);
    }
  }
}
