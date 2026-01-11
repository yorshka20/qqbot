---
name: QQ Bot Architecture Design (TypeScript + Bun)
overview: Design a production-ready TypeScript-based QQ bot architecture using Bun runtime, supporting multiple protocols (OneBot11, Milky, Satori) simultaneously with proper build, type safety, and development tooling. LLBot acts as a protocol forwarding layer that exposes multiple protocol endpoints, allowing the bot to leverage OneBot11's rich ecosystem while using other protocols as needed.
todos:
  - id: setup-typescript
    content: Setup TypeScript configuration (tsconfig.json) with Bun-specific settings and path aliases
    status: completed
  - id: setup-bun-config
    content: Configure Bun runtime (bunfig.toml), package.json scripts, and build configuration
    status: completed
  - id: setup-dev-tools
    content: "Setup development tools: ESLint/Biome, Prettier, type definitions, and git hooks"
    status: completed
  - id: create-structure
    content: Create TypeScript directory structure with type definitions
    status: completed
  - id: type-definitions
    content: Create TypeScript type definitions for protocols, events, API, and messages
    status: completed
  - id: core-modules
    content: "Implement core modules: Bot.ts, ConnectionManager.ts, Connection.ts, Config.ts with full type safety"
    status: completed
  - id: protocol-adapters
    content: "Implement protocol layer: ProtocolAdapter base class, OneBot11Adapter, MilkyAdapter, SatoriAdapter with types"
    status: pending
  - id: api-layer
    content: "Implement API layer: APIClient, APIRouter, RequestManager, typed API method wrappers"
    status: pending
  - id: event-system
    content: "Implement event system: EventRouter, EventDeduplicator, EventEmitter, typed event handlers"
    status: pending
  - id: message-utils
    content: "Implement message utilities: MessageSegment, MessageBuilder, MessageParser with types"
    status: pending
  - id: plugin-system
    content: "Implement plugin system: PluginManager, PluginBase, example plugin with TypeScript"
    status: pending
  - id: utils-logging
    content: "Implement utilities: logger, error classes with proper types"
    status: completed
  - id: build-config
    content: Configure build and bundling for production deployment
    status: pending
  - id: refactor-entry
    content: Refactor index.ts to use new architecture and create typed configuration
    status: pending
  - id: documentation
    content: Create comprehensive README.md with architecture, setup, and usage examples
    status: pending
---

# QQ Bot Architecture Design (TypeScript + Bun)

## Current State Analysis

Your current implementation (`index.js`) contains all functionality in a single file:

- WebSocket connection management
- API request/response handling
- Event routing and processing
- Message segment conversion
- Basic event handlers

## Key Understanding

**LLBot (LuckyLilliaBot) is a protocol forwarding layer** that:

- Connects to QQ client (NTQQ) via LiteLoaderQQNT
- Simultaneously exposes multiple protocol endpoints (OneBot11, Satori, Milky)
- Each protocol has its own endpoint (different ports/URLs)
- Same underlying data source (same QQ account), different protocol formats

**Design Goal**: Support multiple protocols simultaneously to:

- Leverage OneBot11's rich ecosystem and community resources
- Use Milky/Satori for modern features or specific frameworks
- Benefit from protocol-specific advantages
- Maintain flexibility and future-proofing

## Technology Stack

- **Runtime**: Bun (fast JavaScript/TypeScript runtime)
- **Language**: TypeScript (full type safety)
- **Build Tool**: Bun's built-in bundler
- **Package Manager**: Bun (or pnpm for compatibility)
- **Code Quality**: ESLint/Biome + Prettier
- **Type Definitions**: Full TypeScript types for all protocols
- **Multi-Protocol**: Support OneBot11, Milky, Satori simultaneously

## Proposed Architecture

### Directory Structure

```
qqbot/
├── src/
│   ├── core/
│   │   ├── Bot.ts              # Main bot class orchestrating everything
│   │   ├── ConnectionManager.ts # Multi-protocol connection management
│   │   ├── Connection.ts       # Single protocol WebSocket connection
│   │   └── Config.ts           # Configuration management
│   ├── protocol/
│   │   ├── base/
│   │   │   ├── ProtocolAdapter.ts       # Base protocol adapter interface
│   │   │   └── types.ts                 # Protocol base types
│   │   ├── onebot11/
│   │   │   ├── OneBot11Adapter.ts       # OneBot11 protocol implementation
│   │   │   ├── types.ts                 # OneBot11 event and API types
│   │   │   └── events.ts                # OneBot11 event definitions
│   │   ├── milky/
│   │   │   ├── MilkyAdapter.ts          # Milky protocol implementation
│   │   │   ├── types.ts                 # Milky event and API types
│   │   │   └── events.ts                # Milky event definitions
│   │   └── satori/
│   │       ├── SatoriAdapter.ts         # Satori protocol implementation
│   │       ├── types.ts                 # Satori event and API types
│   │       └── events.ts                # Satori event definitions
│   ├── api/
│   │   ├── APIClient.ts        # Unified multi-protocol API client
│   │   ├── APIRouter.ts        # Routes API calls to appropriate protocol
│   │   ├── RequestManager.ts   # Request/response tracking with echo IDs
│   │   ├── types.ts            # API request/response types
│   │   └── methods/            # API method wrappers
│   │       ├── MessageAPI.ts   # send_private_msg, send_group_msg, etc.
│   │       ├── FriendAPI.ts    # Friend-related APIs
│   │       └── GroupAPI.ts     # Group-related APIs
│   ├── events/
│   │   ├── EventEmitter.ts     # Event bus for internal events
│   │   ├── EventRouter.ts      # Routes protocol events to handlers
│   │   ├── EventDeduplicator.ts # Deduplicates events from multiple protocols
│   │   ├── types.ts            # Event type definitions
│   │   └── handlers/           # Event handlers
│   │       ├── MessageHandler.ts
│   │       ├── NoticeHandler.ts
│   │       ├── RequestHandler.ts
│   │       └── MetaEventHandler.ts
│   ├── message/
│   │   ├── MessageSegment.ts   # Message segment utilities and types
│   │   ├── MessageBuilder.ts   # Builder for constructing messages
│   │   ├── MessageParser.ts    # Parse message segments to text/objects
│   │   └── types.ts            # Message type definitions
│   ├── plugins/
│   │   ├── PluginManager.ts    # Plugin loading and lifecycle
│   │   ├── PluginBase.ts      # Base class for plugins
│   │   ├── types.ts            # Plugin type definitions
│   │   └── examples/           # Example plugins
│   │       └── EchoPlugin.ts
│   ├── utils/
│   │   ├── logger.ts           # Logging utility with types
│   │   └── errors.ts           # Custom error classes
│   └── index.ts                # Entry point
├── types/                      # Global type definitions
│   └── global.d.ts             # Global type augmentations
├── config/
│   ├── default.json            # Default configuration
│   └── schema.json             # JSON schema for config validation
├── plugins/                     # User plugins directory
├── scripts/                     # Build and utility scripts
│   └── build.ts                # Build script
├── .env.example                 # Environment variables template
├── .env                         # Environment variables (gitignored)
├── tsconfig.json                # TypeScript configuration
├── bunfig.toml                  # Bun runtime configuration
├── package.json                 # Dependencies and scripts
├── biome.json                   # Biome configuration (or .eslintrc)
├── .prettierrc                  # Prettier configuration
├── .gitignore
└── README.md
```

## TypeScript Configuration

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "lib": ["ESNext"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@/types/*": ["./types/*"]
    },
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "types/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Bun Configuration

**bunfig.toml**:

```toml
[install]
# Bun package manager settings
auto = true

[run]
# Runtime settings
bun = "bun"
```

**package.json scripts**:

```json
{
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun --minify",
    "start": "bun dist/index.js",
    "type-check": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "prettier --write \"src/**/*.ts\"",
    "test": "bun test"
  }
}
```

## Architecture Components

### 1. Core Layer (`src/core/`)

**Bot.ts** - Main orchestrator

- Initializes multiple protocol adapters, unified API client, event router
- Manages bot lifecycle (start, stop, restart) for all protocols
- Provides unified typed interface for plugins (protocol-agnostic)
- Coordinates multiple protocol connections
- Full TypeScript type safety

**ConnectionManager.ts** - Multi-protocol connection management

- Manages multiple protocol connections simultaneously
- Handles connection lifecycle for each protocol (connect, reconnect, disconnect)
- Monitors connection health for all protocols
- Coordinates reconnection strategies across protocols
- Provides unified connection status

**Connection.ts** - Single protocol WebSocket management

- Handles connection lifecycle for a single protocol (connect, reconnect, disconnect)
- Manages connection state and health with typed states
- Automatic reconnection with exponential backoff
- Connection event emission with typed events
- Can use Bun's native WebSocket or `ws` library

**Config.ts** - Configuration management

- Loads config from file, environment variables, or defaults
- Supports multiple protocol configurations (array of protocol configs)
- Validates configuration with JSON schema
- Provides fully typed access to config values
- Type-safe configuration interface for multi-protocol setup

### 2. Protocol Layer (`src/protocol/`)

**ProtocolAdapter** (abstract base class)

- Abstract interface for protocol implementations with TypeScript
- Generic types for event and API types
- Methods: `connect()`, `disconnect()`, `sendAPI<T>()`, `onEvent()`, `getProtocolName()`
- Normalizes events to internal typed format
- Type-safe protocol interface
- Each adapter instance handles one protocol connection

**OneBot11Adapter**

- Implements OneBot11 protocol (via LLBot's OneBot11 endpoint)
- Handles `message`, `notice`, `request`, `meta_event` events
- Converts OneBot11 events to normalized format
- Full TypeScript types for all OneBot11 events and APIs
- Type definitions in `types.ts` based on OneBot11 specification
- Leverages rich OneBot11 ecosystem and community resources

**MilkyAdapter**

- Implements Milky protocol (via LLBot's Milky endpoint)
- Handles Milky event structure
- Converts Milky events to normalized format
- Full TypeScript types for all Milky events and APIs
- Type definitions in `types.ts` based on Milky specification
- Modern protocol with updated features

**SatoriAdapter**

- Implements Satori protocol (via LLBot's Satori endpoint)
- Handles Satori event structure
- Converts Satori events to normalized format
- Full TypeScript types for all Satori events and APIs
- Type definitions in `types.ts` based on Satori specification

### 3. API Layer (`src/api/`)

**APIClient.ts**

- Unified typed interface for API calls (protocol-agnostic)
- Coordinates multiple protocol adapters
- Provides promise-based API methods with full type inference
- Generic methods: `call<TRequest, TResponse>(action, params)`
- Protocol selection strategy (priority, round-robin, or explicit)

**APIRouter.ts**

- Routes API calls to appropriate protocol adapter
- Implements protocol selection strategy:
  - **Priority**: Use preferred protocol (e.g., OneBot11) first, fallback to others
  - **Round-robin**: Distribute requests across protocols
  - **Capability-based**: Choose protocol based on feature support
  - **Explicit**: Allow plugins to specify which protocol to use
- Handles protocol-specific API method mapping

**RequestManager.ts**

- Tracks pending requests by echo ID with typed request/response pairs
- Manages requests across multiple protocols
- Handles timeouts and errors with typed error classes
- Manages request/response correlation per protocol
- Type-safe request tracking

**methods/** - API method wrappers

- Fully type-safe wrappers for common operations
- Protocol-agnostic interface (internally routes to appropriate protocol)
- `MessageAPI.sendPrivateMessage(userId, message): Promise<MessageId>`
- `MessageAPI.sendGroupMessage(groupId, message): Promise<MessageId>`
- `FriendAPI.getFriendList(): Promise<Friend[]>`
- `GroupAPI.getGroupInfo(groupId): Promise<GroupInfo>`
- `GroupAPI.getGroupMemberList(groupId): Promise<GroupMember[]>`
- All methods have complete TypeScript types

### 4. Event Layer (`src/events/`)

**EventRouter.ts**

- Routes protocol-specific events to appropriate handlers
- Normalizes events from different protocols to unified typed format
- Emits internal typed events for plugins
- Handles events from multiple protocols simultaneously
- Type-safe event routing

**EventDeduplicator.ts**

- Deduplicates events received from multiple protocols
- Since all protocols come from the same LLBot server (same QQ account), same events may arrive via different protocols
- Uses event fingerprinting (message ID, timestamp, content hash) to detect duplicates
- Configurable deduplication strategy (first-received, priority-protocol, merge)
- Prevents duplicate event processing

**EventEmitter.ts**

- Internal typed event bus for plugin communication
- Supports event namespacing with type inference
- Generic event types: `EventEmitter<EventMap>`
- Type-safe event emission and subscription
- Works with deduplicated events

**handlers/** - Event handlers

- `MessageHandler` - Processes message events with typed message data (from any protocol)
- `NoticeHandler` - Processes notice events (group member changes, etc.)
- `RequestHandler` - Processes friend/group requests with typed request data
- `MetaEventHandler` - Processes heartbeat, lifecycle events
- All handlers use typed event interfaces (protocol-agnostic)

### 5. Message Layer (`src/message/`)

**MessageSegment.ts**

- Utilities for working with message segments
- Complete TypeScript type definitions for all segment types
- Type-safe segment validation
- Union types: `TextSegment | AtSegment | ImageSegment | ...`

**MessageBuilder.ts**

- Fluent API for building messages with type safety
- `builder.text("hello").at(userId).image(url).build(): MessageSegment[]`
- Method chaining with type inference
- Validates segment data at compile time

**MessageParser.ts**

- Converts segments to text (current `segmentsToText` function)
- Parses segments to structured typed objects
- Handles different segment types with discriminated unions
- Type-safe parsing with proper error handling

### 6. Plugin System (`src/plugins/`)

**PluginManager.ts**

- Loads plugins from `plugins/` directory (supports TypeScript plugins)
- Manages plugin lifecycle (init, enable, disable, unload)
- Provides typed plugin API (access to bot, API client, events)
- Type-safe plugin loading and registration

**PluginBase.ts**

- Abstract base class for plugins with TypeScript
- Lifecycle hooks: `onInit()`, `onEnable()`, `onDisable()`
- Helper methods for typed event registration
- Generic plugin interface with type constraints

**Example Plugin Structure:**

```typescript
import { PluginBase, PluginContext } from "@/plugins/PluginBase";
import { PrivateMessageEvent } from "@/events/types";

export class EchoPlugin extends PluginBase {
  name = "echo";
  version = "1.0.0";

  onEnable(context: PluginContext): void {
    this.on<PrivateMessageEvent>("message.private", (event) => {
      this.bot.api.sendPrivateMessage(event.userId, event.message);
    });
  }
}
```

## Data Flow (Multi-Protocol)

```
LLBot Server (Protocol Forwarding Layer)
    ├─ Milky Endpoint (ws://host:3011/event) [Primary]
    ├─ OneBot11 Endpoint (ws://host:3010/event) [Fallback]
    └─ Satori Endpoint (ws://host:3012/event) [Optional]
    ↓ (WebSocket - typed messages)
ConnectionManager.ts
    ├─ Connection.ts (Milky) [Primary] ─┐
    ├─ Connection.ts (OneBot11) [Fallback] ├─→ ProtocolAdapters
    └─ Connection.ts (Satori) [Optional] ───┘
    ↓ (raw protocol events)
ProtocolAdapters (OneBot11, Milky, Satori) - convert to internal types
    ↓ (normalized typed events)
EventDeduplicator.ts (removes duplicates from multiple protocols)
    ↓ (deduplicated normalized events)
EventRouter.ts (routes by event type)
    ↓ (typed routed events)
Event Handlers (MessageHandler, NoticeHandler, etc.)
    ↓ (internal typed events)
PluginManager → Plugins (type-safe plugin API, protocol-agnostic)
    ↓ (typed API calls)
APIClient → APIRouter → ProtocolAdapter (Milky primary, OneBot11 fallback)
    ↓ (WebSocket/HTTP - typed requests/responses)
LLBot Server (via selected protocol endpoint)
```

## Architecture Overview

### Core Principles

1. **Type Safety First**: Every component is fully typed with TypeScript
2. **Multi-Protocol Support**: Simultaneously support OneBot11, Milky, Satori protocols
3. **Protocol Abstraction**: Unified interface hides protocol differences from plugins
4. **Event-Driven**: All communication flows through typed events (with deduplication)
5. **Plugin Architecture**: Extensible through a type-safe plugin system (protocol-agnostic)
6. **Separation of Concerns**: Each layer has a single, well-defined responsibility
7. **LLBot Integration**: Designed to work with LLBot as protocol forwarding layer

### Multi-Protocol Design Decisions

**Why Support Multiple Protocols?**

- Use Milky as primary protocol for modern features and better design
- Leverage OneBot11 as fallback for rich ecosystem and community resources
- Benefit from protocol-specific advantages (Milky modern, OneBot11 ecosystem)
- Future-proofing and flexibility

**How It Works:**

- LLBot exposes multiple protocol endpoints simultaneously
- Bot connects to multiple endpoints in parallel
- Events from all protocols are normalized to unified format
- Event deduplication prevents processing same event multiple times
- API calls can be routed to preferred protocol or distributed

**Protocol Selection Strategy:**

- **Priority**: Use preferred protocol (Milky) first, fallback to OneBot11 if unavailable
- **Round-robin**: Distribute API requests across protocols for load balancing
- **Capability-based**: Choose protocol based on feature support for specific operations

### Layer Responsibilities

**Core Layer**: Bot lifecycle, multi-protocol connection management, configuration

- `Bot.ts`: Main orchestrator, initializes all components
- `Connection.ts`: WebSocket connection with reconnection logic
- `Config.ts`: Type-safe configuration loading and validation

**Protocol Layer**: Protocol-specific implementations (multiple adapters run simultaneously)

- Abstract `ProtocolAdapter` interface
- `LLOneBotAdapter`: LLOneBot/OneBot 11 protocol
- `MilkyAdapter`: Milky protocol
- Both convert protocol-specific events to unified internal types

**API Layer**: Type-safe API calls

- `APIClient`: Unified interface for all API calls
- `RequestManager`: Tracks requests with echo IDs
- Method wrappers: Type-safe convenience methods

**Event Layer**: Event routing and handling

- `EventRouter`: Routes protocol events to handlers
- `EventEmitter`: Internal event bus for plugins
- Handlers: Process specific event types

**Message Layer**: Message construction and parsing

- `MessageSegment`: Type definitions for message segments
- `MessageBuilder`: Fluent API for building messages
- `MessageParser`: Convert segments to text/objects

**Plugin System**: Extensibility

- `PluginManager`: Loads and manages plugins
- `PluginBase`: Base class for plugins with lifecycle hooks
- Type-safe plugin API with access to bot, API, and events

## Configuration Structure

**config/default.json**:

```json
{
  "protocol": "llonebot",
  "connection": {
    "url": "ws://192.168.50.97:3010/event",
    "apiUrl": "http://192.168.50.97:3010/api",
    "accessToken": "yorshka",
    "reconnect": {
      "enabled": true,
      "maxRetries": 10,
      "backoff": "exponential",
      "initialDelay": 1000,
      "maxDelay": 30000
    }
  },
  "bot": {
    "selfId": null,
    "logLevel": "info"
  },
  "plugins": {
    "enabled": ["echo", "admin"],
    "directory": "./plugins"
  }
}
```

**TypeScript Config Interface**:

```typescript
// src/core/Config.ts
export interface BotConfig {
  protocol: "llonebot" | "milky";
  connection: {
    url: string;
    apiUrl: string;
    accessToken: string;
    reconnect: {
      enabled: boolean;
      maxRetries: number;
      backoff: "exponential" | "linear";
      initialDelay: number;
      maxDelay: number;
    };
  };
  bot: {
    selfId: number | null;
    logLevel: "debug" | "info" | "warn" | "error";
  };
  plugins: {
    enabled: string[];
    directory: string;
  };
}
```

## Build and Deployment

### Development

```bash
# Run in development mode (with hot reload if needed)
bun run dev

# Type checking
bun run type-check

# Linting
bun run lint

# Format code
bun run format
```

### Production Build

```bash
# Build for production
bun run build

# Run production build
bun run start
```

Bun's bundler will:

- Bundle all dependencies
- Tree-shake unused code
- Minify output
- Generate optimized single-file output

### Runtime Considerations

- Bun provides fast startup and execution
- Native TypeScript support (no compilation step needed for dev)
- Built-in bundler for production builds
- Can use Bun's native WebSocket or keep `ws` library for compatibility

## Benefits

1. **Full Type Safety**: Complete TypeScript coverage prevents runtime errors
2. **Multi-Protocol Support**: Simultaneously leverage OneBot11 ecosystem and modern protocols
3. **Protocol Flexibility**: Easy to add/remove protocols without changing plugin code
4. **Protocol Abstraction**: Plugins work with unified interface, protocol details hidden
5. **Event Deduplication**: Prevents duplicate processing when same event arrives via multiple protocols
6. **Protocol Selection**: Choose optimal protocol per API call (priority, round-robin, capability-based)
7. **Separation of Concerns**: Each module has a single responsibility
8. **Extensibility**: Plugin system allows adding features without modifying core
9. **Testability**: Each component can be tested independently with typed mocks
10. **Maintainability**: Clear structure and types make code easy to understand and modify
11. **Performance**: Bun runtime provides fast execution and startup
12. **Developer Experience**: IntelliSense, auto-completion, and compile-time error checking
13. **Production Ready**: Proper build pipeline and deployment configuration
14. **Ecosystem Access**: Primary use Milky for modern features, fallback to OneBot11 for rich ecosystem resources

## Type Definitions Strategy

1. **Protocol Types**: Define types based on official LLOneBot and Milky documentation
2. **Internal Types**: Create unified internal types that both protocols map to
3. **API Types**: Type all API requests and responses
4. **Event Types**: Type all events with discriminated unions
5. **Plugin Types**: Type plugin interfaces and lifecycle hooks
6. **Config Types**: Type configuration with validation

## Migration Path

1. Setup TypeScript and Bun configuration
2. Setup development tools (ESLint/Biome, Prettier)
3. Create directory structure with TypeScript files
4. Define all type definitions first (protocols, events, API, messages)
5. Implement core modules: Config.ts, Connection.ts, ConnectionManager.ts, Bot.ts
6. Implement protocol layer: ProtocolAdapter base, OneBot11Adapter, MilkyAdapter, SatoriAdapter
7. Implement API layer: RequestManager.ts, APIRouter.ts, APIClient.ts, API method wrappers
8. Implement event system: EventDeduplicator.ts, EventRouter.ts, EventEmitter.ts, event handlers
9. Implement message utilities: MessageSegment.ts, MessageBuilder.ts, MessageParser.ts
10. Implement plugin system: PluginBase.ts, PluginManager.ts, example plugin
11. Implement utilities: logger.ts, errors.ts
12. Refactor index.ts to use new architecture
13. Setup build configuration and scripts
14. Write comprehensive documentation
