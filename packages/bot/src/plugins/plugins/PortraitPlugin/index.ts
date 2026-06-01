// Portrait Plugin — one self-contained feature: keyword-driven score accrual on
// group messages (hook), a /画像 command that renders the user's radar chart
// (registered dynamically against CommandManager), and the scoring service.
// Everything lives in this folder; there is no separate command-handler file or
// DI-registered service.

import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandHandler, CommandResult } from '@/command/types';
import { isNoReplyPath } from '@/context/HookContextHelpers';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookContext, HookResult } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { BrowserService } from '@/services/browser/BrowserService';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../../decorators';
import { PluginBase } from '../../PluginBase';
import { PortraitService } from './PortraitService';
import { renderPortraitHTML } from './renderPortraitHTML';

const COMMAND_NAMES = ['portrait', '画像', '我的画像'];

@RegisterPlugin({
  name: 'portrait',
  version: '1.0.0',
  description: 'Keyword-driven personal portrait: accrues per-dimension score and renders a radar chart via /画像',
})
export class PortraitPlugin extends PluginBase {
  private service?: PortraitService;
  private commandManager?: CommandManager;

  async onInit(): Promise<void> {
    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);
    if (!config.getPortraitConfig()?.enabled) {
      logger.warn('[PortraitPlugin] config.portrait.enabled is false; plugin inert');
      this.enabled = false;
      return;
    }

    const databaseManager = container.resolve<DatabaseManager>(DITokens.DATABASE_MANAGER);
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    this.service = new PortraitService(databaseManager, config);

    this.registerCommands();
  }

  async onDisable(): Promise<void> {
    this.commandManager?.unregisterPluginCommands(this.name);
    await super.onDisable();
  }

  /** Register /画像 (and aliases) dynamically — no @Command handler files. */
  private registerCommands(): void {
    if (!this.commandManager) {
      return;
    }
    const execute = (_args: string[], context: CommandContext): Promise<CommandResult> => this.handlePortrait(context);
    for (const name of COMMAND_NAMES) {
      const handler: CommandHandler = {
        name,
        description: '查看自己的群画像雷达图',
        usage: '/画像 — 渲染你在本群的个人画像雷达图',
        permissions: ['user'],
        execute,
      };
      this.commandManager.register(handler, this.name);
    }
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 15,
    applicableSources: ['qq-group'],
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.enabled || !this.service) {
      return true;
    }
    if (isNoReplyPath(context)) {
      return true;
    }
    if (context.message.messageType !== 'group' || !context.message.groupId) {
      return true;
    }
    const botSelfId = context.metadata.get('botSelfId');
    const userId = context.message.userId?.toString();
    if (!userId || (botSelfId && botSelfId === userId)) {
      return true;
    }

    const groupId = context.message.groupId.toString();
    const text = context.message.message ?? '';

    // Fire-and-forget: never block the pipeline on score accrual.
    this.service.awardFromMessage(groupId, userId, text).catch((err) => {
      logger.error('[PortraitPlugin] awardFromMessage failed:', err);
    });

    return true;
  }

  private async handlePortrait(context: CommandContext): Promise<CommandResult> {
    if (context.messageType !== 'group' || context.groupId === undefined) {
      return { success: false, error: '群画像仅在群聊中可用。' };
    }
    if (!this.service) {
      return { success: false, error: '画像系统未启用。' };
    }

    const groupId = context.groupId.toString();
    const userId = context.userId.toString();
    const portrait = await this.service.getUserPortrait(groupId, userId);

    if (portrait.axes.length < 3) {
      return { success: false, error: '画像维度未配置（至少需要 3 个维度才能绘制雷达图）。' };
    }
    if (!portrait.hasData) {
      return {
        success: true,
        segments: new MessageBuilder().text('你在本群还没有积累画像数据，多聊聊就有了～').build(),
      };
    }

    const sender = context.originalMessage?.sender;
    const name = sender?.card || sender?.nickname || userId;
    const html = renderPortraitHTML({
      title: `${name} 的群画像`,
      subtitle: '雷达值 = 本群该维度相对最高分',
      axes: portrait.axes.map((a) => ({ name: a.name, value: a.value, raw: a.raw })),
    });

    const image = await this.renderToImage(html);
    return { success: true, segments: new MessageBuilder().image({ data: image.toString('base64') }).build() };
  }

  private async renderToImage(html: string): Promise<Buffer> {
    const page = await BrowserService.getInstance().createPage();
    try {
      await page.setViewport({ width: 680, height: 760, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);

      const bounds = await page.evaluate(() => {
        const el = document.querySelector('.portrait-container');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
      if (!bounds) {
        throw new Error('Failed to compute portrait content bounds');
      }

      const shot = await page.screenshot({ type: 'png', clip: bounds, omitBackground: true });
      return shot as Buffer;
    } finally {
      await page.close().catch((e) => logger.warn('[PortraitPlugin] page close failed:', e));
    }
  }
}
