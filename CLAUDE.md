# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

```bash
# Development with hot reload + WebUI
bun run dev

# Production build and start
bun run build && bun run start

# Type checking
bun run typecheck
# or
bun run type-check

# Linting and formatting
bun run lint          # Check for issues
bun run lint:fix      # Auto-fix issues
bun run format        # Format code

# Testing
bun test

# Smoke test (MANDATORY before committing — validates full initialization)
bun run smoke-test

# Debug mode with mock message sending
bun run debug

# Build WebUI separately
bun run build:admin
```

## High-Level Architecture

This is a production-ready QQ bot framework built with TypeScript and Bun. It connects to QQ via LLBot (supporting Milky/OneBot11/Satori protocols) and provides an AI-powered conversation pipeline.

### Core Pipeline Flow

1. **Protocol Layer**: Multi-protocol WebSocket connections (Milky, OneBot11, Satori) with automatic reconnection and deduplication
2. **Event Processing**: `ConnectionManager → Protocol Adapters → EventDeduplicator → EventRouter → ConversationManager`
3. **Message Pipeline**: 6-stage lifecycle:
   - `RECEIVE`: Message arrives
   - `PREPROCESS`: Metadata, permissions, filtering
   - `PROCESS`: Commands and AI tool execution
   - `PREPARE`: Reply generation
   - `SEND`: Message delivery
   - `COMPLETE`: Post-processing
4. **Hook System**: 13 hook points for plugins to intercept and modify behavior at each stage
5. **AI Integration**: Multi-provider support (OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, etc.)

### Key Architectural Components

- **Dependency Injection**: Uses `tsyringe` for DI throughout the codebase
- **Protocol Abstraction**: Unified API across different protocols with automatic routing
- **Tool System**: LLM-callable tools (search, memory, fetch_page, etc.) with visibility scopes (`reply`/`subagent`/`internal`). Defined via `@Tool()` decorator in `src/tools/executors/`
- **Command System**: Prefix-based commands with owner/admin/user permission levels
- **Memory System**: Per-user and per-group long-term memory with LLM extraction
- **Plugin System**: Extends functionality via `PluginBase` class and hook registration
- **Database**: Supports both SQLite and MongoDB for persistence
- **Card Rendering**: Uses Puppeteer to render long replies as images

### Important Design Patterns

- **Context-Based API Calls**: All API calls use `APIContext` objects for better tracking and extensibility
- **Hook Context Metadata**: Rich metadata flows through the pipeline via `HookContext`
- **System-Based Processing**: Modular systems (CommandSystem, ReplySystem) handle different pipeline stages
- **Prompt Templates**: Split structure with base system + scene system + assembled user messages

## Configuration Requirements

The bot requires a `config.jsonc` file (JSONC with comments). Copy from `config.example.jsonc` and configure:

- **protocols**: Connection URLs and access tokens for each protocol
- **database**: Type (sqlite/mongodb) and connection details
- **bot**: Owner ID and optional admin IDs
- **ai**: Default providers and API keys for each AI service
- **prompts**: Directory for prompt templates (default: `./prompts`)

## Code Conventions

- **TypeScript Strict Mode**: All code uses strict TypeScript
- **Path Aliases**: Use `@/` for `src/` imports
- **Formatting**: 2-space indentation, single quotes, trailing commas (Biome)
- **Dependency Injection**: Use `@injectable()` and `@singleton()` decorators
- **Async/Await**: Prefer async/await over callbacks
- **Error Handling**: Custom error types (ConfigError, APIError, ConnectionError)

## Testing Approach

When testing changes:
1. Run `bun run typecheck` — static type checking
2. Run `bun run lint` — code quality
3. Run `bun run smoke-test` — **MANDATORY**. Boots the real application through the full initialization path (`src/core/bootstrap.ts`), verifying DI registration, module loading order, and plugin initialization. This catches circular imports, TDZ errors, and missing DI tokens that typecheck cannot detect. **A change is NOT considered fixed/complete until smoke-test passes.**
4. Use `bun run debug` for interactive mock message testing when needed
5. Check WebSocket connections with `LOG_LEVEL=debug` for protocol-level debugging

### Why smoke-test is required

`typecheck` and `build` only validate static types — they cannot catch runtime initialization order issues (circular imports causing TDZ errors, DI tokens referenced before registration, etc.). The `smoke-test` runs the exact same `bootstrapApp()` function as `src/index.ts`, ensuring every service, plugin, and tool executor initializes successfully without live network connections.

### Bootstrap architecture

All initialization logic lives in `src/core/bootstrap.ts` as a single `bootstrapApp()` function. Both `src/index.ts` (production) and `src/cli/smoke-test.ts` call this same function. When adding new services or changing initialization order, only modify `bootstrap.ts` — never duplicate initialization logic elsewhere.

## Plugin Development

Plugins extend `PluginBase` and use the plugin context API:

```typescript
export class MyPlugin extends PluginBase {
  name = 'my-plugin';

  async onEnable(context: PluginContext) {
    // Register hooks, commands, etc.
    context.hookManager.registerCommand({
      name: 'mycommand',
      handler: this.handleCommand.bind(this),
      permission: CommandPermission.USER
    });
  }
}
```

## Database Migrations

The bot automatically handles database schema initialization. For SQLite, tables are created on first run. For MongoDB, collections are created as needed.

## Environment Variables

- `LOG_LEVEL`: Set to `debug` for verbose logging (default: `info`)
- `CONFIG_PATH`: Override config file location (default: `./config.jsonc`)

## Important Files and Locations

- **Entry Point**: `src/index.ts`
- **Bootstrap (initialization single source of truth)**: `src/core/bootstrap.ts`
- **Core Bot**: `src/core/Bot.ts`
- **Message Pipeline**: `src/conversation/MessagePipeline.ts`
- **AI Service**: `src/ai/AIService.ts`
- **Tool System**: `src/tools/ToolManager.ts`
- **Plugin Manager**: `src/plugins/PluginManager.ts`
- **Configuration**: `config.jsonc` (local, not committed)