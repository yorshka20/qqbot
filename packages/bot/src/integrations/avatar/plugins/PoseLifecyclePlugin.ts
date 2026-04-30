// PoseLifecyclePlugin — drives avatar thinking/neutral pose lifecycle for non-IM sources
// (avatar-cmd, bilibili-danmaku, idle-trigger, bootstrap).

import type { AvatarService } from '@qqbot/avatar';
import { getSourceConfig } from '@/conversation/sources/registry';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { Hook, RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { logger } from '@/utils/logger';

@RegisterPlugin({
  name: 'pose-lifecycle',
  version: '1.0.0',
  description: 'Drive avatar thinking/neutral pose lifecycle for non-IM sources',
})
export class PoseLifecyclePlugin extends PluginBase {
  private avatar: AvatarService | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    if (container.isRegistered(DITokens.AVATAR_SERVICE)) {
      this.avatar = container.resolve<AvatarService>(DITokens.AVATAR_SERVICE);
    }
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGH',
    order: 1,
    applicableSources: ['avatar-cmd', 'bilibili-danmaku', 'idle-trigger', 'bootstrap'],
  })
  async onMessagePreprocess(context: HookContext): Promise<boolean> {
    const cfg = getSourceConfig(context.source);
    if (!cfg.poseLifecycle) return true;
    if (!this.avatar?.isActive()) return true;
    try {
      this.avatar.setActivity({ pose: 'thinking' });
    } catch (err) {
      logger.warn('[PoseLifecyclePlugin] setActivity failed:', err);
    }
    return true;
  }

  @Hook({
    stage: 'onMessageComplete',
    priority: 'LOW',
    order: 99,
    applicableSources: ['avatar-cmd', 'bilibili-danmaku', 'idle-trigger', 'bootstrap'],
  })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    const cfg = getSourceConfig(context.source);
    if (!cfg.poseLifecycle) return true;
    if (!this.avatar?.isActive()) return true;
    try {
      this.avatar.setActivity({ pose: 'neutral' });
    } catch (err) {
      logger.warn('[PoseLifecyclePlugin] setActivity failed:', err);
    }
    return true;
  }

  @Hook({
    stage: 'onError',
    priority: 'LOW',
    order: 99,
    applicableSources: ['avatar-cmd', 'bilibili-danmaku', 'idle-trigger', 'bootstrap'],
  })
  async onError(context: HookContext): Promise<boolean> {
    const cfg = getSourceConfig(context.source);
    if (!cfg.poseLifecycle) return true;
    if (!this.avatar?.isActive()) return true;
    try {
      this.avatar.setActivity({ pose: 'neutral' });
    } catch (err) {
      logger.warn('[PoseLifecyclePlugin] setActivity failed:', err);
    }
    return true;
  }
}
