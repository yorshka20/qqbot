// The daily comic as a group_day task.
//
// The model decides what to draw from the day's log and calls generate_image itself,
// which posts each picture to the group. Its closing line, if any, is the caption.

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { ImageRequestAssembler } from '@/ai/services/ImageRequestAssembler';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun, FanoutTask, FanoutTaskOutput } from '@/fanout/core/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { asArray, asObject } from './normalizeReport';

const TASK_TEMPLATE = 'fanout.group_day.tasks.comic';

export interface ComicTaskParams {
  /** Image preset ids that exist on disk, in the order the schedule named them */
  presets: string[];
}

export interface ComicTaskDeps {
  promptManager: PromptManager;
  messageAPI: MessageAPI;
  historyService: ConversationHistoryService;
  botSelfId: string;
  /** messageTrigger.wakeWords: how the group addresses the bot in the log. */
  wakeWords: string[];
}

export class ComicTask implements FanoutTask<GroupDayContext, ComicTaskParams> {
  static readonly NAME = 'comic';
  readonly name = ComicTask.NAME;
  readonly tools = ['generate_image'];
  readonly limits = { maxTokens: TOKEN_BUDGET.document, timeout: 240_000, maxToolRounds: 4 };

  constructor(private readonly deps: ComicTaskDeps) {}

  parseParams(raw: unknown): ComicTaskParams {
    const requested = asArray(asObject(raw).presets).filter((v): v is string => typeof v === 'string');
    const presets = resolveComicPresetIds(requested);
    if (presets.length === 0) {
      throw new Error('comic needs at least one known image preset id in `presets`');
    }
    return { presets };
  }

  suffix(_run: FanoutRun<GroupDayContext>, params: ComicTaskParams): string {
    const triggerWords = [...new Set(this.deps.wakeWords.map((word) => word.trim()).filter(Boolean))]
      .map((word) => `「${word}」`)
      .join('、');
    return this.deps.promptManager.render(TASK_TEMPLATE, {
      presetIds: JSON.stringify(params.presets),
      triggerWords,
    });
  }

  async handle(output: FanoutTaskOutput, run: FanoutRun<GroupDayContext>): Promise<void> {
    const imageCalls = output.toolCalls.filter((c) => c.tool === 'generate_image').length;
    logger.info(`[ReportComic] Group ${run.ctx.groupId}: ${imageCalls} generate_image call(s)`);
    const caption = output.text.trim();
    if (imageCalls === 0 || !caption) {
      return;
    }
    const { protocol } = run.target;
    const messageSeq = await this.deps.messageAPI.sendGroupMessage(
      Number(run.ctx.groupId),
      new MessageBuilder().text(caption).build(),
      protocol,
    );
    await this.deps.historyService.appendBotReplyToGroup(run.ctx.groupId, caption, protocol, {
      botUserId: Number(this.deps.botSelfId),
      messageSeq,
    });
  }
}

/** Keep only preset ids that exist on disk, in the requested order. */
export function resolveComicPresetIds(requested: string[]): string[] {
  const known = new Set(ImageRequestAssembler.list().map((preset) => preset.id));
  const ids: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (!known.has(id)) {
      dropped.push(id);
      continue;
    }
    ids.push(id);
  }
  if (dropped.length > 0) {
    logger.warn(`[ReportComic] Unknown image preset(s), skipped: ${dropped.join(', ')}`);
  }
  return ids;
}
