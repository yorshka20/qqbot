// Keyword mines — onMessage watches planted from yesterday's chat, as a group_day task.
//
// A mine is a keyword the group used yesterday plus the background the bot will need
// when someone brings it up again. The model picks candidates straight from the day's
// log in the shared prefix, and every keyword is checked against yesterday's messages
// with the same text extraction the trigger uses, so a mine that could never fire is
// never planted.

import type { AgendaService } from '@/agenda/AgendaService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun, FanoutTask, FanoutTaskOutput } from '@/fanout/core/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { asObject } from './normalizeReport';

const TASK_TEMPLATE = 'fanout.group_day.tasks.mines';
const DEFAULT_COUNT = 3;
/** Candidates requested beyond `count`, to absorb the ones verbatim validation drops */
const CANDIDATE_SLACK = 4;
const MINE_TTL_MS = 24 * 3600_000;

export interface MineCandidate {
  keyword: string;
  prompt: string;
}

export interface KeywordMinesParams {
  count: number;
}

export interface KeywordMinesTaskDeps {
  promptManager: PromptManager;
  agendaService: AgendaService;
  /** Owner recorded on the created items: the bot itself */
  botSelfId: string;
}

export class KeywordMinesTask implements FanoutTask<GroupDayContext, KeywordMinesParams> {
  static readonly NAME = 'mines';
  readonly name = KeywordMinesTask.NAME;
  readonly tools = [];
  readonly limits = { maxTokens: TOKEN_BUDGET.document, timeout: 240_000, maxToolRounds: 1 };

  constructor(private readonly deps: KeywordMinesTaskDeps) {}

  parseParams(raw: unknown): KeywordMinesParams {
    const count = asObject(raw).count;
    if (count === undefined) {
      return { count: DEFAULT_COUNT };
    }
    if (typeof count !== 'number' || count < 1) {
      throw new Error('mines.count must be a positive number');
    }
    return { count: Math.floor(count) };
  }

  suffix(_run: FanoutRun<GroupDayContext>, params: KeywordMinesParams): string {
    return this.deps.promptManager.render(TASK_TEMPLATE, {
      count: String(params.count),
      candidateCount: String(params.count + CANDIDATE_SLACK),
    });
  }

  async handle(output: FanoutTaskOutput, run: FanoutRun<GroupDayContext>, params: KeywordMinesParams): Promise<void> {
    const candidates = parseCandidates(output.text);
    if (candidates.length === 0) {
      throw new Error('mines output carries no usable candidates');
    }
    await plantMines({
      agendaService: this.deps.agendaService,
      groupId: run.ctx.groupId,
      userId: this.deps.botSelfId,
      candidates,
      messages: run.ctx.userMessages,
      count: params.count,
    });
  }
}

export interface PlantMinesParams {
  agendaService: AgendaService;
  groupId: string;
  userId: string;
  candidates: MineCandidate[];
  /** Yesterday's messages — ground truth for whether a keyword can ever match */
  messages: ConversationMessageEntry[];
  count: number;
}

/** Register one onMessage watch per candidate that yesterday's messages actually contain. */
export async function plantMines(params: PlantMinesParams): Promise<number> {
  const { agendaService, groupId, userId, count } = params;
  const spokenTexts = params.messages
    .filter((m) => !m.isBotReply)
    .map((m) => MessageUtils.extractUserText(m.content).toLowerCase());

  const planted: string[] = [];
  const rejected: string[] = [];

  for (const candidate of params.candidates) {
    if (planted.length >= count) {
      break;
    }
    const keyword = candidate.keyword.trim();
    if (!keyword || !candidate.prompt.trim()) {
      continue;
    }
    if (planted.some((k) => k.toLowerCase() === keyword.toLowerCase())) {
      continue;
    }

    const hits = spokenTexts.filter((text) => text.includes(keyword.toLowerCase())).length;
    if (hits === 0) {
      rejected.push(`${keyword}(昨日无原文命中)`);
      continue;
    }

    const result = await agendaService.createLlmItem({
      kind: 'onMessage',
      prompt: candidate.prompt.trim(),
      name: `地雷·${keyword}`,
      groupId,
      userId,
      keywords: [keyword],
      ttlMs: MINE_TTL_MS,
      maxFires: 1,
      chainDepth: 0,
    });

    if (result.ok) {
      planted.push(keyword);
      logger.info(`[KeywordMines] Planted "${keyword}" (${hits} hits yesterday) for group ${groupId}`);
    } else {
      rejected.push(`${keyword}(${result.error})`);
    }
  }

  logger.info(
    `[KeywordMines] group ${groupId}: planted ${planted.length}/${count} [${planted.join(', ')}]` +
      (rejected.length > 0 ? ` | rejected: ${rejected.join('; ')}` : ''),
  );
  return planted.length;
}

export function parseCandidates(text: string): MineCandidate[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }
  try {
    const data = JSON.parse(jsonMatch[0]) as { mines?: unknown };
    if (!Array.isArray(data.mines)) {
      return [];
    }
    return data.mines
      .map((raw) => raw as Partial<MineCandidate>)
      .filter((m): m is MineCandidate => typeof m.keyword === 'string' && typeof m.prompt === 'string');
  } catch (err) {
    logger.warn('[KeywordMines] Failed to parse candidates:', err);
    return [];
  }
}
