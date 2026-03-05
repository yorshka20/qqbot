# Bot reply persistence: no loss, no duplicate

All bot-sent messages must be persisted to DB (and where applicable to in-memory cache/context) **in the same code path that sends them**. We never rely on the protocol echo (bot receiving its own message) to persist; we skip persisting the echo to avoid duplicate records.

## Reply paths and where they persist

| Path | Where reply is sent | Where reply is persisted |
|------|---------------------|---------------------------|
| **Full pipeline** (user message → reply) | `MessagePipeline.handleReply` → `sendMessage` (after `lifecycle.execute`) | **DatabasePersistenceSystem** (COMPLETE stage, same run; runs *before* handleReply). In-memory: `saveConversationMessages` in handleReply. |
| **Reply-only** (reply to existing message) | `MessagePipeline.handleReply` → `sendMessage` | **DatabasePersistenceSystem** via `lifecycle.runCompleteStage(hookContext)` after handleReply. In-memory: `saveConversationMessages` in handleReply. |
| **Proactive** (new thread or reply in thread) | `ProactiveConversationService.sendGroupMessage` | **ConversationHistoryService.appendBotReplyToGroup(groupId, toAppend)** after send. Thread: `threadService.appendMessage(..., toAppend)`. |
| **Proactive "已结束…thread"** | `ProactiveConversationService.sendGroupMessage` | **ConversationHistoryService.appendBotReplyToGroup(groupId, endMessage)** after send. |
| **Command / task / plugin** (sets `context.reply`) | Same as full pipeline or reply-only | Same as full pipeline or reply-only (DatabasePersistenceSystem in COMPLETE). |

## Echo handling

When the bot receives its own message (echo), **DatabasePersistenceSystem** detects `message.userId === botSelfId` and **returns without persisting**. That run therefore does not add any record; the real reply was already stored in the run that sent it (or via `appendBotReplyToGroup` for proactive).

## Summary

- **Pipeline replies** (full + reply-only): persisted in COMPLETE (DB) and in handleReply (context manager); send happens after COMPLETE or in handleReply before runCompleteStage.
- **Proactive replies**: persisted by explicit `appendBotReplyToGroup` after each `sendGroupMessage` (AI reply and "已结束 thread").
- **Echo**: never persisted; no duplicate.
