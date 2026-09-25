// GroupReportPlugin - owns the group daily report, the daily comic and keyword mines.
//
// All three are tasks of the group_day fan-out, which reads yesterday's chat once and
// runs every task on the same prefix. This plugin registers the tasks while enabled and
// the /group_report command, which runs the report task alone. Scheduled runs are an
// agenda item (`action fanout`) naming the tasks it wants.

import type { AgendaService } from '@/agenda/AgendaService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { GroupDayFanout } from '@/fanout/contexts/groupDay/GroupDayFanout';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PluginCommandHandler } from '../../PluginCommandHandler';
import { ComicTask } from './comicTask';
import { GroupReportRenderer } from './GroupReportRenderer';
import { KeywordMinesTask } from './keywordMines';
import { ReportTask } from './reportTask';

@RegisterPlugin({
  name: 'groupReport',
  version: '1.0.0',
  description: 'Group daily report and comic, as tasks on the shared group_day chat prefix',
})
export class GroupReportPlugin extends PluginBase {
  async onInit(): Promise<void> {
    const cmdHandler = new PluginCommandHandler(
      'group_report',
      '生成群聊每日汇报',
      '/group_report',
      (args, ctx) => this.handleCommand(args, ctx),
      this.context,
      ['admin', 'owner'],
    );
    getContainer().resolve<CommandManager>(DITokens.COMMAND_MANAGER).register(cmdHandler, this.name);
    logger.info('[GroupReportPlugin] Initialized (command registered)');
  }

  async onEnable(): Promise<void> {
    await super.onEnable();
    const container = getContainer();
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    const botSelfId = container.resolve<Config>(DITokens.CONFIG).getConfig().bot.selfId;
    const fanout = this.groupDay();
    fanout.registerTask(new ReportTask({ promptManager, renderer: new GroupReportRenderer(messageAPI) }));
    fanout.registerTask(
      new ComicTask({
        promptManager,
        messageAPI,
        historyService: container.resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE),
        botSelfId,
      }),
    );
    fanout.registerTask(
      new KeywordMinesTask({
        promptManager,
        agendaService: container.resolve<AgendaService>(DITokens.AGENDA_SERVICE),
        botSelfId,
      }),
    );
    logger.info('[GroupReportPlugin] Registered group_day tasks: report, comic, mines');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    const fanout = this.groupDay();
    fanout.unregisterTask(ReportTask.NAME);
    fanout.unregisterTask(ComicTask.NAME);
    fanout.unregisterTask(KeywordMinesTask.NAME);
    logger.info('[GroupReportPlugin] Unregistered group_day tasks: report, comic, mines');
  }

  private groupDay(): GroupDayFanout {
    return getContainer().resolve(GroupDayFanout);
  }

  private async handleCommand(_args: string[], context: CommandContext): Promise<CommandResult> {
    if (!context.groupId) {
      return { success: false, error: '此命令仅在群聊中可用' };
    }

    const groupId = String(context.groupId);
    const target = {
      chat: 'group' as const,
      id: groupId,
      name: context.originalMessage?.groupName || `群${groupId}`,
      protocol: context.metadata.protocol,
    };

    // Fire-and-forget: the report takes minutes and delivers itself as an image
    void this.groupDay()
      .run(target, { [ReportTask.NAME]: {} })
      .then((report) => {
        logger.info(`[GroupReportPlugin] /group_report for ${groupId}: ${report.status}`);
      })
      .catch((err) => {
        logger.error('[GroupReportPlugin] Report generation failed:', err);
      });

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成昨日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }
}
