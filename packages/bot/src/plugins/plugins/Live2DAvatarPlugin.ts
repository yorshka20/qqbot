// Live2D Avatar Plugin — drives a VTubeStudio-connected Live2D avatar based on bot state and LLM emotion tags

import type { AvatarService } from '@qqbot/avatar';
import type { BotState } from '@qqbot/avatar';
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
  async onMessageReceived(_context: HookContext): Promise<boolean> {
    if (!this.active) return true;
    try {
      this.avatar?.transition('listening');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageReceived transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationStart', priority: 'NORMAL', order: 10 })
  async onAIGenerationStart(_context: HookContext): Promise<boolean> {
    if (!this.active) return true;
    try {
      this.avatar?.transition('thinking');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onAIGenerationStart transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationComplete', priority: 'NORMAL', order: 10 })
  async onAIGenerationComplete(context: HookContext): Promise<boolean> {
    if (!this.active) return true;
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
    if (!this.active) return true;
    try {
      const aiResponse = context.aiResponse;
      if (aiResponse) {
        const tags = parseLive2DTags(aiResponse);
        for (const tag of tags) {
          const state = this.tagToBotState(tag);
          this.avatar?.transition(state);
        }
      }

      if (context.reply?.source === 'ai' && Array.isArray(context.reply.segments)) {
        for (const seg of context.reply.segments) {
          if (seg.type === 'text' && typeof seg.data?.text === 'string') {
            seg.data.text = stripLive2DTags(seg.data.text);
          }
        }
      }
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageBeforeSend failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageSent', priority: 'NORMAL', order: 10 })
  async onMessageSent(_context: HookContext): Promise<boolean> {
    if (!this.active) return true;
    try {
      this.avatar?.transition('speaking');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageSent transition failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageComplete', priority: 'NORMAL', order: 10 })
  async onMessageComplete(_context: HookContext): Promise<boolean> {
    if (!this.active) return true;
    try {
      this.avatar?.transition('idle');
    } catch (err) {
      logger.warn('[Live2DAvatarPlugin] onMessageComplete transition failed:', err);
    }
    return true;
  }
}
