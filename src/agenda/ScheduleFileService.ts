// ScheduleFileService - reads a human-editable markdown schedule file and syncs items to AgendaService DB.
//
// File format (data/agenda/schedule.md):
//
//   # Bot Schedule
//
//   ## 每日热搜播报
//   - 触发: `cron 0 8 * * *`
//   - 群: `123456789`
//   - 冷却: `23h`
//
//   搜索今日微博热搜前10，整理成简洁的列表发送到群里，语气轻松活泼。
//
//   ---
//
//   ## 新人欢迎
//   - 触发: `onEvent group_member_join`
//   - 群: `123456789`
//   - 冷却: `1min`
//
//   热情欢迎新成员加入群聊，介绍群的主要话题和bot的功能。
//
// Rules:
//   - Each `## Heading` → one AgendaItem (name = heading text)
//   - Metadata = list items `- key: \`value\`` or `- key: value`
//   - Intent = paragraph text after metadata block (non-list, non-empty)
//   - File-sourced items (metadata.source === 'file') are tombstone (disabled) when removed from file
//   - Manual DB items (no source tag) are never touched by sync
//   - `---` separators are cosmetic, ignored by parser

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PromptManager } from '@/ai';
import { logger } from '@/utils/logger';
import type { AgendaService } from './AgendaService';
import type { AgendaItem, AgendaTriggerType, CreateAgendaItemData } from './types';

/** Parsed item from one markdown section */
interface ParsedScheduleItem {
  name: string;
  triggerType: AgendaTriggerType;
  cronExpr?: string;
  triggerAt?: string;
  eventType?: string;
  eventFilter?: string;
  groupId?: string;
  userId?: string;
  intent: string;
  cooldownMs: number;
  maxSteps: number;
  enabled: boolean;
}

/** Data for appending a new section to schedule.md (e.g. from /schedule command) */
export interface AppendItemData {
  name: string;
  triggerType: AgendaTriggerType;
  cronExpr?: string;
  triggerAt?: string;
  eventType?: string;
  groupId?: string;
  cooldownMs?: number;
  intent: string;
}

/** JSON metadata tag that marks a DB item as originating from the schedule file */
const FILE_SOURCE_META = JSON.stringify({ source: 'file' });

export class ScheduleFileService {
  constructor(
    private scheduleFilePath: string,
    private agendaService: AgendaService,
    private promptManager: PromptManager,
  ) {}

  /**
   * Read schedule.md, parse items, upsert them into the AgendaService DB,
   * and tombstone (disable) any file-sourced DB items no longer present in the file.
   * Called on startup and can be called to hot-reload.
   */
  async syncFromFile(): Promise<void> {
    const content = await this.readFile();
    if (!content) return;

    const parsed = this.parseSchedule(content);
    if (!parsed.length) {
      logger.debug('[ScheduleFileService] No items found in schedule file');
      return;
    }

    let created = 0;
    let updated = 0;
    const fileNames = new Set(parsed.map((p) => p.name));

    for (const p of parsed) {
      const existing = await this.findByName(p.name);
      if (existing) {
        // Update trigger/intent/cooldown fields but preserve runtime state (lastRunAt, etc.)
        // Always (re-)tag as file-sourced so tombstone logic can track it.
        await this.agendaService.updateItem(existing.id, {
          triggerType: p.triggerType,
          cronExpr: p.cronExpr,
          triggerAt: p.triggerAt,
          eventType: p.eventType,
          eventFilter: p.eventFilter,
          groupId: p.groupId ?? existing.groupId,
          userId: p.userId ?? existing.userId,
          intent: p.intent,
          cooldownMs: p.cooldownMs,
          maxSteps: p.maxSteps,
          enabled: p.enabled,
          metadata: FILE_SOURCE_META,
        });
        updated++;
      } else {
        await this.agendaService.createItem({
          ...(p as CreateAgendaItemData),
          metadata: FILE_SOURCE_META,
        });
        created++;
      }
    }

    // Tombstone: disable file-sourced DB items that are no longer in the file
    const allItems = await this.agendaService.listItems();
    let tombstoned = 0;
    for (const item of allItems) {
      if (!item.metadata) continue;
      try {
        const meta = JSON.parse(item.metadata) as Record<string, unknown>;
        if (meta.source !== 'file') continue;
      } catch {
        continue;
      }
      if (!fileNames.has(item.name) && item.enabled) {
        await this.agendaService.setEnabled(item.id, false);
        tombstoned++;
        logger.info(`[ScheduleFileService] Tombstoned removed item "${item.name}" (disabled)`);
      }
    }

    logger.info(
      `[ScheduleFileService] Sync done: ${created} created, ${updated} updated, ${tombstoned} tombstoned from ${this.scheduleFilePath}`,
    );
  }

  /**
   * Write a default template file if none exists. Called on first startup.
   */
  async ensureFileExists(): Promise<void> {
    try {
      await readFile(this.scheduleFilePath, 'utf-8');
      // File exists, nothing to do
    } catch {
      // File not found — write the template from prompts/agenda/schedule_default.txt
      await mkdir(dirname(this.scheduleFilePath), { recursive: true });
      const templateContent = this.promptManager.render('agenda.schedule_default');
      await writeFile(this.scheduleFilePath, `${templateContent}\n`, 'utf-8');
      logger.info(`[ScheduleFileService] Created default schedule file at ${this.scheduleFilePath}`);
    }
  }

  /**
   * Append a new ## section to schedule.md.
   * Used by /schedule command to persist a newly created task to the file.
   */
  async appendItem(data: AppendItemData): Promise<void> {
    const triggerStr = this.formatTrigger(data);
    const cooldownStr = data.cooldownMs != null ? String(data.cooldownMs) : '60000';

    const lines: string[] = ['', '---', '', `## ${data.name}`, `- 触发: \`${triggerStr}\``];

    if (data.groupId) {
      lines.push(`- 群: \`${data.groupId}\``);
    }

    lines.push(`- 冷却: \`${cooldownStr}\``);
    lines.push('');
    lines.push(data.intent);
    lines.push('');

    await mkdir(dirname(this.scheduleFilePath), { recursive: true });
    await appendFile(this.scheduleFilePath, lines.join('\n'), 'utf-8');
    logger.info(`[ScheduleFileService] Appended item "${data.name}" to ${this.scheduleFilePath}`);
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────────

  parseSchedule(content: string): ParsedScheduleItem[] {
    const items: ParsedScheduleItem[] = [];

    // Split into sections by `## ` headings (keep heading text)
    const sections = content.split(/\n(?=## )/);

    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed.startsWith('## ')) continue;

      const parsed = this.parseSection(trimmed);
      if (parsed) items.push(parsed);
    }

    return items;
  }

  private parseSection(section: string): ParsedScheduleItem | null {
    const lines = section.split('\n');
    const name = lines[0].replace(/^##\s+/, '').trim();
    if (!name) return null;

    const meta: Record<string, string> = {};
    const intentLines: string[] = [];
    let inMetaBlock = true; // metadata comes first (list items)

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Skip HTML comments and horizontal rules
      if (line.trim().startsWith('<!--') || line.trim() === '---') {
        inMetaBlock = false;
        continue;
      }

      // Metadata: `- key: value` or `- key: \`value\``
      const metaMatch = line.match(/^-\s+([^:：]+)[：:]\s+`?([^`\n]+)`?\s*$/);
      if (metaMatch && inMetaBlock) {
        const key = metaMatch[1].trim().toLowerCase();
        const value = metaMatch[2].trim();
        meta[key] = value;
        continue;
      }

      // Once we hit a non-list, non-empty line, metadata block is done
      if (inMetaBlock && line.trim() && !line.trim().startsWith('-')) {
        inMetaBlock = false;
      }

      // Collect intent lines (non-metadata, non-empty meaningful content)
      const trimLine = line.trim();
      if (
        trimLine &&
        !trimLine.startsWith('#') &&
        !trimLine.startsWith('<!--') &&
        !trimLine.startsWith('-->') &&
        trimLine !== '---'
      ) {
        intentLines.push(trimLine);
      }
    }

    const intent = intentLines.join(' ').trim();
    if (!intent) {
      logger.warn(`[ScheduleFileService] Section "## ${name}": no intent text found, skipping`);
      return null;
    }

    // Parse trigger
    const triggerRaw = meta['触发'] ?? meta['trigger'] ?? '';
    const trigger = this.parseTrigger(triggerRaw, name);
    if (!trigger) return null;

    // Parse groupId
    const groupId = meta['群'] ?? meta['groupid'] ?? meta['group'] ?? undefined;

    // Parse userId
    const userId = meta['用户'] ?? meta['userid'] ?? meta['user'] ?? undefined;

    // Parse cooldown
    const cooldownRaw = meta['冷却'] ?? meta['cooldown'] ?? meta['cooldownms'] ?? '60000';
    const cooldownMs = this.parseDuration(cooldownRaw);

    // Parse maxSteps
    const stepsRaw = meta['步数'] ?? meta['steps'] ?? meta['maxsteps'] ?? '3';
    const maxSteps = Math.max(1, Number.parseInt(stepsRaw, 10) || 3);

    // Parse enabled
    const enabledRaw = meta['启用'] ?? meta['enabled'] ?? 'true';
    const enabled = enabledRaw.toLowerCase() !== 'false' && enabledRaw !== '0';

    // Parse eventFilter (JSON)
    const eventFilter = meta['事件过滤'] ?? meta['eventfilter'] ?? undefined;

    return {
      name,
      ...trigger,
      groupId,
      userId,
      intent,
      cooldownMs,
      maxSteps,
      enabled,
      eventFilter,
    };
  }

  /**
   * Parse trigger string: `cron 0 8 * * *` | `onEvent group_member_join` | `once 2026-06-01T08:00:00`
   * Public so external callers (e.g. ScheduleCommandHandler) can validate trigger strings.
   */
  parseTrigger(
    raw: string,
    name: string,
  ): Pick<ParsedScheduleItem, 'triggerType' | 'cronExpr' | 'triggerAt' | 'eventType'> | null {
    const s = raw.trim();

    if (s.startsWith('cron ')) {
      const cronExpr = s.slice(5).trim();
      return { triggerType: 'cron', cronExpr };
    }

    if (s.startsWith('onEvent ') || s.startsWith('onevent ')) {
      const eventType = s.replace(/^onevent\s+/i, '').trim();
      return { triggerType: 'onEvent', eventType };
    }

    if (s.startsWith('once ')) {
      const triggerAt = s.slice(5).trim();
      return { triggerType: 'once', triggerAt };
    }

    logger.warn(`[ScheduleFileService] Section "## ${name}": cannot parse trigger "${raw}", skipping`);
    return null;
  }

  /**
   * Parse duration: `30s`, `5min`, `2h`, `1d`, or raw ms number string.
   * Public so external callers (e.g. ScheduleCommandHandler) can reuse the parser.
   */
  parseDuration(raw: string): number {
    const s = raw.trim().toLowerCase();

    const units: Record<string, number> = {
      ms: 1,
      s: 1_000,
      sec: 1_000,
      min: 60_000,
      h: 3_600_000,
      hr: 3_600_000,
      d: 86_400_000,
      day: 86_400_000,
    };

    for (const [suffix, mult] of Object.entries(units)) {
      if (s.endsWith(suffix)) {
        const num = Number.parseFloat(s.slice(0, -suffix.length));
        if (!Number.isNaN(num)) return Math.round(num * mult);
      }
    }

    const ms = Number.parseInt(s, 10);
    return Number.isNaN(ms) ? 60_000 : ms;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /** Format trigger fields back to the schedule.md string representation. */
  private formatTrigger(data: Pick<AppendItemData, 'triggerType' | 'cronExpr' | 'triggerAt' | 'eventType'>): string {
    switch (data.triggerType) {
      case 'cron':
        return `cron ${data.cronExpr ?? ''}`;
      case 'once':
        return `once ${data.triggerAt ?? ''}`;
      case 'onEvent':
        return `onEvent ${data.eventType ?? ''}`;
    }
  }

  private async readFile(): Promise<string | null> {
    try {
      return await readFile(this.scheduleFilePath, 'utf-8');
    } catch {
      logger.debug(`[ScheduleFileService] Schedule file not found at ${this.scheduleFilePath}`);
      return null;
    }
  }

  private async findByName(name: string): Promise<AgendaItem | null> {
    const items = await this.agendaService.listItems();
    return items.find((i) => i.name === name) ?? null;
  }
}
