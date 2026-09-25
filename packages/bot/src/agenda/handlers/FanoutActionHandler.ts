// FanoutActionHandler — `执行: action fanout`, the scheduled trigger for every fan-out.
//
//   - 参数: `{"fanout":"group_day","tasks":{"report":{},"mines":{"count":3},"memory":{}}}`
//
// The item's chat is the target; `tasks` maps each task to its own parameters and is
// handed to the fan-out untouched. Tasks deliver their own output, so this returns
// nothing for the agenda to send.

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { FanoutManager } from '@/fanout/core/FanoutManager';
import type { FanoutTarget } from '@/fanout/core/types';
import { logger } from '@/utils/logger';
import type { ActionHandler, ActionHandlerContext } from '../ActionHandlerRegistry';

interface FanoutActionParams {
  fanout: string;
  tasks: Record<string, unknown>;
}

@injectable()
export class FanoutActionHandler implements ActionHandler {
  readonly name = 'fanout';

  constructor(@inject(DITokens.FANOUT_MANAGER) private readonly fanoutManager: FanoutManager) {}

  async execute(ctx: ActionHandlerContext): Promise<string | undefined> {
    const params = parseParams(ctx.item.actionParams);
    if (!params) {
      logger.error(`[FanoutActionHandler] Item "${ctx.item.name}": 参数 must be {"fanout": name, "tasks": {…}}`);
      return;
    }
    const fanout = this.fanoutManager.getByName(params.fanout);
    if (!fanout) {
      logger.error(`[FanoutActionHandler] Item "${ctx.item.name}": no fanout named ${params.fanout}`);
      return;
    }
    const target = resolveTarget(ctx);
    if (!target) {
      logger.error(`[FanoutActionHandler] Item "${ctx.item.name}": needs a group or user to run in`);
      return;
    }

    const report = await fanout.run(target, params.tasks);
    const detail = report.status === 'ran' ? ` ${report.tasks.map((t) => `${t.name}=${t.status}`).join(' ')}` : '';
    logger.info(`[FanoutActionHandler] ${params.fanout} for ${target.chat}:${target.id}: ${report.status}${detail}`);
  }
}

function parseParams(raw: string | undefined): FanoutActionParams | null {
  if (!raw) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<FanoutActionParams>;
    if (typeof data.fanout !== 'string' || !data.tasks || typeof data.tasks !== 'object') {
      return null;
    }
    return { fanout: data.fanout, tasks: data.tasks };
  } catch {
    return null;
  }
}

function resolveTarget(ctx: ActionHandlerContext): FanoutTarget | null {
  if (ctx.groupId) {
    return { chat: 'group', id: ctx.groupId, name: `群${ctx.groupId}`, protocol: ctx.protocol };
  }
  if (ctx.userId) {
    return { chat: 'private', id: ctx.userId, name: ctx.userId, protocol: ctx.protocol };
  }
  return null;
}
