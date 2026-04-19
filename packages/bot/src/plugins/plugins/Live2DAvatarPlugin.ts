// Live2D Avatar Plugin — drives a VTubeStudio-connected Live2D avatar based on bot state and LLM emotion tags

import type { AvatarService, BotState } from '@qqbot/avatar';
import { type ParsedTag, parseLive2DTags, stripLive2DTags } from '@qqbot/avatar';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

@RegisterPlugin({
  name: 'live2d-avatar',
  version: '1.0.0',
  description: 'Drives a VTubeStudio-connected Live2D avatar based on bot state and LLM emotion tags',
})
export class Live2DAvatarPlugin extends PluginBase {
  private avatar: AvatarService | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (container.isRegistered(DITokens.AVATAR_SERVICE)) {
      this.avatar = container.resolve<AvatarService>(DITokens.AVATAR_SERVICE);
    }
  }

  private get active(): boolean {
    return this.enabled && this.avatar?.isActive() === true;
  }

  /**
   * Avatar transitions are gated to private (DM) messages only.
   * Group chatter is still processed normally by the pipeline, but the
   * avatar stays in idle so streaming viewers don't see it twitch for every
   * group message the bot reads.
   */
  private isPrivate(context: HookContext): boolean {
    return context.message?.messageType === 'private';
  }

  private tagToBotState(tag: ParsedTag): BotState {
    switch (tag.emotion) {
      case 'happy':
      case 'excited':
      case 'surprised':
        return 'reacting';
      case 'thinking':
        return 'thinking';
      case 'sad':
      case 'angry':
      case 'shy':
        return 'reacting';
      default:
        return 'speaking';
    }
  }

  @Hook({ stage: 'onMessageReceived', priority: 'NORMAL', order: 10 })
  async onMessageReceived(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.transition('listening');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageReceived transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationStart', priority: 'NORMAL', order: 10 })
  async onAIGenerationStart(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.transition('thinking');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onAIGenerationStart transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationComplete', priority: 'NORMAL', order: 10 })
  async onAIGenerationComplete(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      const text = context.aiResponse;
      if (text) {
        const tags = parseLive2DTags(text);
        for (const tag of tags) {
          logger.info(
            `[Live2DAvatarPlugin] tag: emotion=${tag.emotion} action=${tag.action} intensity=${tag.intensity}`,
          );
        }
      }
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onAIGenerationComplete failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageBeforeSend', priority: 'NORMAL', order: 10 })
  async onMessageBeforeSend(context: HookContext): Promise<boolean> {
    try {
      // Tag → transition / enqueue requires the plugin to be active AND the
      // message to be private (avatar only reacts to DMs; group chatter
      // doesn't drive the streaming avatar).
      if (this.active && this.isPrivate(context)) {
        const aiResponse = context.aiResponse;
        if (aiResponse) {
          const tags = parseLive2DTags(aiResponse);
          for (const tag of tags) {
            const state = this.tagToBotState(tag);
            this.avatar?.transition(state);
            this.avatar?.enqueueTagAnimation(tag);
          }
        }
      }

      // Strip runs unconditionally (not gated on this.active). Prompt injection
      // happens based on AvatarService.isActive() in PromptAssemblyStage — that
      // gate is independent of whether this plugin is enabled in plugins.jsonc.
      // So even with the plugin disabled we must still scrub tags that the LLM
      // was instructed to emit, or they leak raw to users.
      if (context.reply?.source === 'ai' && Array.isArray(context.reply.segments)) {
        for (const seg of context.reply.segments) {
          if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            seg.data.text = stripLive2DTags(seg.data.text);
          }
        }
      }

      // Speak gate diagnostics: we log once per call so it's obvious when
      // TTS "does nothing" whether it's the plugin gating (active/private/
      // source) or downstream SpeechService (consumer count, provider).
      const active = this.active;
      const priv = this.isPrivate(context);
      const reply = context.reply;
      const src = reply?.source;
      if (!(active && priv && reply && src === 'ai')) {
        logger.debug(
          `[Live2DAvatarPlugin] speak skipped: active=${active} private=${priv} replySource=${src ?? 'none'}`,
        );
      } else {
        const parts: string[] = [];
        for (const seg of reply.segments ?? []) {
          if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            parts.push(seg.data.text);
          }
        }
        const strippedText = parts.join('');
        if (strippedText.length === 0) {
          logger.debug('[Live2DAvatarPlugin] speak skipped: stripped reply text is empty');
        } else if (!this.avatar) {
          logger.debug('[Live2DAvatarPlugin] speak skipped: avatar service not resolved');
        } else {
          logger.info(`[Live2DAvatarPlugin] → avatar.speak(len=${strippedText.length})`);
          this.avatar.speak(strippedText);
        }
      }
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageBeforeSend failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageSent', priority: 'NORMAL', order: 10 })
  async onMessageSent(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.transition('speaking');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageSent transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageComplete', priority: 'NORMAL', order: 10 })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.transition('idle');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageComplete transition failed:', err);
    }
    return true;
  }
}
