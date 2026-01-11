// Message-related hook types

import type { HookContext, HookResult } from './types';

/**
 * Message-related hooks
 */
export interface MessageHooks {
  /**
   * Hook: onMessageReceived
   * Triggered when message is received, before any processing
   */
  onMessageReceived?(context: HookContext): HookResult;

  /**
   * Hook: onMessagePreprocess
   * Triggered during message preprocessing, before command detection
   */
  onMessagePreprocess?(context: HookContext): HookResult;

  /**
   * Hook: onMessageBeforeSend
   * Triggered before sending message
   */
  onMessageBeforeSend?(context: HookContext): HookResult;

  /**
   * Hook: onMessageSent
   * Triggered after message is sent
   */
  onMessageSent?(context: HookContext): HookResult;
}
