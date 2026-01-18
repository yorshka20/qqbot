// Text2Img SFW Filter Plugin
// Forces specific users to use SFW template for text2img commands

import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface Text2ImgSFWFilterPluginConfig {
  // User IDs that should be forced to use SFW template for text2img commands
  sfwUserIds?: number[];
}

@Plugin({
  name: 'text2imgSfwFilter',
  version: '1.0.0',
  description: 'Forces specific users to use SFW template for text2img commands',
})
export class Text2ImgSFWFilterPlugin extends PluginBase {
  private sfwUserIds: Set<number> = new Set();

  async onInit(): Promise<void> {
    // Load plugin-specific configuration
    try {
      const pluginConfig = this.pluginConfig?.config as Text2ImgSFWFilterPluginConfig | undefined;

      if (!pluginConfig) {
        logger.info('[Text2ImgSFWFilterPlugin] No config provided, plugin disabled');
        this.enabled = false;
        return;
      }

      // Load SFW user IDs
      if (pluginConfig.sfwUserIds && Array.isArray(pluginConfig.sfwUserIds)) {
        this.sfwUserIds = new Set(pluginConfig.sfwUserIds);
        logger.info(
          `[Text2ImgSFWFilterPlugin] Loaded SFW user IDs: ${Array.from(this.sfwUserIds).join(', ')}`,
        );
        this.enabled = true;
      } else {
        logger.info('[Text2ImgSFWFilterPlugin] No SFW user IDs configured, plugin disabled');
        this.enabled = false;
      }
    } catch (error) {
      logger.error('[Text2ImgSFWFilterPlugin] Error loading config:', error);
      this.enabled = false;
    }
  }

  /**
   * Hook: onMessagePreprocess
   * Check if message is a text2img command from SFW user, set template name in metadata
   */
  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 20, // Run after whitelist plugin but before command routing
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.enabled || this.sfwUserIds.size === 0) {
      return true;
    }

    const userId = context.message.userId;
    if (!userId) {
      return true;
    }

    // Check if user is in SFW list
    if (!this.sfwUserIds.has(userId)) {
      return true;
    }

    // Check if message is a text2img command
    // Support all text2img commands: t2i, text2img, nai, nai-plus, banana, banana-pro
    const messageText = context.message.message?.trim() || '';
    const text2imgCommandPrefixes = [
      '/t2i ',
      '!t2i ',
      '/text2img ',
      '!text2img ',
      '/nai ',
      '!nai ',
      '/nai-plus ',
      '!nai-plus ',
      '/banana ',
      '!banana ',
      '/banana-pro ',
      '!banana-pro ',
      '/小香蕉 ',
      '!小香蕉 ',
      '/大香蕉 ',
      '!大香蕉 ',
    ];
    
    const isText2ImgCommand = text2imgCommandPrefixes.some((prefix) => messageText.startsWith(prefix));

    if (isText2ImgCommand) {
      // Set template name in conversation context metadata
      if (!context.context.metadata) {
        context.context.metadata = new Map();
      }
      context.context.metadata.set('text2imgTemplateName', 'text2img.generate_sfw');
      // For commands that skip LLM preprocessing (like /nai), force enable LLM preprocessing
      context.context.metadata.set('text2imgForceLLMProcess', true);
      logger.info(
        `[Text2ImgSFWFilterPlugin] User ${userId} detected, forcing SFW template for text2img command`,
      );
    }

    return true;
  }
}
