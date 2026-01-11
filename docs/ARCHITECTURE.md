# QQ Bot Architecture Design Document

## Overview

This document describes the architecture of the QQ Bot framework, a production-ready TypeScript-based bot system built with Bun runtime. The framework supports multiple protocols (OneBot11, Milky, Satori) simultaneously, providing a unified interface for bot development while leveraging the strengths of each protocol.

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
10. [Error Handling](#error-handling)
11. [Development Workflow](#development-workflow)

## System Overview

### Purpose

The QQ Bot framework is designed to connect to QQ clients via LLBot (LuckyLilliaBot), a protocol forwarding layer that exposes multiple protocol endpoints simultaneously. The framework allows developers to:

- Connect to multiple protocols in parallel (Milky, OneBot11, Satori)
- Develop plugins that work across all protocols with a unified API
- Leverage protocol-specific advantages (e.g., OneBot11's rich ecosystem, Milky's modern features)
- Handle events from multiple protocols with automatic deduplication
- Route API calls intelligently based on protocol capabilities

### Key Features

- **Multi-Protocol Support**: Simultaneously connect to and use multiple protocols
- **Type Safety**: Full TypeScript coverage with strict type checking
- **Event Deduplication**: Prevents duplicate event processing when same event arrives via multiple protocols
- **Protocol Abstraction**: Plugins work with unified interface, protocol details are hidden
- **Extensible Plugin System**: Easy to add new features through plugins
- **Intelligent API Routing**: Choose optimal protocol per API call
- **Automatic Reconnection**: Robust connection management with exponential backoff

## Architecture Principles

1. **Type Safety First**: Every component is fully typed with TypeScript
2. **Multi-Protocol Support**: Simultaneously support OneBot11, Milky, Satori protocols
3. **Protocol Abstraction**: Unified interface hides protocol differences from plugins
4. **Event-Driven**: All communication flows through typed events (with deduplication)
5. **Separation of Concerns**: Each layer has a single, well-defined responsibility
6. **Extensibility**: Plugin system allows adding features without modifying core
7. **Testability**: Each component can be tested independently with typed mocks

## Technology Stack

- **Runtime**: Bun (fast JavaScript/TypeScript runtime)
- **Language**: TypeScript (full type safety with strict mode)
- **Build Tool**: Bun's built-in bundler
- **Package Manager**: Bun
- **Code Quality**: Biome (linter/formatter) + Prettier
- **Configuration**: JSONC (JSON with Comments)

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
        │  (Milky, OneBot11, Satori) │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   EventDeduplicator       │
        │  (Remove Duplicates)      │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │     EventRouter            │
        │  (Route by Event Type)    │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │   Event Handlers          │
        │  (Message, Notice, etc.)  │
        └─────────────┬─────────────┘
                      │
        ┌─────────────▼─────────────┐
        │    PluginManager          │
        │   (Load & Execute)        │
        └───────────────────────────┘
```

### Layer Structure

The system is organized into the following layers:

1. **Core Layer** (`src/core/`): Bot lifecycle, connection management, configuration
2. **Protocol Layer** (`src/protocol/`): Protocol-specific implementations
3. **API Layer** (`src/api/`): Unified API client and routing
4. **Event Layer** (`src/events/`): Event routing, deduplication, and handling
5. **Message Layer** (`src/message/`): Message construction and parsing
6. **Plugin Layer** (`src/plugins/`): Plugin system and management
7. **Utils Layer** (`src/utils/`): Logging, error handling

## Component Details

### Core Layer

#### Bot.ts

The main orchestrator class that coordinates all system components.

**Responsibilities:**

- Initialize and manage all system components
- Coordinate bot lifecycle (start, stop, restart)
- Provide unified interface for plugins
- Emit bot-level events (ready, error)

**Key Methods:**

- `start()`: Initialize and connect to all enabled protocols
- `stop()`: Gracefully shutdown all connections
- `getConfig()`: Access configuration
- `getConnectionManager()`: Access connection manager

#### ConnectionManager.ts

Manages multiple protocol connections simultaneously.

**Responsibilities:**

- Connect to all enabled protocols in parallel
- Monitor connection health for all protocols
- Coordinate reconnection strategies across protocols
- Provide unified connection status

**Key Methods:**

- `connectAll()`: Connect to all enabled protocols
- `disconnectAll()`: Disconnect all protocols
- `isAllConnected()`: Check if all protocols are connected
- `getConnection(protocolName)`: Get connection for specific protocol

**Events:**

- `connectionOpen`: Emitted when a protocol connection opens
- `connectionClose`: Emitted when a protocol connection closes
- `connectionError`: Emitted when a connection error occurs
- `allConnected`: Emitted when all protocols are connected
- `allDisconnected`: Emitted when all protocols are disconnected

#### Connection.ts

Manages a single WebSocket connection for one protocol.

**Responsibilities:**

- Handle WebSocket connection lifecycle
- Automatic reconnection with exponential backoff
- Connection state management
- Message sending and receiving

**Connection States:**

- `disconnected`: Not connected
- `connecting`: Connection in progress
- `connected`: Successfully connected
- `reconnecting`: Attempting to reconnect

#### Config.ts

Manages configuration loading and validation.

**Responsibilities:**

- Load configuration from JSONC file
- Validate configuration structure
- Provide type-safe access to config values
- Support environment variable overrides

**Configuration Sources (priority order):**

1. Constructor argument
2. `CONFIG_PATH` environment variable
3. Default `config.jsonc` in project root

### Protocol Layer

#### ProtocolAdapter (Abstract Base Class)

Abstract base class for all protocol implementations.

**Responsibilities:**

- Define common interface for all protocols
- Handle API request/response correlation
- Normalize protocol-specific events to unified format
- Manage connection lifecycle

**Key Methods:**

- `normalizeEvent(rawEvent)`: Convert protocol event to normalized format
- `sendAPI(action, params, timeout)`: Send API request and wait for response
- `onEvent(callback)`: Register event handler
- `getProtocolName()`: Return protocol identifier

#### OneBot11Adapter

Implements OneBot11 protocol specification.

**Features:**

- Full OneBot11 event support (message, notice, request, meta_event)
- OneBot11 API method support
- Type definitions based on OneBot11 specification
- Leverages rich OneBot11 ecosystem

#### MilkyAdapter

Implements Milky protocol specification.

**Features:**

- Modern protocol design
- Milky event structure support
- Milky API method support
- Type definitions based on Milky specification

#### SatoriAdapter

Implements Satori protocol specification.

**Features:**

- Satori event structure support
- Satori API method support
- Type definitions based on Satori specification

### API Layer

#### APIClient.ts

Unified API client that provides protocol-agnostic interface.

**Responsibilities:**

- Provide unified interface for API calls
- Route API calls to appropriate protocol adapter
- Handle errors and timeouts
- Manage protocol selection strategy

**Key Methods:**

- `call(action, params, protocol?, timeout)`: Make API call
- `registerAdapter(protocol, adapter)`: Register protocol adapter
- `unregisterAdapter(protocol)`: Unregister protocol adapter
- `getAvailableProtocols()`: Get list of available protocols

#### APIRouter.ts

Routes API calls to appropriate protocol adapter based on strategy.

**Routing Strategies:**

- **Priority**: Use preferred protocol first, fallback to others
- **Round-robin**: Distribute requests across protocols
- **Capability-based**: Choose protocol based on feature support

#### RequestManager.ts

Tracks pending API requests and correlates responses.

**Responsibilities:**

- Track requests by echo ID
- Handle request timeouts
- Correlate responses to requests
- Manage request lifecycle

### Event Layer

#### EventRouter.ts

Routes normalized events to appropriate handlers.

**Responsibilities:**

- Route events by type (message, notice, request, meta_event)
- Emit typed events for plugins
- Support wildcard event handlers
- Integrate with EventDeduplicator

**Event Types:**

- `message`: Private and group messages
- `notice`: Notifications (member join/leave, etc.)
- `request`: Friend/group requests
- `meta_event`: Heartbeat, lifecycle events
- `*`: Wildcard for all events

#### EventDeduplicator.ts

Prevents duplicate event processing from multiple protocols.

**Why Needed:**
Since all protocols come from the same LLBot server (same QQ account), the same event may arrive via different protocols simultaneously.

**Deduplication Strategies:**

- **first-received**: Process first event, ignore duplicates
- **priority-protocol**: Process event from highest priority protocol
- **merge**: Merge data from multiple protocol versions

**Deduplication Window:**
Events within a configurable time window (default: 5000ms) are considered duplicates if they have the same fingerprint.

**Event Fingerprinting:**

- Message ID
- Timestamp
- Content hash
- Event type and source

#### Event Handlers

Specialized handlers for different event types:

- **MessageHandler**: Processes message events
- **NoticeHandler**: Processes notice events
- **RequestHandler**: Processes friend/group requests
- **MetaEventHandler**: Processes heartbeat and lifecycle events

### Message Layer

#### MessageSegment Types

Type definitions for message segments:

- `TextSegment`: Plain text
- `AtSegment`: @ mention
- `FaceSegment`: Emoji/face
- `ImageSegment`: Image
- `ReplySegment`: Reply to message

#### MessageBuilder.ts

Fluent API for constructing messages.

**Example:**

```typescript
const message = new MessageBuilder()
  .text('Hello ')
  .at(userId)
  .text('!')
  .build();
```

#### MessageParser.ts

Converts message segments to text or structured objects.

**Features:**

- Convert segments to plain text
- Parse segments to structured format
- Handle different segment types

### Plugin System

#### PluginManager.ts

Manages plugin loading and lifecycle.

**Responsibilities:**

- Load plugins from directory
- Manage plugin lifecycle (init, enable, disable)
- Provide plugin context (API, events, bot)
- Track enabled/disabled plugins

**Plugin Loading:**

- Scans `plugins/` directory for `.ts` or `.js` files
- Supports both default and named exports
- Validates plugin structure (name, version required)

#### PluginBase.ts

Abstract base class for plugins (optional, for convenience).

**Lifecycle Hooks:**

- `onInit(context)`: Called when plugin is loaded
- `onEnable(context)`: Called when plugin is enabled
- `onDisable()`: Called when plugin is disabled

#### Plugin Interface

```typescript
interface Plugin {
  name: string;
  version: string;
  description?: string;
  author?: string;
  onInit?(context: PluginContext): void | Promise<void>;
  onEnable?(context: PluginContext): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}
```

**Plugin Context:**

```typescript
interface PluginContext {
  api: APIClient; // Unified API client
  events: EventRouter; // Event router for subscribing to events
  bot: {
    getConfig: () => unknown; // Access bot configuration
  };
}
```

## Data Flow

### Event Flow (Incoming)

```
LLBot Server
    ↓ (WebSocket messages)
ConnectionManager
    ↓ (raw protocol messages)
Protocol Adapters (OneBot11, Milky, Satori)
    ↓ (normalize to BaseEvent)
EventDeduplicator
    ↓ (deduplicated events)
EventRouter
    ↓ (routed by type)
Event Handlers
    ↓ (internal events)
PluginManager → Plugins
```

### API Flow (Outgoing)

```
Plugin/Handler
    ↓ (API call)
APIClient
    ↓ (route based on strategy)
APIRouter
    ↓ (select protocol adapter)
Protocol Adapter
    ↓ (protocol-specific request)
Connection
    ↓ (WebSocket message)
LLBot Server
    ↓ (response)
Protocol Adapter
    ↓ (normalize response)
APIClient
    ↓ (return to caller)
Plugin/Handler
```

## Protocol Support

### Multi-Protocol Design

The framework supports connecting to multiple protocols simultaneously:

1. **Milky Protocol** (Primary)
   - Modern protocol design
   - Endpoint: `ws://host:3011/event`
   - API: `http://host:3011/api`

2. **OneBot11 Protocol** (Fallback)
   - Rich ecosystem and community resources
   - Endpoint: `ws://host:3010/event`
   - API: `http://host:3010/api`

3. **Satori Protocol** (Optional)
   - Modern unified protocol
   - Endpoint: `ws://host:3012/event`
   - API: `http://host:3012/api`

### Protocol Selection

API calls can be routed using different strategies:

- **Priority Strategy**: Use preferred protocol (e.g., Milky) first, fallback to OneBot11 if unavailable
- **Round-Robin Strategy**: Distribute requests across protocols for load balancing
- **Capability-Based Strategy**: Choose protocol based on feature support

### Event Deduplication

Since all protocols connect to the same LLBot server (same QQ account), events may arrive via multiple protocols. The EventDeduplicator ensures each event is processed only once.

## Configuration

### Configuration File Structure

Configuration is stored in `config.jsonc` (JSON with Comments):

```jsonc
{
  // Protocol configurations
  "protocols": [
    {
      "name": "milky",
      "enabled": true,
      "priority": 1,
      "connection": {
        "url": "ws://192.168.50.97:3011/event",
        "apiUrl": "http://192.168.50.97:3011/api",
        "accessToken": "your_access_token_here",
      },
      "reconnect": {
        "enabled": true,
        "maxRetries": 10,
        "backoff": "exponential",
        "initialDelay": 1000,
        "maxDelay": 30000,
      },
    },
  ],
  // API configuration
  "api": {
    "strategy": "priority",
    "preferredProtocol": "milky",
  },
  // Event deduplication configuration
  "events": {
    "deduplication": {
      "enabled": true,
      "strategy": "first-received",
      "window": 5000,
    },
  },
  // Bot configuration
  "bot": {
    "selfId": null,
    "logLevel": "info",
  },
  // Plugin configuration
  "plugins": {
    "enabled": ["echo"],
    "directory": "./plugins",
  },
}
```

### Configuration Loading

Configuration is loaded in the following priority order:

1. Constructor argument: `new Config('/path/to/config.jsonc')`
2. Environment variable: `CONFIG_PATH=/path/to/config.jsonc`
3. Default location: `./config.jsonc` in project root

## Plugin System

### Creating a Plugin

Plugins are TypeScript/JavaScript classes that implement the `Plugin` interface:

```typescript
import type { Plugin, PluginContext } from '@/plugins/types';
import type { NormalizedMessageEvent } from '@/events/types';

export class MyPlugin implements Plugin {
  name = 'my-plugin';
  version = '1.0.0';
  description = 'My awesome plugin';

  async onEnable(context: PluginContext): Promise<void> {
    // Subscribe to message events
    context.events.onEvent<NormalizedMessageEvent>('message', async (event) => {
      if (event.messageType === 'private') {
        // Send reply
        await context.api.call('send_private_msg', {
          user_id: event.userId,
          message: 'Hello!',
        });
      }
    });
  }

  async onDisable(): Promise<void> {
    // Cleanup
  }
}
```

### Plugin Lifecycle

1. **Load**: Plugin file is loaded from `plugins/` directory
2. **Init**: `onInit()` is called with plugin context
3. **Enable**: If plugin is in `enabled` list, `onEnable()` is called
4. **Disable**: `onDisable()` is called when plugin is disabled
5. **Unload**: Plugin is removed from memory

### Plugin Context

Plugins receive a context object providing access to:

- **API Client**: Make API calls (protocol-agnostic)
- **Event Router**: Subscribe to events
- **Bot Config**: Access bot configuration

## Error Handling

### Error Types

The framework defines custom error types:

- **ConfigError**: Configuration loading/validation errors
- **APIError**: API call failures
- **ConnectionError**: Connection-related errors

### Error Handling Strategy

- **Connection Errors**: Automatic reconnection with exponential backoff
- **API Errors**: Propagated to caller with context
- **Plugin Errors**: Logged but don't crash the bot
- **Configuration Errors**: Fail fast with clear error messages

## Development Workflow

### Project Structure

```
qqbot/
├── src/
│   ├── core/           # Core bot functionality
│   ├── protocol/       # Protocol adapters
│   ├── api/            # API layer
│   ├── events/         # Event system
│   ├── message/        # Message utilities
│   ├── plugins/        # Plugin system
│   ├── utils/          # Utilities
│   └── index.ts        # Entry point
├── plugins/            # User plugins directory
├── config.jsonc        # Configuration file
├── tsconfig.json       # TypeScript config
├── package.json        # Dependencies
└── README.md           # Documentation
```

### Development Commands

```bash
# Development mode (with hot reload)
bun run dev

# Type checking
bun run type-check

# Linting
bun run lint

# Format code
bun run format

# Build for production
bun run build

# Run production build
bun run start
```

### Type Safety

The entire codebase uses TypeScript with strict mode enabled:

- All functions and methods are fully typed
- Protocol events and API calls are type-safe
- Plugin interfaces are typed
- Configuration is type-checked

## Conclusion

This architecture provides a robust, extensible, and type-safe foundation for building QQ bots. The multi-protocol support allows developers to leverage the strengths of different protocols while maintaining a unified development experience. The plugin system enables easy extensibility without modifying core code.
