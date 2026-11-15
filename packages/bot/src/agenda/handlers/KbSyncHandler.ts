// Two-way git sync of the knowledge base behind the bot checkout's `_kb` link. No LLM;
// schedule: `执行: action kb_sync`. Silent on success; a failure is reported to the item's chat target.

import { KNOWLEDGE_BASE_LINK, syncKnowledgeBase } from '@qqbot/agent-cluster';
import { fromRepoRoot, logger } from '@qqbot/shared';
import { injectable } from 'tsyringe';
import type { ActionHandler } from '../ActionHandlerRegistry';

@injectable()
export class KbSyncHandler implements ActionHandler {
  readonly name = 'kb_sync';

  async execute(): Promise<string | undefined> {
    const result = await syncKnowledgeBase(fromRepoRoot(KNOWLEDGE_BASE_LINK));
    if (!result.ok) {
      logger.error(`[KbSync] ${result.error}`);
      return `❌ kb_sync: ${result.error}`;
    }
    logger.info(
      `[KbSync] ${result.root}: committed ${result.committed}, pulled ${result.pulled}, pushed ${result.pushed}`,
    );
    return undefined;
  }
}
