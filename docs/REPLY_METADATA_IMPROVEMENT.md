# Reply Metadata Improvement Proposal

## Current Issues with `reply` in Metadata

### Problem Analysis

The `reply` metadata key is currently used to store the reply message content, but this approach has several issues:

#### 1. **Multiple Writers, No Priority**

- **CommandSystem** sets `reply` from command execution result
- **TaskSystem** sets `reply` from task execution result
- **EchoPlugin** sets `reply` from triggered TTS command (in PREPROCESS stage)
- **MessagePipeline** may modify `reply` before sending

**Problem**: Last writer wins, but there's no clear priority system. TaskSystem currently checks for `existingReply` to avoid overwriting, but this is a workaround, not a solution.

#### 2. **Type Safety Issues**

- Stored as `unknown` in `Map<string, unknown>`
- Requires type casting everywhere: `as string`
- No compile-time type checking
- Easy to accidentally overwrite with wrong type

#### 3. **Loss of Context**

- Only stores the final string, losing information about:
  - Source of the reply (command vs AI vs plugin)
  - Reply metadata (format, priority, etc.)
  - Original result objects (CommandResult, TaskResult)

#### 4. **Hard to Extend**

- Adding reply metadata (e.g., reply type, priority, formatting) requires new keys
- Multiple keys needed for related data (`reply`, `cardImage`, `isCardImage`)
- No unified way to handle different reply types

#### 5. **Inconsistent with HookContext Structure**

- `HookContext` already has dedicated fields for responses:
  - `aiResponse?: string` - AI-generated response
  - `result?: TaskResult | CommandResult` - System execution results
- But `reply` is in metadata, not a first-class field

---

## Proposed Solutions

### Option 1: Use HookContext Fields (Recommended)

**Principle**: Use existing HookContext fields instead of metadata for structured data.

#### Implementation:

```typescript
// HookContext already has:
export interface HookContext {
  // ... existing fields
  aiResponse?: string; // AI-generated response
  result?: TaskResult | CommandResult; // System execution result
  // ...
}

// Add new field:
export interface HookContext {
  // ... existing fields
  reply?: ReplyContent; // Unified reply content
  // ...
}

interface ReplyContent {
  text: string;
  source: 'command' | 'task' | 'plugin' | 'ai';
  metadata?: {
    cardImage?: string;
    isCardImage?: boolean;
    // ... other metadata
  };
}
```

#### Benefits:

- Type-safe with compile-time checking
- Clear ownership and priority
- Extensible for future reply types
- Consistent with HookContext design pattern

#### Migration:

1. Systems/Plugins set `context.reply` instead of `context.metadata.set('reply', ...)`
2. MessagePipeline reads `context.reply?.text`
3. Keep `metadata.get('reply')` for backward compatibility during transition
4. Remove metadata usage after migration

---

### Option 2: Reply Priority System

**Principle**: Establish clear priority rules when multiple systems want to set reply.

#### Priority Order (high to low):

1. **Command replies** - Commands are explicit user requests
2. **Plugin replies** - Plugins can override (e.g., EchoPlugin)
3. **Task/AI replies** - Generated content

#### Implementation:

```typescript
// Helper function to set reply with priority checking
function setReply(context: HookContext, reply: string, source: 'command' | 'plugin' | 'task'): boolean {
  const existing = context.metadata.get('reply') as ReplyInfo | undefined;
  const existingPriority = getPriority(existing?.source);
  const newPriority = getPriority(source);

  if (!existing || newPriority > existingPriority) {
    context.metadata.set('reply', { text: reply, source });
    return true;
  }
  return false; // Lower priority, didn't overwrite
}

function getPriority(source?: string): number {
  switch (source) {
    case 'command':
      return 3;
    case 'plugin':
      return 2;
    case 'task':
      return 1;
    default:
      return 0;
  }
}
```

#### Benefits:

- Prevents accidental overwrites
- Clear priority rules
- Minimal code changes

#### Drawbacks:

- Still uses metadata (type safety issues remain)
- More complex logic
- Doesn't solve extensibility

---

### Option 3: Reply Manager System

**Principle**: Create a dedicated ReplyManager to handle all reply-related operations.

#### Implementation:

```typescript
class ReplyManager {
  private replies: Map<string, ReplyInfo> = new Map();

  addReply(id: string, reply: ReplyInfo, priority: number): void {
    const existing = this.replies.get(id);
    if (!existing || priority > existing.priority) {
      this.replies.set(id, { ...reply, priority });
    }
  }

  getFinalReply(context: HookContext): string | undefined {
    // Merge all replies based on priority
    // Return the highest priority reply
  }
}

// Usage in systems:
replyManager.addReply(
  context.message.id,
  {
    text: commandResult.message,
    source: 'command',
    priority: 3,
  },
  context,
);
```

#### Benefits:

- Centralized reply management
- Clear priority system
- Extensible for advanced features (reply merging, formatting, etc.)

#### Drawbacks:

- Additional complexity
- Requires new infrastructure
- May be overkill for current needs

---

### Option 4: Hybrid Approach (Recommended for Transition)

**Principle**: Use HookContext field for new code, keep metadata for backward compatibility.

#### Implementation:

```typescript
// Add to HookContext
export interface HookContext {
  // ... existing
  reply?: ReplyContent;
}

// Helper that handles both old and new way
export function setReply(context: HookContext, reply: ReplyContent): void {
  context.reply = reply;
  // Also set in metadata for backward compatibility
  context.metadata.set('reply', reply.text);
}

export function getReply(context: HookContext): string | undefined {
  // Prefer new field, fallback to metadata
  return context.reply?.text || (context.metadata.get('reply') as string | undefined);
}
```

#### Benefits:

- Gradual migration path
- Backward compatible
- Type-safe for new code
- Low risk

---

## Recommendation

**Recommend Option 1 (Use HookContext Fields) with Option 4 (Hybrid Transition)**:

1. **Short term**: Implement Option 4 to add type safety without breaking existing code
2. **Long term**: Migrate to Option 1, removing metadata usage for reply

### Implementation Steps:

1. **Phase 1: Add Reply Field**

   ```typescript
   interface ReplyContent {
     text: string;
     source: 'command' | 'task' | 'plugin' | 'ai';
     metadata?: ReplyMetadata;
   }

   interface HookContext {
     reply?: ReplyContent;
     // ... existing fields
   }
   ```

2. **Phase 2: Create Helper Functions**

   ```typescript
   // helpers/reply.ts
   export function setReply(context: HookContext, text: string, source: ReplyContent['source']): void {
     context.reply = { text, source };
     context.metadata.set('reply', text); // Backward compat
   }

   export function getReply(context: HookContext): string | undefined {
     return context.reply?.text || (context.metadata.get('reply') as string | undefined);
   }
   ```

3. **Phase 3: Migrate Systems**
   - Update CommandSystem, TaskSystem, EchoPlugin to use `setReply()`
   - Update MessagePipeline to use `getReply()`

4. **Phase 4: Remove Metadata Usage**
   - Remove `metadata.get('reply')` calls
   - Remove `metadata.set('reply', ...)` calls
   - Keep only `context.reply`

---

## Additional Improvements

### 1. Reply Metadata Consolidation

Move `cardImage` and `isCardImage` into `ReplyContent.metadata`:

```typescript
interface ReplyContent {
  text: string;
  source: 'command' | 'task' | 'plugin' | 'ai';
  metadata?: {
    cardImage?: string;
    isCardImage?: boolean;
    format?: 'text' | 'image' | 'card';
    // ... extensible for future types
  };
}
```

### 2. Reply Source Tracking

Track where replies come from for debugging and analytics:

```typescript
interface ReplyContent {
  text: string;
  source: 'command' | 'task' | 'plugin' | 'ai';
  sourceDetails?: {
    commandName?: string;
    taskType?: string;
    pluginName?: string;
  };
}
```

### 3. Reply Validation

Add validation to ensure reply content is valid before sending:

```typescript
function validateReply(reply: ReplyContent): boolean {
  if (!reply.text || reply.text.trim().length === 0) {
    return false;
  }
  // Additional validation...
  return true;
}
```

---

## Migration Checklist

- [x] Add `ReplyContent` interface
- [x] Add `reply?: ReplyContent` to `HookContext`
- [x] Create `setReply()`, `getReply()`, `getReplyContent()`, `hasReply()`, `clearReply()` helper functions
- [x] Update CommandSystem to use `setReply()`
- [x] Update TaskSystem to use `setReply()`
- [x] Update EchoPlugin to use `setReply()`
- [x] Update AIService to use `setReply()` for card images
- [x] Update MessagePipeline to use `getReply()` and `getReplyContent()`
- [x] Update DatabasePersistenceSystem to use `getReply()`
- [x] Remove all `metadata.get('reply')` calls
- [x] Remove all `metadata.set('reply', ...)` calls
- [x] Remove all `metadata.get('cardImage')` and `metadata.set('cardImage', ...)` calls
- [x] Remove all `metadata.get('isCardImage')` and `metadata.set('isCardImage', ...)` calls
- [x] Remove `reply`, `cardImage`, `isCardImage` from `HookContextMetadata` interface
- [x] Update documentation

**Status**: ✅ **Migration Complete** - All reply-related data has been migrated from metadata to `context.reply` field.

---

## Conclusion

✅ **Migration Completed**: The `reply` metadata approach has been successfully migrated to a first-class `HookContext.reply` field. This provides:

- ✅ Type safety - Full TypeScript type checking
- ✅ Better structure - Unified `ReplyContent` interface
- ✅ Clear ownership - Dedicated field in HookContext
- ✅ Extensibility - Easy to add new reply metadata types
- ✅ Consistency - Aligns with HookContext design patterns

**Current Implementation**:

- All reply data is stored in `context.reply` (type: `ReplyContent`)
- Helper functions provide type-safe access: `setReply()`, `getReply()`, `getReplyContent()`, `hasReply()`, `clearReply()`
- All legacy metadata keys (`reply`, `cardImage`, `isCardImage`) have been **completely removed**
- No backward compatibility code remains - the migration is complete

See `docs/CONTEXT_METADATA.md` for current usage documentation.
