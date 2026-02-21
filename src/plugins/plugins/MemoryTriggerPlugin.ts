// Memory Trigger Plugin - on trigger phrase (e.g. bot name), update user memory then send standalone "记忆已更新" after update completes

import type { MessageAPI } from '@/api/methods/MessageAPI';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import type { MemoryExtractService } from '@/memory';
import type { MemoryService } from '@/memory/MemoryService';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';
import type { PluginManager } from '../PluginManager';
import type { MemoryPlugin } from './MemoryPlugin';

export interface MemoryTriggerPluginConfig {
  /** Group IDs where trigger-to-remember is enabled (should match memory-enabled groups). */
  groups?: string[];
  /** Bot name or trigger phrase at start of message (e.g. "cygnus"). Case-insensitive match after trim. */
  triggerName?: string;
  /** Optional: only treat as "remember" when message also contains one of these (e.g. ["记住", "请记住"]). */
  triggerKeywords?: string[];
}

@Plugin({
  name: 'memoryTrigger',
  version: '1.0.0',
  description: 'Memory trigger: on trigger phrase (e.g. bot name), write user message as user memory and continue to reply',
})
export class MemoryTriggerPlugin extends PluginBase {
  private groupIds = new Set<string>();
  private triggerName = '';
  private triggerKeywords: string[] = [];

  private memoryService!: MemoryService;
  private memoryExtractService!: MemoryExtractService;
  private pluginManager!: PluginManager;
  private messageAPI!: MessageAPI;

  async onInit(): Promise<void> {
    this.enabled = true;
    const container = getContainer();
    this.memoryService = container.resolve<MemoryService>(DITokens.MEMORY_SERVICE);
    this.memoryExtractService = container.resolve<MemoryExtractService>(DITokens.MEMORY_EXTRACT_SERVICE);
    this.pluginManager = container.resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    this.messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);

    const pluginConfig = this.pluginConfig?.config as MemoryTriggerPluginConfig | undefined;
    if (pluginConfig?.groups?.length) {
      this.groupIds = new Set(pluginConfig.groups);
      this.triggerName = (pluginConfig.triggerName ?? '').trim();
      this.triggerKeywords = Array.isArray(pluginConfig.triggerKeywords) ? pluginConfig.triggerKeywords : [];
      logger.info(`[MemoryTriggerPlugin] Enabled for groups: ${Array.from(this.groupIds).join(', ')} triggerName=${this.triggerName}`);
    }
  }

  /**
   * Check if message is a "remember" trigger: starts with triggerName (or contains triggerKeyword) and has content after it.
   */
  private isTriggerMessage(message: string): boolean {
    const raw = (message ?? '').trim();
    if (!raw) {
      return false;
    }
    if (this.triggerName) {
      const lower = raw.toLowerCase();
      const name = this.triggerName.toLowerCase();
      if (lower.startsWith(name)) {
        const after = raw.slice(this.triggerName.length).trim();
        if (after.length > 0) {
          return true;
        }
      }
    }
    if (this.triggerKeywords.length > 0 && this.triggerKeywords.some((k) => raw.includes(k))) {
      return true;
    }
    return false;
  }

  /**
   * Extract content to remember: strip trigger name (and optional comma/space) from start.
   */
  private extractContentToRemember(message: string): string {
    let rest = (message ?? '').trim();
    if (this.triggerName) {
      const lower = rest.toLowerCase();
      const name = this.triggerName.toLowerCase();
      if (lower.startsWith(name)) {
        rest = rest.slice(this.triggerName.length).replace(/^[\s,，、]+/, '').trim();
      }
    }
    return rest;
  }

  /**
   * Merge new content with existing user memory and upsert.
   * @returns Promise that resolves when update is done (for sending "记忆已更新" after)
   */
  private mergeAndUpsertUserMemory(groupId: string, userId: string, content: string): Promise<void> {
    const existing = this.memoryService.getUserMemoryText(groupId, userId);
    return this.memoryExtractService
      .mergeWithExisting(existing, content)
      .then((merged) => {
        if (merged) {
          return this.memoryService.upsertMemory(groupId, userId, false, merged);
        }
      })
      .then(() => {
        logger.debug(`[MemoryTriggerPlugin] Merged and updated user memory for group=${groupId} user=${userId}`);
      })
      .catch((err) => {
        logger.warn('[MemoryTriggerPlugin] merge/upsert failed:', err);
      });
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 25,
  })
  onMessagePreprocess(context: HookContext): boolean {
    if (!this.enabled || this.groupIds.size === 0 || !this.memoryService) {
      return true;
    }
    const sessionType = context.metadata.get('sessionType');
    const groupId = context.message?.groupId?.toString();
    if (sessionType !== 'group' || !groupId || !this.groupIds.has(groupId)) {
      return true;
    }
    const message = context.message?.message ?? '';
    if (!this.isTriggerMessage(message)) {
      return true;
    }
    const content = this.extractContentToRemember(message);
    if (!content) {
      return true;
    }
    const userId = context.message?.userId?.toString();
    if (!userId) {
      return true;
    }
    // When update finishes, send standalone "记忆已更新" (current message may or may not get pipeline reply)
    const sendContext = context.message;
    this.mergeAndUpsertUserMemory(groupId, userId, content)
      .then(() => {
        return this.messageAPI.sendFromContext(`用户 ${userId} 的记忆已更新。`, sendContext, 10000);
      })
      .then(() => {
        logger.debug(`[MemoryTriggerPlugin] Sent "记忆已更新" for group=${groupId} user=${userId}`);
      })
      .catch((err) => {
        logger.warn('[MemoryTriggerPlugin] send "记忆已更新" failed:', err);
      });
    // Schedule full-history extract for this user; runs in same queue as normal extract (queued if extract already running)
    const memoryPlugin = this.pluginManager.getPluginAs<MemoryPlugin>('memory');
    if (memoryPlugin) {
      memoryPlugin.runFullHistoryExtractForUser(groupId, userId);
    }
    return true;
  }
}
