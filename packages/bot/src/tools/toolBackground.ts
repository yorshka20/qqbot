// Deferred tool delivery: work that outlives the turn that asked for it.
//
// A tool defers because of what it *is* — an image model, a research subagent, a
// video analysis — not because a particular call happened to run long. The
// executor returns a receipt at once and hands the work here; the outcome reaches
// the originating session when it is ready.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { logger } from '@/utils/logger';
import type { ToolExecutionContext, ToolResult } from './types';

export interface DeferredDelivery {
  messageAPI: MessageAPI;
  historyService: ConversationHistoryService;
  /** Tool name, recorded on the delivered message and used in logs. */
  viaTool: string;
  /** Budget for the detached work — a hung provider must not leak a promise forever. */
  timeoutMs: number;
  /**
   * What the session should be told. Return null when the tool already delivered
   * its own product (generate_image sends the picture itself) and there is
   * nothing left to say.
   */
  render: (result: ToolResult) => string | null;
}

/**
 * Run `work` detached and deliver what `render` makes of it. Never throws and
 * never resolves into the caller's turn — the caller has already returned.
 */
export function deliverWhenReady(
  work: Promise<ToolResult>,
  context: ToolExecutionContext,
  delivery: DeferredDelivery,
): void {
  const { viaTool, timeoutMs, render } = delivery;
  void withDeadline(work, timeoutMs, viaTool)
    .then(
      (result) => render(result),
      (error) => `${viaTool} 失败：${error instanceof Error ? error.message : String(error)}`,
    )
    .then((content) => (content === null ? undefined : deliverToolResult(content, context, delivery)))
    .catch((error) => logger.error(`[deliverWhenReady] ${viaTool} delivery failed:`, error));
}

async function withDeadline(work: Promise<ToolResult>, timeoutMs: number, viaTool: string): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${viaTool} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function deliverToolResult(
  content: string,
  context: ToolExecutionContext,
  delivery: Pick<DeferredDelivery, 'messageAPI' | 'historyService' | 'viaTool'>,
): Promise<void> {
  const { messageAPI, historyService, viaTool } = delivery;
  const hookContext = context.hookContext;
  if (!hookContext) throw new Error(`Cannot deliver ${viaTool} result without message context`);
  const message = hookContext.message;
  const sent = await messageAPI.sendFromContext(content, message);
  const isGroup = message.messageType === 'group';
  const targetId = isGroup ? message.groupId : message.userId;
  if (targetId == null) return;
  const botSelfId = Number(hookContext.metadata.get('botSelfId'));
  await historyService.appendBotMessageToSession(
    { sessionType: isGroup ? 'group' : 'user', targetId },
    content,
    message.protocol,
    {
      botUserId: Number.isNaN(botSelfId) ? 0 : botSelfId,
      messageSeq: sent.message_seq,
      viaTool,
    },
  );
}
