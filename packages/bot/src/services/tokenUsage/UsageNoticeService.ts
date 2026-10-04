// Spend visibility in the chat itself: a group is told each time its spend for the day
// passes another step, and a session is told when a reply's prompt has grown past the
// alert line, with the command that shrinks it.

import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { type GroupSpend, type TokenUsageEvent, TokenUsageService } from './TokenUsageService';

const DEFAULT_PROMPT_ALERT_COOLDOWN_MINUTES = 30;
const TOP_SPENDERS_SHOWN = 3;

@singleton()
export class UsageNoticeService {
  private readonly groupSpendStepUsd: number | undefined;
  private readonly promptAlertTokens: number | undefined;
  private readonly promptAlertCooldownMs: number;

  /**
   * A step crossing is read off the group's spend before and after one row. That pair is
   * only exact when a group's rows are stored and summed one at a time; two concurrent
   * records would each see the other's row and could both claim the same step.
   */
  private readonly groupQueues = new Map<string, Promise<unknown>>();
  private readonly lastPromptAlertAt = new Map<string, number>();

  constructor(
    @inject(TokenUsageService) private readonly usageService: TokenUsageService,
    @inject(DITokens.CONFIG) config: Config,
  ) {
    const usage = config.getAIConfig()?.usage;
    this.groupSpendStepUsd = usage?.groupSpendStepUsd;
    this.promptAlertTokens = usage?.promptAlertTokens;
    this.promptAlertCooldownMs =
      (usage?.promptAlertCooldownMinutes ?? DEFAULT_PROMPT_ALERT_COOLDOWN_MINUTES) * 60 * 1000;
  }

  /**
   * Record one usage event and return the notices it earns for the session it came from,
   * in sending order. A failed write earns no spend notice; a failed spend lookup rejects.
   */
  async record(
    event: TokenUsageEvent,
    session: { sessionId: string; openingPromptTokens?: number },
  ): Promise<string[]> {
    const notices: string[] = [];
    const groupId = event.groupId != null ? String(event.groupId) : undefined;
    const step = this.groupSpendStepUsd;

    if (groupId && step) {
      const spendNotice = await this.inGroupQueue(groupId, async () => {
        const cost = await this.usageService.record(event);
        if (!cost) {
          return null;
        }
        const spend = await this.usageService.getGroupSpend(groupId, this.usageService.getLocalDate());
        return this.groupSpendNotice(spend, spend.cost - cost, step);
      });
      if (spendNotice) {
        notices.push(spendNotice);
      }
    } else {
      await this.usageService.record(event);
    }

    const promptNotice = this.promptNotice(session.sessionId, session.openingPromptTokens);
    if (promptNotice) {
      notices.push(promptNotice);
    }
    return notices;
  }

  private groupSpendNotice(spend: GroupSpend, before: number, step: number): string | null {
    const passed = Math.floor(spend.cost / step);
    if (passed <= Math.floor(before / step)) {
      return null;
    }
    const top = spend.users
      .slice(0, TOP_SPENDERS_SHOWN)
      .map((u) => `${u.nickname || u.userId} $${u.cost.toFixed(2)}`)
      .join(' · ');
    return `💸 本群今日 AI 花费已过 $${formatUsd(passed * step)}（累计 $${spend.cost.toFixed(2)}）｜${top}`;
  }

  private promptNotice(sessionId: string, openingPromptTokens: number | undefined): string | null {
    const threshold = this.promptAlertTokens;
    if (!threshold || openingPromptTokens == null || openingPromptTokens < threshold) {
      return null;
    }
    const now = Date.now();
    const last = this.lastPromptAlertAt.get(sessionId);
    if (last != null && now - last < this.promptAlertCooldownMs) {
      return null;
    }
    this.lastPromptAlertAt.set(sessionId, now);
    return (
      `📏 这轮 prompt 已有 ${formatKiloTokens(openingPromptTokens)} tokens（提醒线 ${formatKiloTokens(threshold)}）。` +
      '发 /compress 把旧对话压成摘要，/compress clear 从这里清空重来。'
    );
  }

  private inGroupQueue<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    // The stored tail never rejects, so one failed task cannot stall the group's queue.
    const next = (this.groupQueues.get(groupId) ?? Promise.resolve()).then(task);
    this.groupQueues.set(
      groupId,
      next.catch(() => undefined),
    );
    return next;
  }
}

function formatUsd(usd: number): string {
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

function formatKiloTokens(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}K`;
}
