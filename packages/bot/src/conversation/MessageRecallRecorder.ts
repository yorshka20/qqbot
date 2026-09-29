import { inject, singleton } from 'tsyringe';
import { EpisodeCacheManager } from '@/ai/pipeline/helpers/EpisodeCacheManager';
import { ConversationHistoryService, normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import type { NormalizedNoticeEvent } from '@/events/types';
import { logger } from '@/utils/logger';

/**
 * Applies a `message_recall` notice to conversation history, so history shows what the chat
 * shows: the message is still there, marked as withdrawn.
 *
 * The notice is the single source of that state. The protocol emits it for every recall —
 * the bot's own (the recall_message tool, a recall reaction, AutoRecall) and any member's — so
 * no recall path writes the marker itself.
 */
@singleton()
export class MessageRecallRecorder {
  constructor(
    @inject(ConversationHistoryService) private readonly historyService: ConversationHistoryService,
    @inject(EpisodeCacheManager) private readonly episodeCache: EpisodeCacheManager,
  ) {}

  async record(notice: NormalizedNoticeEvent): Promise<void> {
    const sessionType = notice.messageType === 'group' ? 'group' : 'user';
    const peerId = sessionType === 'group' ? notice.groupId : notice.userId;
    const messageSeq = notice.messageSeq;
    if (peerId == null || !messageSeq) {
      logger.debug('[MessageRecallRecorder] Recall notice without a chat or sequence number; skipped');
      return;
    }

    const sessionId = sessionType === 'group' ? normalizeGroupId(peerId).sessionId : `user:${peerId}`;
    const marked = await this.historyService.markMessageRecalled(sessionId, sessionType, messageSeq, {
      recalledAt: new Date(notice.timestamp),
      operatorId: notice.operatorId,
    });
    if (!marked) {
      return;
    }
    this.episodeCache.markRecalled(sessionId, messageSeq);
    logger.info(
      `[MessageRecallRecorder] Marked recalled | session=${sessionId} | messageSeq=${messageSeq} | sender=${notice.senderId ?? '?'} | operator=${notice.operatorId ?? '?'}`,
    );
  }
}
