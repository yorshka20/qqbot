# HookContext Metadata Keys Documentation

This document describes all metadata keys used in `HookContext.metadata` throughout the message processing lifecycle.

## Overview

`HookContext.metadata` is a **type-safe `MetadataMap`** (not a generic `Map<string, unknown>`) that provides compile-time type checking for all metadata keys. All possible metadata keys and their types are defined in the `HookContextMetadata` interface.

**Type Definition**: `metadata: MetadataMap` where `MetadataMap` provides type-safe `get<K>()` and `set<K, V>()` methods.

This ensures:

- ✅ Compile-time type safety
- ✅ No type casting needed
- ✅ Auto-completion for metadata keys
- ✅ Prevents typos and invalid key usage

**Important**: Reply-related data (`reply`, `cardImage`, `isCardImage`) is **no longer stored in metadata**. Use `context.reply` (type: `ReplyContent`) instead. See the "Reply Content" section below for details.

---

## 1. Session & Context Information

These keys are initialized when the message processing starts and remain constant throughout the lifecycle.

### `sessionId`

- **Type**: `string`
- **Set By**: `MessagePipeline.process()` (initialization), `ContextManager.buildContext()`
- **Read By**: `AIService`, `DatabasePersistenceSystem`
- **Purpose**: Unique identifier for the conversation session (user or group)
- **Lifecycle**: Initialized at start, read during PROCESS/COMPLETE stages

### `sessionType`

- **Type**: `'user' | 'group'`
- **Set By**: `MessagePipeline.process()` (initialization), `ContextManager.buildContext()`
- **Read By**: `AIService`, `DatabasePersistenceSystem`
- **Purpose**: Type of session (private chat or group chat)
- **Lifecycle**: Initialized at start, read during PROCESS/COMPLETE stages

### `conversationId`

- **Type**: `string | undefined`
- **Set By**: `MessagePipeline.process()` (initialization)
- **Read By**: `TaskSystem`, `DatabasePersistenceSystem`
- **Purpose**: Unique identifier for the conversation thread (may be loaded from database)
- **Lifecycle**: Initialized at start, used during PROCESS stage

### `botSelfId`

- **Type**: `string`
- **Set By**: `MessagePipeline.process()` (initialization)
- **Read By**: `WhitelistPlugin`, `EchoPlugin`, `ReactionPlugin`, `DatabasePersistenceSystem`
- **Purpose**: Bot's own user ID for self-message detection and @bot checks
- **Lifecycle**: Initialized at start, used throughout all stages

---

## 2. Access Control & Processing Mode

These keys control whether and how the message should be processed.

### `postProcessOnly`

- **Type**: `boolean`
- **Set By**: `WhitelistPlugin` (RECEIVE stage) for bot message or private not in whitelist; `MessageTriggerPlugin` (PREPROCESS) when there is no direct reply trigger (no @, no wake word) for a whitelist message.
- **Read By**: `TaskSystem`, `MessagePipeline`, `Lifecycle`, `HookManager`
- **Purpose**: When `true`, no direct reply path: skip PROCESS/PREPARE/SEND; COMPLETE and onMessageComplete still run (e.g. proactive can schedule).
- **Lifecycle**: Set in RECEIVE (access deny) or PREPROCESS (no trigger); Lifecycle skips to COMPLETE when this or `whitelistDenied` is set.

### `whitelistDenied`

- **Type**: `boolean`
- **Set By**: `WhitelistPlugin` (RECEIVE stage only) when: bot message, private not in user whitelist, or group not in group whitelist.
- **Read By**: `Lifecycle`, `HookManager`, `ProactiveConversationPlugin` (only flag used to skip proactive), `TaskSystem`, and plugins that respect access control (Echo, LightApp, MemoryTrigger, Reaction).
- **Purpose**: Access denied; no reply and no proactive; PREPROCESS and COMPLETE still run (e.g. non-whitelist group gets DB/RAG persistence and GroupDownload via event).
- **Lifecycle**: Set in RECEIVE; Lifecycle skips to COMPLETE when this or `postProcessOnly` is set after each stage.

### `whitelistUser`

- **Type**: `boolean`
- **Set By**: `WhitelistPlugin` (RECEIVE stage) when private message sender is in user whitelist
- **Read By**: None (used for internal state tracking)
- **Purpose**: Indicates whether the message sender is in the user whitelist
- **Lifecycle**: Set in RECEIVE, may influence processing logic

### `whitelistGroup`

- **Type**: `boolean`
- **Set By**: `WhitelistPlugin` (RECEIVE stage) when group is in group whitelist
- **Read By**: `ReactionPlugin`, `HookManager` (ProactiveConversationPlugin skips only on `whitelistDenied`, not on `postProcessOnly`/`whitelistGroup`)
- **Purpose**: Indicates whether the message is from a whitelisted group
- **Lifecycle**: Set in RECEIVE, used by plugins that need group whitelist status

---

## 3. Reply Content

**Note**: Reply content is **not stored in metadata**. Use `context.reply` field instead.

### `context.reply` (HookContext Field)

- **Type**: `ReplyContent | undefined`
- **Location**: `HookContext.reply` (not in metadata)
- **Set By**:
  - `CommandSystem` (PROCESS stage) - from command execution result
  - `TaskSystem` (PROCESS stage) - from task execution result
  - `EchoPlugin` (PREPROCESS stage) - from triggered `/tts` command (speech synthesized via bot `TTSCommandHandler` → `TTSManager`, not the avatar package)
  - `AIService` (PROCESS stage) - from AI generation result
  - `MessagePipeline.sendMessage()` - may be modified before sending
- **Read By**:
  - `TaskSystem` - checks for existing reply to skip processing
  - `MessagePipeline` - reads final reply for sending
  - `DatabasePersistenceSystem` - saves reply to database
- **Purpose**: Unified reply content with text, source, and metadata
- **Structure**:
  ```typescript
  interface ReplyContent {
    text: string; // Reply message text
    source: 'command' | 'task' | 'plugin' | 'ai'; // Source of the reply
    metadata?: {
      cardImage?: string; // Base64-encoded image data
      isCardImage?: boolean; // Flag for card image messages
      // ... extensible for future types
    };
  }
  ```
- **Helper Functions**: Use `setReply()`, `getReply()`, `getReplyContent()`, `hasReply()`, `clearReply()` from `@/context/HookContextHelpers`
- **Lifecycle**: Set in PREPROCESS or PROCESS, read in SEND/COMPLETE stages
- **Migration**: Previously stored as `metadata.get('reply')`, `metadata.get('cardImage')`, `metadata.get('isCardImage')`. These metadata keys have been **completely removed**.

---

## 4. Context Manager Metadata

These keys are used by `ContextManager` when building conversation contexts for AI processing.

### `userId`

- **Type**: `number`
- **Set By**: `ContextManager.buildContext()`
- **Read By**: None (internal to ContextManager)
- **Purpose**: User ID for context building
- **Lifecycle**: Set during context building, not used in message processing lifecycle

### `groupId`

- **Type**: `number | undefined`
- **Set By**: `ContextManager.buildContext()` (if group message)
- **Read By**: None (internal to ContextManager)
- **Purpose**: Group ID for context building (only for group messages)
- **Lifecycle**: Set during context building, not used in message processing lifecycle

---

## 5. Command Metadata

These keys are used for command execution and permission checking.

### `senderRole`

- **Type**: `string | undefined`
- **Set By**: `CommandSystem` (via CommandContext metadata)
- **Read By**: `CommandManager.checkPermissions()`
- **Purpose**: User role from protocol data (used for permission checking)
- **Lifecycle**: Set during command execution, used for permission validation

---

## Metadata Flow by Stage

### RECEIVE Stage

- **Set**: `postProcessOnly`, `whitelistDenied`, `whitelistUser`, `whitelistGroup` (WhitelistPlugin)

### PREPROCESS Stage

- **Set**: `postProcessOnly` (MessageTriggerPlugin when no direct reply trigger), `context.reply` (EchoPlugin)
- **Read**: `botSelfId`, `whitelistGroup` (ReactionPlugin), `whitelistDenied` (HookManager)

### PROCESS Stage

- **Set**: `context.reply` (CommandSystem, TaskSystem, AIService)
- **Read**: `postProcessOnly` (TaskSystem), `context.reply` (TaskSystem), `conversationId`, `sessionId`, `sessionType`

### PREPARE Stage

- **Set**: `context.reply` (may be modified by hooks)
- **Read**: `context.reply` (hooks may read/modify)

### SEND Stage

- **Read**: `context.reply` (MessagePipeline)

### COMPLETE Stage

- **Read**: `context.reply` (DatabasePersistenceSystem), `botSelfId`, `sessionId`, `sessionType`

---

## Best Practices

1. **Initialization**: Always initialize core metadata keys (`sessionId`, `sessionType`, `conversationId`, `botSelfId`) at the start of message processing.

2. **Access Control**: Access control keys (`whitelistDenied`, `postProcessOnly`, `whitelistUser`, `whitelistGroup`) are set in RECEIVE stage by WhitelistPlugin; `postProcessOnly` may also be set in PREPROCESS by MessageTriggerPlugin when there is no direct reply trigger.

3. **Reply Handling**: Use `context.reply` field (not metadata) for reply content. Use helper functions (`setReply()`, `getReply()`, etc.) from `@/context/HookContextHelpers` for type-safe operations. Be aware that multiple systems may set replies - last writer wins, so consider checking for existing replies before overwriting.

4. **Type Safety**: Metadata values are type-safe through `MetadataMap` - no casting needed. The `MetadataMap.get<K>()` method returns the correct type automatically.

5. **Lifecycle Awareness**: Only read metadata keys that are guaranteed to be set at your stage. Don't assume keys exist without checking.

6. **Naming Convention**: Use camelCase for metadata keys. Avoid conflicts by using descriptive, namespaced names if needed.

---

## Reply Content Management

### Using Helper Functions

Always use helper functions for reply operations:

```typescript
import { setReply, getReply, getReplyContent, hasReply, clearReply } from '@/context/HookContextHelpers';

// Set reply with source and metadata
setReply(context, 'Hello, world!', 'command', {
  cardImage: 'base64...',
  isCardImage: true,
});

// Get reply text
const replyText = getReply(context);

// Get full reply content
const replyContent = getReplyContent(context);
if (replyContent?.metadata?.isCardImage) {
  // Handle card image...
}

// Check if reply exists
if (hasReply(context)) {
  // Process reply...
}

// Clear reply
clearReply(context);
```

### Migration Notes

The reply mechanism was migrated from metadata to a dedicated `HookContext.reply` field for:

- ✅ Better type safety
- ✅ Cleaner structure
- ✅ Extensibility for future reply types
- ✅ Consistency with HookContext design

All legacy metadata keys (`reply`, `cardImage`, `isCardImage`) have been **completely removed** from `HookContextMetadata`.
