// ActionHandlerRegistry - registry for direct action handlers invoked by schedule items
// with actionType === 'action'. Handlers execute code directly without LLM involvement.

import type { ProtocolName } from '@/core/config/types/protocol';
import { logger } from '@/utils/logger';
import type { AgendaEventContext, AgendaItem } from './types';

/** Context passed to action handlers when executed */
export interface ActionHandlerContext {
  item: AgendaItem;
  eventContext: AgendaEventContext;
  groupId?: string;
  userId?: string;
  protocol: ProtocolName;
}

/** Action handler interface — implement this to register a direct action */
export interface ActionHandler {
  readonly name: string;
  execute(ctx: ActionHandlerContext): Promise<string | void>;
}

/**
 * Registry of named action handlers.
 * Schedule items with `actionType: 'action'` and `actionTarget: '<name>'`
 * are dispatched to the matching handler.
 */
export class ActionHandlerRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(handler: ActionHandler): void {
    if (this.handlers.has(handler.name)) {
      logger.warn(`[ActionHandlerRegistry] Overwriting handler: ${handler.name}`);
    }
    this.handlers.set(handler.name, handler);
    logger.debug(`[ActionHandlerRegistry] Registered handler: ${handler.name}`);
  }

  get(name: string): ActionHandler | undefined {
    return this.handlers.get(name);
  }

  getNames(): string[] {
    return [...this.handlers.keys()];
  }
}
