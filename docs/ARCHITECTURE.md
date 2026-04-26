# QQ Bot Architecture Design Document

## Overview

This document describes the architecture of the QQ Bot framework, a production-ready TypeScript-based bot system built with Bun runtime. The framework supports multiple protocols (OneBot11, Milky, Satori) simultaneously, provides an AI-powered conversation pipeline, and includes a full agent cluster system for multi-worker coordination.

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Principles](#architecture-principles)
3. [Technology Stack](#technology-stack)
4. [System Architecture](#system-architecture)
5. [Component Details](#component-details)
6. [Data Flow](#data-flow)
7. [Protocol Support](#protocol-support)
8. [Configuration](#configuration)
9. [Plugin System](#plugin-system)
10. [Hook System](#hook-system)
11. [Command System](#command-system)
12. [TTS (Text-to-Speech)](#tts-text-to-speech)
13. [AI Service](#ai-service)
14. [Tool System](#tool-system)
15. [Memory System](#memory-system)
16. [Database Layer](#database-layer)
17. [Cluster System](#cluster-system)
18. [Error Handling](#error-handling)
19. [Development Workflow](#development-workflow)

## System Overview

### Purpose

The QQ Bot framework connects to QQ clients via LLBot (LuckyLilliaBot), a protocol forwarding layer that exposes multiple protocol endpoints simultaneously. The framework allows developers to:

- Connect to multiple protocols in parallel (Milky, OneBot11, Satori)
- Develop plugins that work across all protocols with a unified API
- Leverage protocol-specific advantages (e.g., OneBot11's rich ecosystem, Milky's modern features)
- Handle events from multiple protocols with automatic deduplication
- Run AI-powered conversations with multi-provider LLM support
- Execute LLM-callable tools with fine-grained visibility scopes
- Coordinate multi-worker agent clusters for parallel task execution

### Key Features

- **Multi-Protocol Support**: Simultaneously connect to and use multiple protocols
- **Type Safety**: Full TypeScript coverage with strict type checking
- **Event Deduplication**: Prevents duplicate event processing when same event arrives via multiple protocols
- **Protocol Abstraction**: Plugins work with unified interface, protocol details are hidden
- **AI-Powered Conversations**: Multi-provider LLM integration (OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, etc.)
- **Hook Pipeline**: 14 hook points for intercepting and modifying behavior at every stage
- **Extensible Plugin System**: Easy to add new features through config-based plugins
- **Tool System**: LLM-callable tools via `@Tool()` decorator with scoped visibility
- **Memory System**: Per-user and per-group long-term memory with LLM extraction
- **Agent Cluster**: Multi-worker coordination system for parallel AI task execution
- **Automatic Reconnection**: Robust connection management with exponential backoff

## Architecture Principles

1. **Type Safety First**: Every component is fully typed with TypeScript
2. **Multi-Protocol Support**: Simultaneously support OneBot11, Milky, Satori protocols
3. **Protocol Abstraction**: Unified interface hides protocol differences from plugins
4. **Event-Driven**: All communication flows through typed events (with deduplication)
5. **Separation of Concerns**: Each layer has a single, well-defined responsibility
6. **Extensibility**: Plugin system and hook system allow adding features without modifying core
7. **Dependency Injection**: Uses `tsyringe` for DI throughout the codebase
8. **Single Bootstrap Source**: All initialization logic is in `src/core/bootstrap.ts`

## Technology Stack

- **Runtime**: Bun (fast JavaScript/TypeScript runtime)
- **Language**: TypeScript (full type safety with strict mode)
- **Build Tool**: Bun's built-in bundler
- **Package Manager**: Bun
- **Dependency Injection**: tsyringe
- **Code Quality**: Biome (linter/formatter)
- **Configuration**: JSONC (JSON with Comments)
- **Database**: SQLite (via bun:sqlite) or MongoDB

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LLBot Server                              │
│         (Protocol Forwarding Layer)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │  Milky   │  │ OneBot11 │  │  Satori  │                 │
│  │ Endpoint │  │ Endpoint │  │ Endpoint │                 │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                 │
└───────┼─────────────┼─────────────┼─────────────────────────┘
        │             │             │
        └─────────────┴─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   ConnectionManager       │
        │  (Multi-Protocol Manager) │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   Protocol Adapters       │
        │  (Milky, OneBot11, Satori)│
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   EventDeduplicator       │
        │  (Remove Duplicates)      │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │     EventRouter           │
        │  (Route by Event Type)    │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   ConversationManager     │
        │  (Session Management)     │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   MessagePipeline         │
        │  (6-Stage Lifecycle)      │
        │  RECEIVE → PREPROCESS     │
        │  PROCESS → PREPARE        │
        │  SEND → COMPLETE          │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   HookManager             │
        │  (14 Hook Points)         │
        └───────────────────────────┘
```

### Layer Structure

The system is organized into the following layers:

1. **Core Layer** (`src/core/`): Bot lifecycle, connection management, configuration, DI container, bootstrap
2. **Protocol Layer** (`src/protocol/`): Protocol-specific adapters (Milky, OneBot11, Satori, Discord)
3. **API Layer** (`src/api/`): Unified API client, routing, context-based calls
4. **Event Layer** (`src/events/`): Event routing, deduplication, and handling
5. **Conversation Layer** (`src/conversation/`): ConversationManager, MessagePipeline, 6-stage lifecycle
6. **Hook Layer** (`src/hooks/`): 14 hook points for pipeline interception
7. **Command Layer** (`src/command/`): Prefix-based commands with permission levels
8. **AI Layer** (`src/ai/`): Multi-provider LLM integration, reply pipeline, image generation
9. **Agent Layer** (`src/agent/`): Sub-agent spawning and tool execution
10. **Tool Layer** (`src/tools/`): LLM-callable tools with @Tool() decorator
11. **Memory Layer** (`src/memory/`): Per-user/per-group long-term memory with LLM extraction
12. **Context Layer** (`src/context/`): HookContext building, conversation context management
13. **Database Layer** (`src/database/`): SQLite and MongoDB adapters
14. **Plugin Layer** (`src/plugins/`): Config-based plugin system
15. **Services Layer** (`src/services/`): MCP, Claude Code, card rendering, retrieval, static server
16. **Cluster Layer** (`src/cluster/`): Agent cluster for multi-worker coordination
17. **Message Layer** (`src/message/`): Message construction, parsing, and caching
18. **Agenda Layer** (`src/agenda/`): Scheduled task execution
19. **LAN Layer** (`src/lan/`): LAN relay and local network communication
20. **Utils Layer** (`src/utils/`): Logging, error handling, shared utilities
21. **CLI Layer** (`src/cli/`): Smoke-test, dev tooling
22. **Tests Layer** (`src/__tests__/`): Integration and unit tests

## Component Details

### Core Layer

#### Bot.ts

The main orchestrator class that coordinates all system components.

**Responsibilities:**
- Initialize and manage all system components
- Coordinate bot lifecycle (start, stop, restart)
- Provide access to ConnectionManager and Config
- Emit bot-level events (ready, error)

#### ConnectionManager.ts

Manages multiple protocol connections simultaneously.

**Responsibilities:**
- Connect to all enabled protocols in parallel
- Monitor connection health for all protocols
- Coordinate reconnection strategies across protocols
- Provide unified connection status

#### Config.ts

Manages configuration loading and validation. Supports both single-file and split-directory layouts.

**Configuration Resolution (priority order):**
1. Constructor argument: `new Config('/path/to/config.jsonc')` or `new Config('/path/to/config.d')`
2. `CONFIG_PATH` environment variable (file or directory)
3. `config.d/` directory in project root
4. `config.jsonc` file in project root

#### bootstrap.ts

Single source of truth for application initialization order. Both `src/index.ts` (production) and `src/cli/smoke-test.ts` call `bootstrapApp()`.

**Initialization sequence:**
```
Config → APIClient → PromptInitializer → PluginInitializer (factory) →
MCPInitializer → HealthCheckManager → RetrievalService → StaticServer →
ProjectRegistry → ClaudeCodeInitializer → ConversationInitializer →
ClusterManager → EventInitializer → ServiceRegistry.verify() →
ProtocolAdapterInitializer → PluginInitializer.loadPlugins() →
TTSManager (from tts.* config) + attachHealthManager → AvatarService (optional)
```

### Protocol Layer

#### ProtocolAdapter (Abstract Base Class)

Abstract base class for all protocol implementations.

**Key Methods:**
- `normalizeEvent(rawEvent)`: Convert protocol event to unified format
- `sendAPI(context)`: Send API request using `APIContext` object
- `onEvent(callback)`: Register event handler

#### Context-Based API Calls

The `sendAPI()` method accepts an `APIContext` object. This provides:
- Access to all call information (action, params, timeout, protocol) from a single object
- Request tracking via echo ID stored in context
- Better error messages with full context information
- Extensibility without changing method signatures

### API Layer

#### APIClient.ts

Unified API client providing protocol-agnostic interface.

**Key Methods:**
- `call(action, params, protocol?, timeout)`: Make an API call
- `registerAdapter(protocol, adapter)`: Register protocol adapter
- `getAvailableProtocols()`: List available protocols

#### APIRouter.ts

Routes API calls to appropriate protocol adapter.

**Routing Strategies:**
- **Priority**: Use preferred protocol first, fallback to others
- **Round-robin**: Distribute requests across protocols
- **Capability-based**: Choose protocol based on feature support

### Event Layer

#### EventRouter.ts

Routes normalized events to appropriate handlers.

**Event Types:**
- `message`: Private and group messages
- `notice`: Notifications (member join/leave, etc.)
- `request`: Friend/group requests
- `meta_event`: Heartbeat, lifecycle events

#### EventDeduplicator.ts

Prevents duplicate event processing from multiple protocols.

**Deduplication Strategies:**
- `first-received`: Process first event, ignore duplicates
- `priority-protocol`: Process event from highest-priority protocol
- `merge`: Merge data from multiple protocol versions

### Conversation Layer

#### ConversationManager

Manages per-session conversation state. Routes incoming message events to the `MessagePipeline` for the appropriate session.

#### MessagePipeline

Processes messages through the complete 6-stage lifecycle using `Lifecycle`.

**6-Stage Lifecycle:**

| Stage | Hook | Description |
|-------|------|-------------|
| RECEIVE | `onMessageReceived` | Message arrives, cached, initial metadata set |
| PREPROCESS | `onMessagePreprocess` | Permissions checked, filters applied |
| PROCESS | `onCommandDetected`, `onCommandExecuted` | Commands and AI tool execution |
| PREPARE | `onMessageBeforeAI`, `onAIGenerationStart`, `onAIGenerationComplete` | Reply generation |
| SEND | `onMessageBeforeSend`, `onMessageSent` | Message delivery |
| COMPLETE | `onMessageComplete` | Post-processing, history update |

Each stage can be intercepted and short-circuited via the Hook System. Message context is registered in async local storage so `PromptManager` can resolve the correct context per async chain.

### Message Layer

#### MessageBuilder.ts

Fluent API for constructing messages.

```typescript
const message = new MessageBuilder().text('Hello ').at(userId).text('!').build();
```

#### MessageParser.ts

Converts message segments to text or structured objects.

#### MessageCache

In-memory cache for recently seen messages (used for reply deduplication and reply-to resolution).

### Plugin System

#### Overview

Plugins are managed through configuration (`plugins.list`) and implemented in `src/plugins/plugins/`. They are **not** discovered by scanning the filesystem — the enabled set is determined by config.

#### PluginManager.ts

Manages plugin loading and lifecycle.

**Responsibilities:**
- Load plugins from `src/plugins/plugins/` directory (fixed path)
- Manage plugin lifecycle (init, enable, disable)
- Provide `PluginContext` to each plugin (API client, event router)
- Track enabled/disabled plugins per config

**Plugin Loading (config-based):**
1. Read `plugins.list` from config
2. For each enabled plugin, scan `src/plugins/plugins/` for a matching file
3. Call `plugin.loadConfig(context, entry)` then `plugin.onInit()`
4. If enabled, call `plugin.onEnable()`

#### PluginBase.ts

Abstract base class for plugins.

```typescript
export abstract class PluginBase {
  readonly name: string;
  readonly version: string;
  readonly description: string;

  onInit?(): void | Promise<void>;
  onEnable(): void | Promise<void>;
  onDisable(): void | Promise<void>;

  protected on<T extends NormalizedEvent>(eventType: string, handler: EventHandler<T>): void;
  protected off<T extends NormalizedEvent>(eventType: string, handler: EventHandler<T>): void;

  get api(): APIClient;
  get events(): EventRouter;
}
```

#### Plugin Interface

```typescript
interface Plugin extends PluginInfo, PluginHooks {
  loadConfig(context: PluginContext, pluginEntry?: PluginConfigEntry): void;
  onInit?(): void | Promise<void>;
  onEnable?(): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}
```

#### Plugin Context

```typescript
interface PluginContext {
  api: APIClient;    // Unified API client
  events: EventRouter; // Event router for subscribing to events
}
```

Config and other services are resolved from the DI container via `getContainer().resolve(DITokens.CONFIG)`.

#### Plugin Hooks (via decorator)

Plugins can register hook handlers using the `@Hook()` decorator:

```typescript
@Plugin({ name: 'my-plugin', version: '1.0.0', description: '...' })
export class MyPlugin extends PluginBase {
  @Hook('onMessageReceived', { priority: 10 })
  async onReceived(context: HookContext): Promise<boolean> {
    // intercept message
    return true; // return false to stop pipeline
  }
}
```

## Hook System

### Overview

The hook system provides 14 named interception points throughout the message processing pipeline. Plugins and core systems register handlers on hooks; the `HookManager` executes them in priority order.

### Core Hooks

Core hooks cover the message lifecycle:

| Hook Name | Stage | When Fired |
|-----------|-------|-----------|
| `onMessageReceived` | RECEIVE | Message arrives from protocol |
| `onMessagePreprocess` | PREPROCESS | After initial metadata enrichment |
| `onMessageBeforeSend` | SEND | Before reply is sent |
| `onMessageSent` | SEND | After reply is sent successfully |
| `onMessageComplete` | COMPLETE | After all post-processing |
| `onError` | Any | When an unhandled error occurs |

### Extended Hooks

Extended hooks are declared by subsystems at runtime:

| Hook Name | Declared By | When Fired |
|-----------|-------------|-----------|
| `onCommandDetected` | CommandSystem | When a command prefix is matched |
| `onCommandExecuted` | CommandSystem | After command handler runs |
| `onMessageBeforeAI` | GateCheckStage | Before the AI generation gate |
| `onAIGenerationStart` | GateCheckStage | After gate passes, before LLM call |
| `onAIGenerationComplete` | ResponseDispatchStage | After LLM response is ready |
| `onTaskBeforeExecute` | ToolManager | Before a tool call executes |
| `onTaskExecuted` | ToolManager | After a tool call completes |
| `onNoticeReceived` | EventInitializer | When a notice event is routed |

### HookManager.ts

Registers hooks and executes them in priority order.

- `register(hookName, priority)`: Declare a hook point
- `addHandler(hookName, handler, priority)`: Add a handler to an existing hook
- `execute(hookName, context)`: Run all registered handlers; returns `false` if any handler short-circuits

## Command System

### Overview

The command system provides prefix-based commands (e.g., `/help`) with three permission levels: owner, admin, and user.

### CommandManager.ts

**Responsibilities:**
- Auto-register decorated commands at startup
- Parse incoming messages for command prefixes
- Check permissions before dispatch
- Manage per-group enabled/disabled state

**Command Registration (via decorator):**

```typescript
@Command({
  name: 'help',
  description: 'Show help',
  permissions: [CommandPermission.USER],
  aliases: ['h'],
})
export class HelpCommand implements CommandHandler {
  async execute(context: CommandContext): Promise<CommandResult> {
    // ...
  }
}
```

Commands use lazy instantiation — handlers are created on first execution via DI.

**Permission Levels:**
- `OWNER`: Bot owner only
- `ADMIN`: Bot admins and owner
- `USER`: Any user

### CommandSystem

Sits inside the PROCESS stage of the message lifecycle. Fires `onCommandDetected` and `onCommandExecuted` hooks around each command execution.

## TTS (Text-to-Speech)

Text-to-speech is a **bot-core capability** (not part of the LLM stack). It lives under `packages/bot/src/services/tts/` and is registered in DI as `DITokens.TTS_MANAGER` from `packages/bot/src/core/bootstrap.ts`.

### Components

| Piece | Role |
|-------|------|
| `TTSManager` | Registry of `TTSProvider` instances, default provider (`tts.defaultProvider`), health-aware selection, and ordered fallback when the preferred or default provider is unavailable or fails a probe. |
| `TTSProvider` | Interface for backends (`synthesize`, optional `synthesizeStream`, optional `warmup`, optional `healthCheck`). |
| `FishAudioProvider` / `SovitsProvider` | Concrete providers; each implements `healthCheck()` (HTTP probe to the configured endpoint; SoVITS uses the same non-streaming shape as `synthesize` for POST). |
| `TtsProviderHealthAdapter` | Wraps a `TTSProvider` as `HealthCheckable`; service name is `provider.name` so `HealthCheckManager` and `TTSManager` share one namespace. |
| `TTSCommandHandler` | `/tts` command: resolves a provider via `TTSManager.resolveProvider()` (respects health), synthesizes audio, and on failure marks the provider unhealthy and retries another registered provider when possible. |

### Wiring

1. `bootstrapApp()` builds a `TTSManager`, instantiates providers from `tts` config (`tts.providers[]`, or the legacy single-provider `apiKey` shape for Fish Audio).
2. `ttsManager.attachHealthManager(healthCheckManager)` registers each provider with `HealthCheckManager` before the manager is exposed on DI.
3. Optional `warmup()` runs fire-and-forget for providers that support it (e.g. SoVITS cold start).

### Avatar package

`@qqbot/avatar` does **not** own TTS implementations. It receives the same `TTSManager` (or a minimal `AvatarTTSManager` / `AvatarTTSProvider` view in `packages/avatar/src/speech/`) for `SpeechService` and preview; utterance splitting lives in `packages/avatar/src/speech/splitIntoUtterances.ts`.

## AI Service

### Overview

`AIService` is a pure facade that delegates to specialized sub-services. It is the entry point for all AI capabilities used by `ReplySystem`.

### Sub-services

| Sub-service | Responsibility |
|-------------|---------------|
| `ReplyPipelineOrchestrator` | Normal reply generation (multi-stage pipeline) |
| `NsfwReplyService` | NSFW-mode reply generation |
| `ProactiveReplyGenerationService` | Proactive group reply generation |
| `ImageFacadeService` | Image generation (text2img, img2img, i2v) with hook lifecycle |
| `SubAgentManager` | Sub-agent spawning and execution |
| `VisionService` | Image understanding and explanation |

### AI Reply Pipeline

The reply pipeline inside `ReplyPipelineOrchestrator` is composed of ordered stages:

1. `ContextResolutionStage` — Resolve conversation session and history
2. `GateCheckStage` — Run `onMessageBeforeAI` / `onAIGenerationStart` hooks
3. `HistoryStage` — Load and compress conversation history
4. `ContextEnrichmentStage` — Attach memory, retrieval results
5. `PromptAssemblyStage` — Build system + user prompt from templates
6. `ProviderSelectionStage` — Select LLM provider via `ProviderSelector`
7. `GenerationStage` — Execute LLM call with tool loop
8. `ResponseDispatchStage` — Fire `onAIGenerationComplete`, dispatch reply

### AI Providers

Multi-provider support is handled by `AIManager` + `ProviderRouter`:

- OpenAI / OpenAI-compatible
- Anthropic (Claude)
- DeepSeek
- Doubao (ByteDance)
- Gemini
- Minimax
- Ollama (local)

## Tool System

### Overview

LLM-callable tools are defined via the `@Tool()` decorator in `src/tools/executors/`. The `ToolManager` auto-registers all decorated tools at startup using lazy executor instantiation.

### Tool Definition

```typescript
@Tool({
  name: 'search',
  description: 'Search the web for information',
  executor: 'SearchExecutor',
  visibility: ['reply', 'subagent'],
  parameters: { ... },
})
@injectable()
export class SearchExecutor implements ToolExecutor {
  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    // ...
  }
}
```

### Visibility Scopes

| Scope | Where the tool is available |
|-------|-----------------------------|
| `reply` | Main reply generation loop |
| `subagent` | Sub-agent spawned by the bot |
| `internal` | Internal system use only |

### ToolManager

- `autoRegisterTools()`: Discovers all `@Tool()` decorated classes and registers them
- `executeTool(call, context, hookManager)`: Execute a tool, firing `onTaskBeforeExecute` / `onTaskExecuted` hooks
- Executors are created on-demand via DI (`tsyringe`)

## Memory System

### Overview

`MemoryService` provides file-based long-term memory for each user and group. Memories persist in `data/memory/` and are injected into LLM prompts during context enrichment.

### Storage Layout

```
data/memory/
├── {groupId}/
│   ├── _global_/         # Group-level memory
│   │   └── auto.txt      # LLM-extracted group memory
│   └── {userId}/         # Per-user memory within a group
│       ├── manual.txt    # Human-authored memory
│       └── auto.txt      # LLM-extracted memory
```

### Memory Layers

| Layer | Source | Description |
|-------|--------|-------------|
| `manual` | Human-authored | Written directly into memory files |
| `auto` | LLM-extracted | Extracted by the bot from conversation history |

### Hierarchical Scopes

Memory is organized into named scopes using a `[scope:subtag]` syntax:

```
[preference:food]
Likes spicy food

[identity]
Name: Alice
```

Core scopes: `instruction`, `rule`, `preference`, `identity`, `fact`, and custom scopes.

### Optional RAG Support

When RAG is configured, `MemoryRAGService` uses Ollama embeddings + Qdrant vector search to perform semantic retrieval instead of keyword matching.

## Database Layer

### Overview

`DatabaseManager` creates and manages a single database adapter based on config. Two adapter types are supported.

### Adapters

| Adapter | Backend | Usage |
|---------|---------|-------|
| `SQLiteAdapter` | bun:sqlite | Default, recommended for single-instance |
| `MongoDBAdapter` | MongoDB | For distributed or multi-instance deployments |

### Initialization

```
DatabaseManager.initialize(config)
  → creates adapter (SQLiteAdapter or MongoDBAdapter)
  → adapter.connect()
  → adapter.migrate()    ← runs schema migrations automatically
```

The Agent Cluster requires SQLite — it uses the raw `bun:sqlite` `Database` handle directly for SQLite-specific operations.

## Cluster System

### Overview

The Agent Cluster (`src/cluster/`) enables multi-worker parallel task execution. A planner LLM decomposes high-level goals into subtasks; workers execute them concurrently with file-lock coordination via `ContextHub`.

### Key Components

| Component | Responsibility |
|-----------|---------------|
| `ClusterManager` | Top-level orchestrator; initializes all sub-components |
| `ContextHub` | Shared coordination hub — lock manager, event log, message box |
| `WorkerPool` | Spawns and manages worker subprocesses |
| `ClusterScheduler` | Assigns tasks to workers; persists task state to SQLite |
| `PlannerService` | Uses LLM to decompose goals into task plans |
| `LockManager` | File-level lock granting/releasing for workers |
| `EventLog` | Append-only event log for cluster activity |

### Worker Backends

Workers are spawned as CLI subprocesses using one of:

| Backend | CLI Tool |
|---------|----------|
| `ClaudeCliBackend` | `claude` (Claude Code CLI) |
| `GeminiCliBackend` | `gemini` (Gemini CLI) |
| `CodexCliBackend` | `codex` (OpenAI Codex CLI) |
| `MinimaxBackend` | Minimax API |

### Task Sources

Tasks can be fed from:
- `TodoFileSource`: Reads a todo markdown file
- `QueueSource`: In-memory queue for programmatic task injection

### Worker Protocol

Workers communicate with the hub via MCP tool calls (`hub_claim`, `hub_report`, `hub_sync`, `hub_ask`, `hub_message`). The hub is exposed as an MCP server (`HubMCPServer`).

## Data Flow

### Incoming Event Flow

```
LLBot Server
    ↓ (WebSocket)
ConnectionManager
    ↓ (raw protocol messages)
Protocol Adapters (Milky, OneBot11, Satori)
    ↓ (normalize to BaseEvent)
EventDeduplicator
    ↓ (deduplicated events)
EventRouter
    ↓ (routed by type)
ConversationManager
    ↓ (per-session dispatch)
MessagePipeline
    ↓ (6-stage lifecycle with HookManager)
PluginManager → Plugins (via hook handlers)
```

### Outgoing API Flow

```
Plugin or System
    ↓ (api.call(action, params))
APIClient.call()
    ↓ (creates APIContext)
APIRouter.getAdapter(context)
    ↓ (selects protocol, stores in context)
ProtocolAdapter.sendAPI(context)
    ↓ (extracts action/params/echo from context)
Connection (WebSocket/HTTP)
    ↓
LLBot Server
    ↓ (response)
ProtocolAdapter
    ↓ (correlate via echo ID in context)
APIClient → caller
```

### AI Reply Flow

```
MessagePipeline (PREPARE stage)
    ↓
ReplySystem
    ↓
AIService.generateReply(hookContext)
    ↓
ReplyPipelineOrchestrator
    ↓  ContextResolutionStage
    ↓  GateCheckStage (onMessageBeforeAI → onAIGenerationStart)
    ↓  HistoryStage
    ↓  ContextEnrichmentStage (memory, retrieval)
    ↓  PromptAssemblyStage
    ↓  ProviderSelectionStage
    ↓  GenerationStage (LLM call + tool loop)
    ↓  ResponseDispatchStage (onAIGenerationComplete)
    ↓
Reply segments → MessagePipeline (SEND stage)
```

## Protocol Support

### Multi-Protocol Design

1. **Milky Protocol** (Primary)
   - Modern protocol design
   - Endpoint: `ws://host:3011/event`

2. **OneBot11 Protocol** (Fallback)
   - Rich ecosystem and community resources
   - Endpoint: `ws://host:3010/event`

3. **Satori Protocol** (Optional)
   - Endpoint: `ws://host:3012/event`

4. **Discord** (Optional)
   - Via `DiscordConnection`

### Event Deduplication

Since all protocols connect to the same LLBot server (same QQ account), events may arrive via multiple protocols simultaneously. `EventDeduplicator` ensures each event is processed only once.

**Deduplication window:** configurable (default 5000ms)
**Event fingerprint:** message ID + timestamp + content hash + event type

## Configuration

### Configuration File Layouts

The bot supports two layouts:

**Single file** (`config.jsonc`):
```jsonc
{
  "protocols": [ ... ],
  "database": { "type": "sqlite", "sqlite": { "path": "./data/db.sqlite" } },
  "bot": { "ownerId": 123456789 },
  "ai": { "defaultProvider": "openai", "providers": { ... } },
  "plugins": { "list": [ { "name": "echo", "enabled": true } ] }
}
```

**Split directory** (`config.d/`):
```
config.d/
├── protocols.jsonc
├── database.jsonc
├── bot.jsonc
├── ai.jsonc
└── plugins.jsonc
```

### Configuration Resolution Order

1. Constructor argument: `new Config('/path/to/config.d')` or `new Config('/path/to/config.jsonc')`
2. `CONFIG_PATH` environment variable (file or directory)
3. `config.d/` directory in project root
4. `config.jsonc` file in project root

### Key Configuration Sections

| Section | Purpose |
|---------|---------|
| `protocols` | Connection URLs and access tokens per protocol |
| `database` | Adapter type (sqlite/mongodb) and connection details |
| `bot` | Owner ID, admin IDs, self ID |
| `ai` | Default providers and API keys |
| `plugins.list` | Enabled plugins and per-plugin config |
| `prompts` | Directory for prompt templates (default: `./prompts`) |
| `memory` | Memory directory and RAG settings |
| `cluster` | Agent cluster configuration |
| `mcp` | MCP server list |

## Error Handling

### Error Types

- **ConfigError**: Configuration loading/validation errors
- **APIError**: API call failures
- **ConnectionError**: Connection-related errors

### Strategy

- **Connection Errors**: Automatic reconnection with exponential backoff
- **API Errors**: Propagated to caller with context
- **Plugin Errors**: Caught and logged; do not crash the bot
- **Pipeline Errors**: Fire `onError` hook; logged with full context
- **Configuration Errors**: Fail fast with clear error messages

## Development Workflow

### Project Structure

```
qqbot/
├── src/
│   ├── __tests__/       # Integration and unit tests
│   ├── agenda/          # Scheduled task execution
│   ├── agent/           # Sub-agent spawning and tool running
│   ├── ai/              # AI service, providers, reply pipeline
│   ├── api/             # Unified API client and routing
│   ├── cli/             # Smoke-test, dev CLI tools
│   ├── cluster/         # Agent cluster (multi-worker coordination)
│   ├── command/         # Command system with permission levels
│   ├── context/         # HookContext builder and message context storage
│   ├── conversation/    # ConversationManager, MessagePipeline, Lifecycle
│   ├── core/            # Bot, Config, ConnectionManager, DI, bootstrap
│   ├── database/        # SQLite and MongoDB adapters
│   ├── events/          # EventRouter, EventDeduplicator, handlers
│   ├── hooks/           # HookManager and hook types
│   ├── lan/             # LAN relay and local network communication
│   ├── memory/          # Per-user/per-group memory service
│   ├── message/         # MessageBuilder, MessageParser, MessageCache
│   ├── plugins/         # Plugin system, PluginBase, built-in plugins
│   ├── protocol/        # Protocol adapters (Milky, OneBot11, Satori, Discord)
│   ├── services/        # MCP, ClaudeCode, card rendering, retrieval
│   ├── tools/           # Tool system with @Tool() decorator
│   ├── utils/           # Logger, error handling, shared utilities
│   └── index.ts         # Entry point
├── prompts/             # Prompt template directory
├── data/                # Runtime data (memory, SQLite DB)
├── docs/                # Architecture and design documents
├── config.jsonc         # Configuration file (local, not committed)
├── config.example.jsonc # Example configuration
├── tsconfig.json        # TypeScript config
├── package.json         # Dependencies
└── README.md            # Documentation
```

### Development Commands

```bash
# Development with hot reload + WebUI
bun run dev

# Production build and start
bun run build && bun run start

# Type checking
bun run typecheck

# Linting and formatting
bun run lint          # Check for issues
bun run lint:fix      # Auto-fix issues
bun run format        # Format code

# Testing
bun test

# Smoke test (MANDATORY before committing)
bun run smoke-test

# Debug mode with mock message sending
bun run debug
```

### Why smoke-test is Mandatory

`typecheck` and `build` only validate static types. They cannot catch runtime initialization issues such as circular imports causing TDZ errors, DI tokens referenced before registration, or missing DI bindings. The `smoke-test` runs the exact same `bootstrapApp()` function as production, verifying that every service, plugin, and tool executor initializes successfully without live network connections.

### Type Safety

The entire codebase uses TypeScript with strict mode enabled:

- All functions and methods are fully typed
- Protocol events and API calls are type-safe
- Plugin interfaces are typed
- Configuration is type-checked via generated types
