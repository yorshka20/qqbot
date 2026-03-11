// Reply System - handles reply generation through unified AI skill-loop flow

import type { AIService } from '@/ai/AIService';
import { hasReply, isNoReplyPath } from '@/context/HookContextHelpers';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';

/**
 * Reply System
 * Handles AI reply generation through a single entry:
 * - Unified skill-loop flow (no legacy task analysis phase)
 */
export class ReplySystem implements System {
  readonly name = 'reply';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS;
  readonly priority = SystemPriority.Task;

  constructor(private aiService: AIService) {}

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    if (this.shouldSkipExecution(context)) {
      return true;
    }

    await this.aiService.generateReplyWithSkills(context);
    return true;
  }

  /** Skip when command handled, reply already set, or postProcessOnly/no-reply path. */
  private shouldSkipExecution(context: HookContext): boolean {
    if (context.command) {
      return true;
    }
    if (hasReply(context)) {
      return true;
    }
    if (isNoReplyPath(context)) {
      return true;
    }
    return false;
  }

  /**
   * Declare extension hooks that plugins can subscribe to.
   * AI-related hooks are executed by AIService/ReplyGenerationService during reply generation.
   */
  getExtensionHooks() {
    return [
      {
        hookName: 'onMessageBeforeAI',
        priority: getHookPriority('onMessageBeforeAI', 'NORMAL'),
      },
      {
        hookName: 'onAIGenerationStart',
        priority: getHookPriority('onAIGenerationStart', 'NORMAL'),
      },
      {
        hookName: 'onAIGenerationComplete',
        priority: getHookPriority('onAIGenerationComplete', 'NORMAL'),
      },
    ];
  }
}
