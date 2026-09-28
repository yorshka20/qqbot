import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { ToolExecutionContext } from './types';

export const INLINE_TOOL_TIMEOUT_MS = 8_000;

export async function waitForInlineResult<T>(
  work: Promise<T>,
): Promise<{ finished: true; result: T } | { finished: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((result) => ({ finished: true as const, result })),
      new Promise<{ finished: false }>((resolve) => {
        timer = setTimeout(() => resolve({ finished: false }), INLINE_TOOL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function deliverBackgroundToolResult(
  content: string,
  context: ToolExecutionContext,
  messageAPI: MessageAPI,
  historyService: ConversationHistoryService,
  viaTool: string,
): Promise<void> {
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
