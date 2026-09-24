// The comic follow-up of a group report.
//
// One subagent, one user message: the same stats-and-chat prefix the report
// call already sent, then the drawing task. It decides the pictures and calls
// generate_image itself. This module does not call the image provider.

import { SubAgentType } from '@/agent/types';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { ImageRequestAssembler } from '@/ai/services/ImageRequestAssembler';
import { logger } from '@/utils/logger';
import { withTaskSuffix } from './reportPrompt';

const TASK_TEMPLATE = 'subagent.group_report.comic';
const SYSTEM_TEMPLATE = 'subagent.group_report.system';

export interface DrawReportComicParams {
  aiService: AIService;
  promptManager: PromptManager;
  groupId: string;
  userId: number | string;
  protocol?: string;
  /** Rendered report prefix (stats + chat log), with no task text. */
  promptPrefix: string;
  /** Preset ids named by the schedule. Unknown ids are dropped. */
  presetIds: string[];
  providerName?: string;
}

/**
 * Spawn the drawing agent. Returns the agent's closing line (a short caption),
 * or '' when there is nothing to draw or no usable preset.
 */
export async function drawReportComic(params: DrawReportComicParams): Promise<string> {
  const presetIds = resolveComicPresetIds(params.presetIds);
  if (presetIds.length === 0 || !params.promptPrefix) {
    if (presetIds.length > 0 && !params.promptPrefix) {
      logger.info(`[ReportComic] Group ${params.groupId}: no chat prefix, skipping`);
    }
    return '';
  }

  const task = params.promptManager.render(TASK_TEMPLATE, {
    presetIds: JSON.stringify(presetIds),
  });
  const description = withTaskSuffix(params.promptPrefix, task);

  const caption = await params.aiService.runSubAgent(
    SubAgentType.TASK_EXECUTION,
    {
      description,
      input: {},
      parentContext: {
        userId: params.userId,
        groupId: params.groupId,
        messageType: 'group',
        protocol: params.protocol,
      },
    },
    {
      systemTemplate: SYSTEM_TEMPLATE,
      timeout: 240_000,
      maxToolRounds: null,
      inheritSoul: false,
      inheritMemory: false,
      inheritPreference: false,
      ...(params.providerName ? { providerName: params.providerName } : {}),
    },
  );

  return caption.trim();
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
