---
name: Stage 2 Architecture Refinements
overview: "Refine Stage 2 architecture: simplify hooks to message-only lifecycle, implement decorator-based command registration with permissions, migrate APIClient to use context, and add Ollama provider implementation."
todos:
  - id: hook-refactor
    content: Simplify HookManager to only include message lifecycle hooks (onMessageReceived, onMessagePreprocess, onMessageBeforeSend, onMessageSent, onError)
    status: pending
  - id: hook-extension-mechanism
    content: Design extension mechanism for command/task hooks (via plugins or core extensions)
    status: pending
  - id: hook-pipeline-update
    content: Update MessagePipeline to remove command/task hook calls, keep only message hooks
    status: pending
  - id: hook-docs
    content: Update ARCHITECTURE_STAGE2.md documentation to reflect simplified hook structure and extension mechanism
    status: pending
  - id: command-decorator
    content: Create @Command() decorator with permissions, description, usage, aliases parameters
    status: pending
  - id: command-permissions
    content: Implement permission checking system (admin, user, group_admin, etc.)
    status: pending
  - id: command-manager-static
    content: Add static registration support to CommandManager for decorator-based registration
    status: pending
  - id: command-handlers-decorate
    content: Add @Command() decorators to BuiltinCommandHandler classes with appropriate permissions
    status: pending
  - id: command-initializer
    content: Update ConversationInitializer to use decorator-based registration instead of manual registration
    status: pending
  - id: api-context
    content: Extend APIClient.call() to accept optional ConversationContext parameter
    status: pending
  - id: api-pipeline
    content: Update MessagePipeline to pass context to APIClient calls
    status: pending
  - id: ollama-provider
    content: Create OllamaProvider implementation with HTTP API support
    status: pending
  - id: ollama-register
    content: Register Ollama provider in ConversationInitializer when configured
    status: pending
---

# Stage 2 Architecture Refinements

## Overview

This plan addresses four key architectural improvements:

1. Simplify hook system to message-only lifecycle, with command/task hooks as optional extensions
2. Implement decorator-based command registration with permission system
3. Migrate APIClient to use new context system
4. Add Ollama AI provider implementation

## 1. Hook System Simplification

### Problem

Current hooks include command-specific (`onCommandDetected`, `onCommandExecuted`) and task-specific (`onTaskAnalyzed`, `onTaskBeforeExecute`, `onTaskExecuted`) hooks, as well as AI-specific hooks. These treat implementation details (command system, task system) as core lifecycle stages. However, these are optional mechanisms that may not be loaded.

### Solution

**Core Hook System** - Only message lifecycle hooks:

- `onMessageReceived` - message received from user
- `onMessagePreprocess` - before message processing (command/task/AI processing happens here)
- `onMessageBeforeSend` - before sending reply message
- `onMessageSent` - reply message sent successfully
- `onError` - error occurred during any stage

**Extension Mechanism** - Command/Task hooks provided by extensions:

- Command hooks (`onCommandDetected`, `onCommandExecuted`) can be provided by a command extension/plugin
- Task hooks (`onTaskAnalyzed`, `onTaskBeforeExecute`, `onTaskExecuted`) can be provided by a task extension/plugin
- These hooks are only available if the corresponding extension is loaded
- Extensions register their hooks with HookManager when loaded

### Files to modify

- `src/plugins/HookManager.ts` - simplify HookName type to only core message hooks
- `src/plugins/HookRegistry.ts` - support extension hook registration
- `src/conversation/MessagePipeline.ts` - remove command/task hook calls, keep only message hooks
- `src/command/CommandManager.ts` - optionally register command hooks if command system is enabled
- `src/task/TaskManager.ts` - optionally register task hooks if task system is enabled
- `docs/ARCHITECTURE_STAGE2.md` - document core hooks and extension mechanism

### Implementation details

- Core hooks are always available
- Extensions (command system, task system) can register additional hooks when initialized
- HookManager supports dynamic hook registration (hooks can be added/removed at runtime)
- MessagePipeline only calls core hooks, extensions handle their own hook calls internally
- Hook context still contains `command`, `task`, `aiResponse`, `context` fields for hooks that need them

## 2. Decorator-Based Command Registration with Permissions

### Problem

Currently commands are manually registered in `ConversationInitializer.ts`:

```typescript
commandManager.register(new HelpCommand(commandManager), 100);
commandManager.register(new StatusCommand(), 100);
commandManager.register(new PingCommand(), 100);
```

This requires modifying registration code when adding/removing commands. Also, there's no permission system to control who can use which commands.

### Solution

Implement a decorator-based registration system with permission support:

- Create `@Command()` decorator with comprehensive options:
  - `name`: command name (required)
  - `description`: command description
  - `usage`: usage example/format
  - `permissions`: permission requirements (array of permission levels)
  - `aliases`: command aliases
  - `enabled`: whether command is enabled (default: true)
- Commands register themselves when their class is loaded
- Permission checking happens before command execution
- No manual registration needed in ConversationInitializer

### Permission System Design

Permission levels:

- `user` - any user (default)
- `group_admin` - group administrator
- `group_owner` - group owner
- `admin` - bot administrator (configured user IDs)
- `owner` - bot owner (single user ID)

Permission checking:

- Check user role from message event (`event.sender?.role`)
- Check configured admin/owner IDs from config
- Commands can require multiple permissions (all must match)

### Files to create/modify

- `src/command/decorators.ts` - create `@Command()` decorator with permission support
- `src/command/types.ts` - add permission types and CommandMetadata interface
- `src/command/CommandManager.ts` - add static registration, permission checking
- `src/command/handlers/BuiltinCommandHandler.ts` - add decorators to command classes
- `src/conversation/ConversationInitializer.ts` - remove manual registration, import command classes to trigger registration
- `src/core/Config.ts` - add admin/owner user ID configuration

### Implementation details

- Decorator stores registration metadata on class (using Symbol or metadata API)
- CommandManager has static registry that decorator populates
- On CommandManager instantiation, auto-register all decorated commands
- Permission checking in `CommandManager.execute()` before calling handler
- Handle circular dependencies (HelpCommand needs CommandManager reference)
- Permission denied returns appropriate error message

## 3. APIClient Context Migration

### Problem

APIClient currently doesn't use the new context system. It should accept ConversationContext to provide better integration.

### Solution

- Extend APIClient.call() to accept optional ConversationContext
- Store context in APIContext.metadata
- Update MessagePipeline to pass context when calling APIClient

### Files to modify

- `src/api/APIClient.ts` - add context parameter to call() method
- `src/api/types.ts` - ensure APIContext can store ConversationContext
- `src/conversation/MessagePipeline.ts` - pass context to apiClient.call()

### Implementation details

- Context passed via APIContext.metadata.set('conversationContext', context)
- Backward compatible - context parameter is optional
- Protocol adapters can access context from APIContext if needed

## 4. Ollama Provider Implementation

### Problem

Only OpenAI provider exists. Need Ollama provider for local testing.

### Solution

- Create OllamaProvider similar to OpenAIProvider
- Support Ollama's HTTP API (typically http://localhost:11434)
- Register in ConversationInitializer when configured

### Files to create

- `src/ai/providers/OllamaProvider.ts` - Ollama provider implementation

### Files to modify

- `src/conversation/ConversationInitializer.ts` - register Ollama provider
- `src/ai/index.ts` - export OllamaProvider

### Implementation details

- Use fetch/axios for HTTP requests to Ollama API
- Support `/api/generate` and `/api/chat` endpoints
- Config: `{ baseURL: string, model: string, ... }`
- Handle streaming responses similar to OpenAI
- Check availability by pinging Ollama endpoint

## Implementation Order

1. Hook system simplification (core message hooks only)
2. Extension mechanism design (for command/task hooks)
3. Decorator-based command registration with permissions
4. APIClient context migration
5. Ollama provider implementation

## Testing Considerations

- Verify core hooks work correctly after simplification
- Test extension mechanism for command/task hooks
- Test decorator registration with permissions
- Test permission checking with different user roles
- Ensure APIClient backward compatibility
- Test Ollama provider with local instance

## Design Decisions

### Hook Extension Mechanism

Two possible approaches:

**Option A: Plugin-based extensions**

- Command/Task systems register hooks as plugins
- Hooks are only available if plugin is loaded
- More flexible but requires plugin system integration

**Option B: Core extension registration**

- Command/Task systems register hooks directly with HookManager
- Hooks available if system is initialized
- Simpler but less flexible

**Recommendation**: Option B for now, can migrate to Option A later if needed. Command/Task systems are core features, not optional plugins.

### Permission System

Permission levels hierarchy:

- `user` (lowest) - any user
- `group_admin` - group administrator
- `group_owner` - group owner
- `admin` - bot administrator (configurable)
- `owner` (highest) - bot owner (single user)

Commands can specify required permission level. Higher permissions inherit lower permissions (e.g., `admin` can use `user` commands).

Permission checking:

- Check message event for user role (group_admin, group_owner)
- Check config for admin/owner user IDs
- Private messages: check if user is admin/owner
- Group messages: check role and admin/owner status
