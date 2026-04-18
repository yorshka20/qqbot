// History stage — episode-based conversation history loading (delegates to EpisodeCacheManager).

import type { EpisodeCacheManager } from '../helpers/EpisodeCacheManager';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 3: conversation history loading.
 * Delegates to {@link EpisodeCacheManager} to build episode-based history entries
 * with caching for prompt prefix stability (LLM cache optimization).
 */
export class HistoryStage implements ReplyStage {
  readonly name = 'history';

  constructor(private episodeCacheManager: EpisodeCacheManager) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const result = await this.episodeCacheManager.buildNormalHistoryEntries(ctx.hookContext);
    ctx.historyEntries = result.historyEntries;
    ctx.sessionId = result.sessionId;
    ctx.episodeKey = result.episodeKey;
  }
}
