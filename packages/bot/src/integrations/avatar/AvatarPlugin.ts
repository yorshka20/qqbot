// Live2D Avatar Plugin — drives a VTubeStudio-connected Live2D avatar based on
// pipeline lifecycle events and LLM emotion tags.

import type { AvatarService } from '@qqbot/avatar';
import { parseLive2DTags, stripLive2DTags } from '@qqbot/avatar';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';

/**
 * Ambient-gain presets keyed to pipeline phase. Lower values suppress the
 * continuous layer stack (breath / blink / gaze / idle-motion) so discrete
 * pose + tag animations dominate visually. 1.0 = full ambient life.
 *
 * These replace the old `DEFAULT_LAYER_GATE` lookup table. Numbers preserve
 * the earlier calibration — `speaking` at 0.3 so lip-sync and tag animations
 * read clearly, `thinking` at 0.5 for a calmer pose.
 */
const AMBIENT = {
  FULL: 1.0,
  LISTENING: 0.8,
  THINKING: 0.5,
  SPEAKING: 0.3,
} as const;

@RegisterPlugin({
  name: 'avatar',
  version: '1.0.0',
  description: 'Drives a VTubeStudio-connected Live2D avatar based on bot state and LLM emotion tags',
})
export class AvatarPlugin extends PluginBase {
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
   * Avatar activity changes are gated to private (DM) messages only.
   * Group chatter is still processed normally by the pipeline, but the
   * avatar stays in neutral/full-ambient so streaming viewers don't see it
   * twitch for every group message the bot reads.
   */
  private isPrivate(context: HookContext): boolean {
    return context.message?.messageType === 'private';
  }

  @Hook({ stage: 'onMessageReceived', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onMessageReceived(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.setActivity({ pose: 'listening', ambientGain: AMBIENT.LISTENING });
    } catch (err) {
      logger.warn('[AvatarPlugin] onMessageReceived setActivity failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationStart', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onAIGenerationStart(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.setActivity({ pose: 'thinking', ambientGain: AMBIENT.THINKING });
    } catch (err) {
      logger.warn('[AvatarPlugin] onAIGenerationStart setActivity failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onAIGenerationComplete', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onAIGenerationComplete(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      const text = context.aiResponse;
      if (text) {
        const tags = parseLive2DTags(text);
        for (const tag of tags) {
          logger.info(
            `[AvatarPlugin] tag: emotion=${tag.emotion} action=${tag.action} intensity=${tag.intensity}`,
          );
        }
      }
    } catch (err) {
      logger.warn('[AvatarPlugin] onAIGenerationComplete failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageBeforeSend', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onMessageBeforeSend(context: HookContext): Promise<boolean> {
    try {
      // Tag → enqueue requires the plugin to be active AND the message to be
      // private (avatar only reacts to DMs; group chatter doesn't drive the
      // streaming avatar). Pose stays at 'neutral' here — the enqueued tag
      // animation itself is the visible effect, we just drop ambient gain to
      // SPEAKING so the discrete animation reads clearly.
      if (this.active && this.isPrivate(context)) {
        const aiResponse = context.aiResponse;
        if (aiResponse) {
          const tags = parseLive2DTags(aiResponse);
          if (tags.length > 0) {
            this.avatar?.setActivity({ pose: 'neutral', ambientGain: AMBIENT.SPEAKING });
          }
          for (const tag of tags) {
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

      // NOTE: auto-speak on every private AI reply was removed — it triggered
      // the full reply pipeline (including CardRenderingService for long
      // replies, which sent the text as an image). Speech is now opt-in via
      // the `/avatar <text>` command, which handles its own LLM call +
      // plain-text delivery + speak() without going through cardrender.
    } catch (err) {
      logger.warn('[AvatarPlugin] onMessageBeforeSend failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageSent', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onMessageSent(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.setActivity({ pose: 'neutral', ambientGain: AMBIENT.SPEAKING });
    } catch (err) {
      logger.warn('[AvatarPlugin] onMessageSent setActivity failed:', err);
    }
    return true;
  }

  @Hook({ stage: 'onMessageComplete', priority: 'NORMAL', order: 10, applicableSources: ['qq-private'] })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    if (!this.active || !this.isPrivate(context)) return true;
    try {
      this.avatar?.setActivity({ pose: 'neutral', ambientGain: AMBIENT.FULL });
    } catch (err) {
      logger.warn('[AvatarPlugin] onMessageComplete setActivity failed:', err);
    }
    return true;
  }
}
