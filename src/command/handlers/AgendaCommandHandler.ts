// AgendaCommand - manage agenda items (list, delete, enable, disable)
//
// Usage:
//   /agenda list              列出所有日程任务
//   /agenda delete <id|name>  删除指定日程任务
//   /agenda enable <id|name>  启用指定日程任务
//   /agenda disable <id|name> 禁用指定日程任务

import { inject, injectable } from 'tsyringe';
import type { AgendaService } from '@/agenda/AgendaService';
import type { ScheduleFileService } from '@/agenda/ScheduleFileService';
import type { AgendaItem } from '@/agenda/types';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'agenda',
  description: '管理日程任务（列表/删除/启用/禁用）',
  usage: '/agenda list | delete <id|名称> | enable <id|名称> | disable <id|名称>',
  permissions: ['admin', 'owner'],
  aliases: ['日程管理'],
})
@injectable()
export class AgendaCommand implements CommandHandler {
  name = 'agenda';
  description = '管理日程任务（列表/删除/启用/禁用）';
  usage = '/agenda list | delete <id|名称> | enable <id|名称> | disable <id|名称>';

  constructor(
    @inject(DITokens.AGENDA_SERVICE) private agendaService: AgendaService,
    @inject(DITokens.SCHEDULE_FILE_SERVICE) private scheduleFileService: ScheduleFileService,
  ) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case 'list':
      case 'ls':
      case '列表':
        return this.handleList(context);
      case 'delete':
      case 'del':
      case 'rm':
      case '删除':
        return this.handleDelete(args.slice(1).join(' ').trim(), context);
      case 'enable':
      case 'on':
      case '启用':
        return this.handleSetEnabled(args.slice(1).join(' ').trim(), true);
      case 'disable':
      case 'off':
      case '禁用':
        return this.handleSetEnabled(args.slice(1).join(' ').trim(), false);
      default:
        return {
          success: false,
          error: [
            '用法:',
            '  /agenda list              列出所有日程',
            '  /agenda delete <id|名称>  删除日程',
            '  /agenda enable <id|名称>  启用日程',
            '  /agenda disable <id|名称> 禁用日程',
          ].join('\n'),
        };
    }
  }

  // ─── Subcommands ──────────────────────────────────────────────────────────────

  private async handleList(context: CommandContext): Promise<CommandResult> {
    const groupId = context.groupId?.toString();
    const items = await this.agendaService.listItems({ groupId });

    if (!items.length) {
      const mb = new MessageBuilder();
      mb.text('当前没有日程任务。');
      return { success: true, segments: mb.build() };
    }

    const lines = items.map((item, i) => this.formatItem(item, i + 1));
    const mb = new MessageBuilder();
    mb.text(`📋 日程任务列表 (共${items.length}项)\n\n${lines.join('\n\n')}`);
    return { success: true, segments: mb.build() };
  }

  private async handleDelete(query: string, context: CommandContext): Promise<CommandResult> {
    if (!query) {
      return { success: false, error: '请指定要删除的日程ID或名称。' };
    }

    const item = await this.resolveItem(query, context.groupId?.toString());
    if (!item) {
      return { success: false, error: `未找到日程: "${query}"` };
    }

    // Remove from schedule.md if file-sourced
    if (this.isFileSourced(item)) {
      await this.scheduleFileService.removeItemByName(item.name);
    }

    await this.agendaService.deleteItem(item.id);
    logger.info(`[AgendaCommand] Deleted item "${item.name}" (${item.id})`);

    const mb = new MessageBuilder();
    mb.text(`✅ 已删除日程「${item.name}」`);
    return { success: true, segments: mb.build() };
  }

  private async handleSetEnabled(query: string, enabled: boolean): Promise<CommandResult> {
    if (!query) {
      return { success: false, error: `请指定要${enabled ? '启用' : '禁用'}的日程ID或名称。` };
    }

    const item = await this.resolveItem(query);
    if (!item) {
      return { success: false, error: `未找到日程: "${query}"` };
    }

    if (item.enabled === enabled) {
      const mb = new MessageBuilder();
      mb.text(`日程「${item.name}」已经是${enabled ? '启用' : '禁用'}状态。`);
      return { success: true, segments: mb.build() };
    }

    await this.agendaService.setEnabled(item.id, enabled);
    logger.info(`[AgendaCommand] ${enabled ? 'Enabled' : 'Disabled'} item "${item.name}" (${item.id})`);

    const mb = new MessageBuilder();
    mb.text(`✅ 已${enabled ? '启用' : '禁用'}日程「${item.name}」`);
    return { success: true, segments: mb.build() };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Resolve an item by ID or name (case-insensitive name match). */
  private async resolveItem(query: string, groupId?: string): Promise<AgendaItem | null> {
    // Try exact ID match first
    const byId = await this.agendaService.getItem(query);
    if (byId) return byId;

    // Try name match (case-insensitive)
    const items = await this.agendaService.listItems({ groupId });
    const lowerQuery = query.toLowerCase();
    return items.find((i) => i.name.toLowerCase() === lowerQuery)
      ?? items.find((i) => i.name.toLowerCase().includes(lowerQuery))
      ?? null;
  }

  private isFileSourced(item: AgendaItem): boolean {
    if (!item.metadata) return false;
    try {
      const meta = JSON.parse(item.metadata) as Record<string, unknown>;
      return meta.source === 'file';
    } catch {
      return false;
    }
  }

  private formatItem(item: AgendaItem, index: number): string {
    const status = item.enabled ? '🟢' : '🔴';
    const trigger = this.formatTrigger(item);
    const lines = [
      `${index}. ${status} ${item.name}`,
      `   ID: ${item.id}`,
      `   触发: ${trigger}`,
      `   意图: ${item.intent.length > 50 ? `${item.intent.slice(0, 50)}...` : item.intent}`,
    ];
    if (item.groupId) lines.push(`   群: ${item.groupId}`);
    if (item.lastRunAt) lines.push(`   上次运行: ${item.lastRunAt}`);
    return lines.join('\n');
  }

  private formatTrigger(item: AgendaItem): string {
    switch (item.triggerType) {
      case 'cron':
        return `cron ${item.cronExpr ?? ''}`;
      case 'once':
        return `once ${item.triggerAt ?? ''}`;
      case 'onEvent':
        return `onEvent ${item.eventType ?? ''}`;
      default:
        return item.triggerType;
    }
  }
}
