// Keyword mines — onMessage watches planted from the group daily report.
//
// A mine is a keyword the group discussed yesterday plus the background the bot
// will need when someone brings it up again. Candidates come from the report's
// own semantic analysis rather than a second pass over the raw chat log, and
// every keyword is checked against yesterday's messages with the same text
// extraction the trigger uses, so a mine that could never fire is never planted.

import type { AgendaService } from '@/agenda/AgendaService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import type { ConversationMessageEntry } from '@/conversation/history/ConversationHistoryService';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import type { GroupReportData } from './types';

const TEMPLATE_NAME = 'subagent.group_report.keyword_mines';
/** Candidates requested beyond `count`, to absorb the ones verbatim validation drops */
const CANDIDATE_SLACK = 4;
const MINE_TTL_MS = 24 * 3600_000;
const GENERATE_TIMEOUT_MS = 120_000;

interface MineCandidate {
  keyword: string;
  prompt: string;
}

export interface PlantKeywordMinesParams {
  agendaService: AgendaService;
  llmService: LLMService;
  promptManager: PromptManager;
  groupId: string;
  /** Owner recorded on the created items (the schedule item's user, or the bot itself) */
  userId: string;
  groupName: string;
  date: string;
  report: GroupReportData;
  /** Yesterday's messages — ground truth for whether a keyword can ever match */
  messages: ConversationMessageEntry[];
  count: number;
  providerName?: string;
}

/** Pick keywords from a finished report and register one onMessage watch per keyword. */
export async function plantKeywordMines(params: PlantKeywordMinesParams): Promise<number> {
  const { agendaService, llmService, promptManager, groupId, userId, count } = params;

  const prompt = promptManager.render(TEMPLATE_NAME, {
    groupName: params.groupName,
    date: params.date,
    count: String(count),
    candidateCount: String(count + CANDIDATE_SLACK),
    reportDigest: buildReportDigest(params.report),
  });

  const response = await llmService.generate(
    prompt,
    {
      temperature: 0.7,
      maxTokens: TOKEN_BUDGET.analysis,
      jsonMode: true,
      timeout: GENERATE_TIMEOUT_MS,
    },
    params.providerName,
  );
  const candidates = parseCandidates(response.text);

  if (candidates.length === 0) {
    logger.warn('[KeywordMines] LLM returned no usable candidates');
    return 0;
  }

  const spokenTexts = params.messages
    .filter((m) => !m.isBotReply)
    .map((m) => MessageUtils.extractUserText(m.content).toLowerCase());

  const planted: string[] = [];
  const rejected: string[] = [];

  for (const candidate of candidates) {
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

/** Condense the report into the background a future trigger cannot look up any more. */
function buildReportDigest(report: GroupReportData): string {
  const sections: string[] = [];

  if (report.topics.length > 0) {
    sections.push('【昨日话题】', ...report.topics.map((t, i) => `${i + 1}. ${t.title} —— ${t.summary}`));
  }
  if (report.featuredMessages.length > 0) {
    sections.push(
      '',
      '【精选发言】',
      ...report.featuredMessages.map((m) => `- ${m.nickname}: 「${m.content}」（点评: ${m.comment}）`),
    );
  }
  if (report.memberHighlights.length > 0) {
    sections.push('', '【活跃成员】', ...report.memberHighlights.map((m) => `- ${m.nickname}: ${m.comment}`));
  }
  if (report.totalSummary) {
    sections.push('', '【群聊总评】', report.totalSummary);
  }

  return sections.join('\n');
}

function parseCandidates(text: string): MineCandidate[] {
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
