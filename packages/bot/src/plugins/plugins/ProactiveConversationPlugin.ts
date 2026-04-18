// Proactive Conversation Plugin - schedules group analysis and configures proactive participation (Phase 1)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { hasWhitelistCapability } from '@/context/HookContextHelpers';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import { PluginCommandHandler } from '../PluginCommandHandler';
import { WHITELIST_CAPABILITY } from './whitelistCapabilities';

/** Template name pattern for trigger words: prompts/preference/{preferenceKey}/trigger.txt (one word per line). */
const TRIGGER_TEMPLATE_SUFFIX = '.trigger';
/** File path for persisting cooldown state across restarts. */
const COOLDOWN_STATE_FILE = 'data/proactive-cooldown.json';

export interface ProactiveConversationPluginConfig {
  /** Groups that have proactive analysis enabled. Same groupId can appear multiple times with different preferenceKey (multiple preferences per group). */
  groups?: Array<{ groupId: string; preferenceKey: string }>;
  /** LLM provider name for preliminary analysis (e.g. "doubao", "deepseek"). Must be registered in ai.providers. Required if not set in taskProviders.lite or defaultProviders.llm. */
  analysisProvider?: string;
  /** Default cooldown duration in minutes when /proactive cooldown is used without explicit duration. Default: 30. */
  cooldownDefaultMinutes?: number;
}

@RegisterPlugin({
  name: 'proactiveConversation',
  version: '1.0.0',
  description: 'Proactive conversation: analyze group messages, create thread, and reply without @ when in thread',
})
export class ProactiveConversationPlugin extends PluginBase {
  private groupIds = new Set<string>();
  /** groupId -> preferenceKeys[] (each group can have multiple preferences). */
  private groupPreferenceKeys = new Map<string, string[]>();
  /** preferenceKey -> trigger words from prompts/preference/{preferenceKey}/trigger.txt (one word per line). */
  private triggerWords: Record<string, string[]> = {};
  private triggerAccumulator: Record<string, number> = {};
  private accumulatorThreshold = 30;
  /** Default cooldown duration in minutes. */
  private cooldownDefaultMinutes = 30;
  /** groupId -> cooldown expiry timestamp (ms). While active, proactive analysis is suppressed. */
  private cooldownUntil = new Map<string, number>();

  private proactiveConversationService!: ProactiveConversationService;
  private threadService!: ThreadService;
  private commandManager!: CommandManager;

  /**
   * Parse template content into trigger words: one per line, skip empty and # lines.
   */
  private parseTriggerWordsContent(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  /**
   * Load trigger words for one preference from prompts/preference/{preferenceKey}/trigger.txt via PromptManager.
   * Template name is "{preferenceKey}${TRIGGER_TEMPLATE_SUFFIX}".
   */
  private loadTriggerWordsForPreference(promptManager: PromptManager, preferenceKey: string): void {
    const templateName = `${preferenceKey}${TRIGGER_TEMPLATE_SUFFIX}`;
    const template = promptManager.getTemplate(templateName);
    if (!template?.content) {
      return;
    }
    const words = this.parseTriggerWordsContent(template.content);
    this.triggerWords[preferenceKey] = words;
    logger.info(
      `[ProactiveConversationPlugin] Loaded ${words.length} trigger words for preference "${preferenceKey}" from preference/${preferenceKey}/trigger.txt`,
    );
  }

  /**
   * Get all trigger words for a group (union of trigger words of all its preference keys).
   */
  private getTriggerWordsForGroup(groupId: string): string[] {
    const preferenceKeys = this.groupPreferenceKeys.get(groupId) ?? [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const key of preferenceKeys) {
      const words = this.triggerWords[key] ?? [];
      for (const w of words) {
        if (!seen.has(w)) {
          seen.add(w);
          result.push(w);
        }
      }
    }
    return result;
  }

  async onInit(): Promise<void> {
    this.enabled = true;

    // Get dependencies from DI container
    const container = getContainer();
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
    this.proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );
    if (!this.proactiveConversationService) {
      throw new Error('[ProactiveConversationPlugin] ProactiveConversationService not found');
    }
    if (!this.threadService) {
      throw new Error('[ProactiveConversationPlugin] ThreadService not found');
    }

    const pluginConfig = this.pluginConfig?.config as ProactiveConversationPluginConfig | undefined;
    if (pluginConfig?.groups && Array.isArray(pluginConfig.groups)) {
      this.proactiveConversationService.setGroupConfig(pluginConfig.groups);
      this.groupIds = new Set(pluginConfig.groups.map((g) => g.groupId));
      // Build groupId -> preferenceKeys[] and load trigger words per preference from prompts/preference/{key}/trigger.txt
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
      const preferenceKeysSeen = new Set<string>();
      for (const g of pluginConfig.groups) {
        const list = this.groupPreferenceKeys.get(g.groupId) ?? [];
        if (!list.includes(g.preferenceKey)) {
          list.push(g.preferenceKey);
        }
        this.groupPreferenceKeys.set(g.groupId, list);
        this.triggerAccumulator[g.groupId] = 0;
        if (promptManager && !preferenceKeysSeen.has(g.preferenceKey)) {
          preferenceKeysSeen.add(g.preferenceKey);
          this.loadTriggerWordsForPreference(promptManager, g.preferenceKey);
        }
      }
      logger.info(`[ProactiveConversationPlugin] Enabled for groups: ${Array.from(this.groupIds).join(', ')}`);
    }
    // Resolve analysis provider: plugin config > taskProviders.lite > defaultProviders.llm
    const config = container.resolve<Config>(DITokens.CONFIG);
    const aiConfig = config.getAIConfig();
    const analysisProvider =
      pluginConfig?.analysisProvider ?? aiConfig?.taskProviders?.lite ?? aiConfig?.defaultProviders?.llm;
    if (!analysisProvider) {
      logger.warn(
        '[ProactiveConversationPlugin] No analysis provider configured (set plugin analysisProvider, taskProviders.lite, or defaultProviders.llm)',
      );
    } else {
      this.proactiveConversationService.setAnalysisProvider(analysisProvider);
      logger.info(`[ProactiveConversationPlugin] Analysis and reply provider: ${analysisProvider}`);
    }

    // Cooldown config
    if (pluginConfig?.cooldownDefaultMinutes != null && pluginConfig.cooldownDefaultMinutes > 0) {
      this.cooldownDefaultMinutes = pluginConfig.cooldownDefaultMinutes;
    }

    // Register /proactive command
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);
    const proactiveCommandHandler = new PluginCommandHandler(
      'proactive',
      'Manage proactive conversation. Subcommands: cooldown [minutes] — mute proactive for N minutes (default from config); resume — lift cooldown immediately.',
      '/proactive cooldown [minutes] | /proactive resume',
      async (args: string[], context: CommandContext): Promise<CommandResult> => {
        return this.executeProactiveCommand(args, context);
      },
      this.context,
      ['admin'],
    );
    this.commandManager.register(proactiveCommandHandler, 'proactiveConversation');

    // Restore persisted cooldown state
    await this.loadCooldownState();
  }

  /**
   * Check whether a group is currently in cooldown (proactive analysis suppressed).
   */
  private isInCooldown(groupId: string): boolean {
    const until = this.cooldownUntil.get(groupId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldownUntil.delete(groupId);
      this.saveCooldownState();
      return false;
    }
    return true;
  }

  /** Load cooldown state from disk, pruning expired entries. */
  private async loadCooldownState(): Promise<void> {
    try {
      const path = join(getRepoRoot(), COOLDOWN_STATE_FILE);
      const raw = await readFile(path, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [groupId, until] of Object.entries(data)) {
        if (until > now) {
          this.cooldownUntil.set(groupId, until);
        }
      }
      if (this.cooldownUntil.size > 0) {
        logger.info(`[ProactiveConversationPlugin] Restored cooldown for ${this.cooldownUntil.size} group(s)`);
      }
    } catch {
      // File doesn't exist or invalid — start fresh
    }
  }

  /** Persist current cooldown state to disk. */
  private async saveCooldownState(): Promise<void> {
    try {
      const path = join(getRepoRoot(), COOLDOWN_STATE_FILE);
      await mkdir(dirname(path), { recursive: true });
      const data: Record<string, number> = {};
      for (const [groupId, until] of this.cooldownUntil) {
        data[groupId] = until;
      }
      await writeFile(path, JSON.stringify(data), 'utf-8');
    } catch (err) {
      logger.warn('[ProactiveConversationPlugin] Failed to save cooldown state:', err);
    }
  }

  /**
   * /proactive command handler.
   */
  private executeProactiveCommand(args: string[], context: CommandContext): CommandResult {
    const sub = args[0]?.toLowerCase();
    const groupId = context.groupId?.toString();

    if (!groupId) {
      return { success: false, error: '此命令仅在群聊中可用' };
    }

    if (sub === 'cooldown' || sub === 'cd') {
      const minutes = args[1] ? Number.parseInt(args[1], 10) : this.cooldownDefaultMinutes;
      if (Number.isNaN(minutes) || minutes <= 0) {
        return { success: false, error: `无效的时间: ${args[1]}，请提供正整数（分钟）` };
      }
      const until = Date.now() + minutes * 60_000;
      this.cooldownUntil.set(groupId, until);
      this.saveCooldownState();
      const expireTime = new Date(until).toLocaleTimeString('zh-CN', { hour12: false });
      logger.info(`[ProactiveConversationPlugin] Cooldown activated | group=${groupId} duration=${minutes}min`);
      return {
        success: true,
        segments: [
          {
            type: 'text',
            data: {
              text: `主动对话已静默 ${minutes} 分钟，将于 ${expireTime} 自动恢复。使用 /proactive resume 可提前解除。`,
            },
          },
        ],
      };
    }

    if (sub === 'resume') {
      const wasCooling = this.cooldownUntil.has(groupId);
      this.cooldownUntil.delete(groupId);
      this.saveCooldownState();
      logger.info(`[ProactiveConversationPlugin] Cooldown lifted | group=${groupId} wasCooling=${wasCooling}`);
      return {
        success: true,
        segments: [{ type: 'text', data: { text: wasCooling ? '主动对话已恢复。' : '当前没有处于静默状态。' } }],
      };
    }

    // Show current status
    const cooling = this.isInCooldown(groupId);
    const until = this.cooldownUntil.get(groupId);
    const statusText =
      cooling && until
        ? `主动对话静默中，恢复时间: ${new Date(until).toLocaleTimeString('zh-CN', { hour12: false })}`
        : '主动对话正常运行中';
    return {
      success: true,
      segments: [
        { type: 'text', data: { text: `${statusText}\n用法: /proactive cooldown [分钟] | /proactive resume` } },
      ],
    };
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 20,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.enabled) return true;
    const inProactive = context.metadata.get('inProactiveThread');
    const groupId = context.message?.groupId?.toString();
    if (!inProactive || !groupId) return true;

    const currentThreadId = this.threadService.getCurrentThreadId(groupId);
    if (currentThreadId) {
      logger.debug(`[ProactiveConversationPlugin] Current thread id: ${currentThreadId}`);
      context.metadata.set('proactiveThreadId', currentThreadId);
    }
    return true;
  }

  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 10,
  })
  onMessageComplete(context: HookContext): HookResult {
    if (!this.enabled || this.groupIds.size === 0) return true;

    // Do not schedule proactive when access denied. Proactive does not use postProcessOnly: "no direct reply" still allows proactive in whitelist groups.
    if (context.metadata.get('whitelistDenied')) {
      return true;
    }
    // Limited-permission groups: require proactive capability to schedule.
    if (!hasWhitelistCapability(context, WHITELIST_CAPABILITY.proactive)) {
      return true;
    }

    const messageType = context.message?.messageType;
    const groupId = context.message?.groupId?.toString();
    if (messageType !== 'group' || !groupId) return true;

    if (!this.groupIds.has(groupId)) return true;

    // Do not trigger analysis on bot's own messages (avoid repeated proactive replies)
    const botSelfId = context.metadata.get('botSelfId');
    // Trigger userId = current message sender (from pipeline event -> hook context.message)
    const triggerUserId = context.message.userId.toString();
    if (botSelfId && triggerUserId === botSelfId) return true;

    // Do not run proactive analysis when the message already triggered direct reply.
    if (context.metadata.get('replyTriggerType')) {
      return true;
    }

    // Do not run proactive analysis for command messages; command uses its own send path and should not trigger LLM.
    if (context.command) {
      return true;
    }

    // Cooldown: suppress all proactive analysis (accumulator + trigger words) but not wake words / commands / direct triggers
    if (this.isInCooldown(groupId)) {
      return true;
    }

    // When thread is still active and this message is from the user who opened that thread, treat as triggered and run analysis directly (no trigger-word check or accumulator).
    const currentThread = this.threadService.getActiveThread(groupId);
    if (currentThread?.triggerUserId && currentThread.triggerUserId === triggerUserId) {
      this.proactiveConversationService.scheduleForGroup(groupId, triggerUserId);
      return true;
    }

    // if trigger words (from any of this group's preferences) are matched, schedule analysis directly
    const triggerWords = this.getTriggerWordsForGroup(groupId);
    if (
      triggerWords.length > 0 &&
      triggerWords.some((word) => context.message?.message?.toLowerCase().includes(word))
    ) {
      this.proactiveConversationService.scheduleForGroup(groupId, triggerUserId);
    } else {
      // if trigger words are not matched, accumulate trigger count
      this.triggerAccumulator[groupId] += 1;
      if (this.triggerAccumulator[groupId] >= this.accumulatorThreshold) {
        this.proactiveConversationService.scheduleForGroup(groupId, triggerUserId, true);
        this.triggerAccumulator[groupId] = 0;
      }
    }
    return true;
  }
}
