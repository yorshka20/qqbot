# QQ Bot Framework

A production-ready TypeScript-based QQ bot framework built with Bun runtime, supporting multiple protocols (OneBot11, Milky, Satori) simultaneously.

## Features

- 🚀 **Multi-Protocol Support**: Connect to multiple protocols (Milky, OneBot11, Satori) simultaneously
- 🔒 **Type Safety**: Full TypeScript coverage with strict type checking
- 🔌 **Plugin System**: Extensible plugin architecture for easy feature development
- 🔄 **Event Deduplication**: Automatically handles duplicate events from multiple protocols
- 🎯 **Intelligent API Routing**: Choose optimal protocol per API call
- 🔁 **Automatic Reconnection**: Robust connection management with exponential backoff
- 📝 **JSONC Configuration**: Human-readable configuration with comments

## Prerequisites

- [Bun](https://bun.sh/) runtime (version 1.0.0 or higher)
- Node.js 18+ (if not using Bun)
- LLBot (LuckyLilliaBot) server running and exposing protocol endpoints

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd qqbot
```

2. Install dependencies:

```bash
bun install
```

3. Copy the example configuration:

```bash
cp config.example.jsonc config.jsonc
```

4. Edit `config.jsonc` with your LLBot server details:

```jsonc
{
  "protocols": [
    {
      "name": "milky",
      "enabled": true,
      "priority": 1,
      "connection": {
        "url": "ws://your-server:3010/event",
        "apiUrl": "http://your-server:3010/api",
        "accessToken": "your_access_token",
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
  "api": {
    "strategy": "priority",
    "preferredProtocol": "milky",
  },
  "events": {
    "deduplication": {
      "enabled": true,
      "strategy": "first-received",
      "window": 5000,
    },
  },
  "bot": {
    "selfId": null,
    "logLevel": "info",
  },
  "plugins": {
    "enabled": [],
    "directory": "./plugins",
  },
}
```

## Usage

### Development Mode

Run the bot in development mode:

```bash
bun run dev
```

### Production Build

Build and run the production version:

```bash
# Build
bun run build

# Run
bun run start
```

### Type Checking

Check TypeScript types:

```bash
bun run type-check
```

### Linting and Formatting

```bash
# Lint
bun run lint

# Fix linting issues
bun run lint:fix

# Format code
bun run format
```

## Configuration

Configuration is stored in `config.jsonc` (JSON with Comments). The configuration file supports:

- **Multiple Protocol Configurations**: Configure multiple protocols with different priorities
- **API Strategy**: Choose how API calls are routed (priority, round-robin, capability-based)
- **Event Deduplication**: Configure how duplicate events are handled
- **Plugin Management**: Specify which plugins to load and enable

### Configuration File Location

The bot looks for configuration in this order:

1. Constructor argument: `new Config('/path/to/config.jsonc')`
2. Environment variable: `CONFIG_PATH=/path/to/config.jsonc`
3. Default location: `./config.jsonc` in project root

## Creating Plugins

Plugins are TypeScript/JavaScript classes that implement the `Plugin` interface. Create a plugin file in the `plugins/` directory:

```typescript
// plugins/MyPlugin.ts
import type { Plugin, PluginContext } from '@/plugins/types';
import type { NormalizedMessageEvent } from '@/events/types';

export class MyPlugin implements Plugin {
  name = 'my-plugin';
  version = '1.0.0';
  description = 'My awesome plugin';

  async onEnable(context: PluginContext): Promise<void> {
    // Subscribe to message events
    context.events.onEvent<NormalizedMessageEvent>('message', async (event) => {
      if (event.messageType === 'private' && event.message === 'ping') {
        // Send reply using API client
        await context.api.call('send_private_msg', {
          user_id: event.userId,
          message: 'pong',
        });
      }
    });
  }

  async onDisable(): Promise<void> {
    // Cleanup code here
  }
}
```

Then enable it in `config.jsonc`:

```jsonc
{
  "plugins": {
    "enabled": ["my-plugin"],
    "directory": "./plugins",
  },
}
```

### Plugin Lifecycle

1. **onInit(context)**: Called when plugin is loaded (optional)
2. **onEnable(context)**: Called when plugin is enabled
3. **onDisable()**: Called when plugin is disabled

### Plugin Context

Plugins receive a context object with:

- `api`: `APIClient` - Unified API client for making protocol-agnostic API calls
- `events`: `EventRouter` - Event router for subscribing to events
- `bot.getConfig()`: Function to access bot configuration

## API Usage

### Making API Calls

Use the API client from plugin context:

```typescript
// Send private message
await context.api.call('send_private_msg', {
  user_id: 123456789,
  message: 'Hello!',
});

// Send group message
await context.api.call('send_group_msg', {
  group_id: 987654321,
  message: 'Hello group!',
});

// Get friend list
const friends = await context.api.call('get_friend_list');
```

### API Routing Strategies

Configure API routing in `config.jsonc`:

- **priority**: Use preferred protocol first, fallback to others
- **round-robin**: Distribute requests across protocols
- **capability-based**: Choose protocol based on feature support

## Event Handling

### Subscribing to Events

Subscribe to events in your plugin:

```typescript
// Message events
context.events.onEvent<NormalizedMessageEvent>('message', async (event) => {
  console.log(`Received message: ${event.message}`);
});

// Notice events
context.events.onEvent<NormalizedNoticeEvent>('notice', async (event) => {
  console.log(`Notice: ${event.noticeType}`);
});

// All events (wildcard)
context.events.onEvent('*', async (event) => {
  console.log(`Event: ${event.type}`);
});
```

### Event Types

- **message**: Private and group messages
- **notice**: Notifications (member join/leave, etc.)
- **request**: Friend/group requests
- **meta_event**: Heartbeat, lifecycle events

## Architecture

The framework is organized into layers:

- **Core Layer**: Bot lifecycle, connection management, configuration
- **Protocol Layer**: Protocol adapters (OneBot11, Milky, Satori)
- **API Layer**: Unified API client and routing
- **Event Layer**: Event routing, deduplication, and handling
- **Message Layer**: Message construction and parsing
- **Plugin Layer**: Plugin system and management

For detailed architecture documentation, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Multi-Protocol Support

The framework supports connecting to multiple protocols simultaneously:

- **Milky Protocol**: Modern protocol design (Primary)
- **OneBot11 Protocol**: Rich ecosystem and community resources (Fallback)
- **Satori Protocol**: Modern unified protocol (Optional)

All protocols connect to the same LLBot server, so events may arrive via multiple protocols. The framework automatically deduplicates events to prevent duplicate processing.

## Project Structure

```
qqbot/
├── src/
│   ├── core/           # Core bot functionality
│   │   ├── Bot.ts      # Main bot orchestrator
│   │   ├── Config.ts   # Configuration management
│   │   ├── ConnectionManager.ts  # Multi-protocol connection management
│   │   └── Connection.ts         # Single protocol WebSocket connection
│   ├── protocol/       # Protocol adapters
│   │   ├── base/       # Base protocol adapter
│   │   ├── milky/      # Milky protocol implementation
│   │   ├── onebot11/   # OneBot11 protocol implementation
│   │   └── satori/     # Satori protocol implementation
│   ├── api/            # API layer
│   │   ├── APIClient.ts    # Unified API client
│   │   ├── APIRouter.ts    # API routing
│   │   └── RequestManager.ts  # Request tracking
│   ├── events/         # Event system
│   │   ├── EventRouter.ts      # Event routing
│   │   ├── EventDeduplicator.ts  # Event deduplication
│   │   └── handlers/   # Event handlers
│   ├── message/        # Message utilities
│   ├── plugins/        # Plugin system
│   ├── utils/          # Utilities
│   └── index.ts        # Entry point
├── plugins/            # User plugins directory
├── config.jsonc        # Configuration file
└── README.md           # This file
```

## Development

### Type Checking

```bash
bun run type-check
```

### Linting

```bash
bun run lint
bun run lint:fix
```

### Formatting

```bash
bun run format
```

## Troubleshooting

### Connection Issues

- Verify LLBot server is running and accessible
- Check WebSocket URLs in configuration
- Verify access tokens are correct
- Check network connectivity

### Plugin Issues

- Ensure plugin file exports a class implementing `Plugin` interface
- Verify plugin name and version are set
- Check plugin is listed in `enabled` array in config
- Review logs for plugin loading errors

### Configuration Issues

- Ensure `config.jsonc` is valid JSONC
- Verify at least one protocol is enabled
- Check all required fields are present
- Review error messages for specific issues

## License

ISC

## Contributing

Contributions are welcome! Please ensure:

- Code follows existing style and conventions
- TypeScript types are properly defined
- All tests pass
- Documentation is updated

## Support

For issues and questions:

1. Check the [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation
2. Review configuration examples
3. Check logs for error messages
4. Open an issue on the repository
