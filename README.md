# QQ Bot

A production-ready, AI-powered QQ bot framework built with TypeScript and Bun. Supports multiple communication protocols simultaneously and provides a full AI conversation pipeline with plugin extensibility.

## Features

- **Multi-Protocol Support**: Connect to Milky, OneBot11, and Satori protocols simultaneously via LLBot
- **Full AI Conversation Pipeline**: Structured 6-stage message lifecycle with hooks for preprocessing, AI task analysis, reply generation, and post-processing
- **Multi-Provider AI**: 12+ AI provider integrations — OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, OpenRouter, NovelAI, RunPod, Google Cloud Run, and more
- **Task System**: AI-driven intent analysis routes messages to specialized executors
- **Built-in Plugin Suite**: Whitelist, memory, proactive conversation, image generation, gacha, nudge, reaction, auto-recall, rule scheduler, and more
- **Command System**: Prefix-based command routing with role-based permission control (owner / admin / user)
- **Memory System**: Per-user and per-group long-term memory extracted and injected automatically
- **MCP Integration**: Model Context Protocol support for RAG search via SearXNG
- **Database Persistence**: SQLite and MongoDB adapters for conversation history
- **Image Generation**: Text-to-image and image-to-video via NovelAI, RunPod (ComfyUI serverless), Google Cloud Run, and local providers
- **Card Rendering**: Long AI replies are rendered as images via Puppeteer for a better reading experience
- **Proactive Conversation**: Bot can proactively join group conversations based on topic preferences
- **Type Safety**: Full TypeScript strict mode with dependency injection (tsyringe)
- **Automatic Reconnection**: Exponential backoff reconnection for all protocol connections

## Prerequisites

- [Bun](https://bun.sh/) runtime >= 1.0.0
- [LLBot](https://github.com/LLOneBot/LLOneBot) server running and exposing protocol endpoints

## Installation

```bash
git clone <repository-url>
cd qqbot
bun install
cp config.example.jsonc config.jsonc
```

Edit `config.jsonc` with your server and AI provider details (see [Configuration](#configuration)).

## Quick Start

```bash
# Development mode with debug logging
bun run dev

# Production build then run
bun run build
bun run start

# Debug mode with mock message sending
bun run debug
```

---

## Project Structure

```
qqbot/
├── src/
│   ├── index.ts                  # Entry point — wires all subsystems
│   ├── core/                     # Bot lifecycle & connection management
│   │   ├── Bot.ts
│   │   ├── Config.ts
│   │   ├── ConnectionManager.ts
│   │   └── Connection.ts
│   ├── protocol/                 # Protocol adapters
│   │   ├── milky/
│   │   ├── onebot11/
│   │   └── satori/
│   ├── api/                      # Unified API client & routing
│   │   ├── APIClient.ts
│   │   ├── APIRouter.ts
│   │   └── RequestManager.ts
│   ├── events/                   # Event deduplication & routing
│   │   ├── EventRouter.ts
│   │   ├── EventDeduplicator.ts
│   │   └── handlers/
│   ├── conversation/             # Conversation pipeline & lifecycle
│   │   ├── MessagePipeline.ts
│   │   ├── Lifecycle.ts
│   │   ├── ConversationManager.ts
│   │   ├── CommandRouter.ts
│   │   ├── SummarizeService.ts
│   │   ├── systems/              # Pipeline stage systems
│   │   │   ├── CommandSystem.ts
│   │   │   ├── TaskSystem.ts
│   │   │   └── DatabasePersistenceSystem.ts
│   │   ├── proactive/            # Proactive conversation engine
│   │   └── thread/               # Conversation threading
│   ├── command/                  # Command parsing & execution
│   │   ├── CommandManager.ts
│   │   ├── CommandParser.ts
│   │   ├── CommandArgsParser.ts
│   │   ├── CommandBuilder.ts
│   │   ├── PermissionChecker.ts
│   │   ├── decorators.ts
│   │   └── handlers/             # Built-in command handlers
│   ├── task/                     # AI task analysis & execution
│   │   ├── TaskAnalyzer.ts
│   │   ├── TaskManager.ts
│   │   ├── TaskInitializer.ts
│   │   ├── decorators.ts
│   │   └── executors/
│   ├── hooks/                    # Lifecycle hook system
│   │   ├── HookManager.ts
│   │   ├── HookPriority.ts
│   │   ├── AIHooks.ts
│   │   ├── CommandHooks.ts
│   │   ├── MessageHooks.ts
│   │   ├── TaskHooks.ts
│   │   └── types.ts
│   ├── ai/                       # AI service facade & providers
│   │   ├── AIService.ts          # Facade delegating to sub-services
│   │   ├── AIManager.ts
│   │   ├── ProviderFactory.ts
│   │   ├── ProviderRegistry.ts
│   │   ├── ProviderSelector.ts
│   │   ├── providers/            # Provider implementations
│   │   │   ├── OpenAIProvider.ts
│   │   │   ├── AnthropicProvider.ts
│   │   │   ├── DeepSeekProvider.ts
│   │   │   ├── DoubaoProvider.ts
│   │   │   ├── GeminiProvider.ts
│   │   │   ├── OllamaProvider.ts
│   │   │   ├── OpenRouterProvider.ts
│   │   │   ├── NovelAIProvider.ts
│   │   │   ├── RunPodProvider.ts
│   │   │   ├── GoogleCloudRunProvider.ts
│   │   │   ├── LocalText2ImageProvider.ts
│   │   │   └── LaozhangProvider.ts
│   │   ├── services/             # Specialized AI sub-services
│   │   │   ├── LLMService.ts
│   │   │   ├── VisionService.ts
│   │   │   ├── ReplyGenerationService.ts
│   │   │   ├── TaskAnalysisService.ts
│   │   │   ├── ImageGenerationService.ts
│   │   │   ├── ImagePromptService.ts
│   │   │   ├── CardRenderingService.ts
│   │   │   ├── ConversationHistoryService.ts
│   │   │   └── OllamaPreliminaryAnalysisService.ts
│   │   ├── prompt/               # Prompt template management
│   │   └── capabilities/         # Provider capability definitions
│   ├── context/                  # HookContext & context builders
│   │   ├── ContextManager.ts
│   │   ├── HookContextBuilder.ts
│   │   ├── HookContextHelpers.ts
│   │   ├── CommandContextBuilder.ts
│   │   ├── TaskExecutionContextBuilder.ts
│   │   ├── history/
│   │   └── types.ts
│   ├── memory/                   # Long-term user/group memory
│   │   ├── MemoryService.ts
│   │   └── MemoryExtractService.ts
│   ├── search/                   # SearXNG search integration
│   │   ├── SearchService.ts
│   │   └── SearXNGClient.ts
│   ├── mcp/                      # Model Context Protocol client
│   │   ├── MCPClient.ts
│   │   ├── MCPManager.ts
│   │   └── MCPInitializer.ts
│   ├── database/                 # Persistence layer
│   │   ├── DatabaseManager.ts
│   │   ├── adapters/             # SQLite & MongoDB adapters
│   │   └── models/
│   ├── plugins/                  # Plugin system & built-in plugins
│   │   ├── PluginManager.ts
│   │   ├── PluginBase.ts
│   │   ├── PluginInitializer.ts
│   │   ├── PluginCommandHandler.ts
│   │   ├── decorators.ts
│   │   └── plugins/              # Built-in plugin implementations
│   │       ├── WhitelistPlugin.ts
│   │       ├── MemoryPlugin.ts
│   │       ├── MemoryTriggerPlugin.ts
│   │       ├── ProactiveConversationPlugin.ts
│   │       ├── EchoPlugin.ts
│   │       ├── NudgePlugin.ts
│   │       ├── ReactionPlugin.ts
│   │       ├── AutoRecallPlugin.ts
│   │       ├── MessageOperationPlugin.ts
│   │       ├── RulePlugin.ts
│   │       ├── NsfwModePlugin.ts
│   │       ├── ConversationConfigPlugin.ts
│   │       ├── Text2ImgSFWFilterPlugin.ts
│   │       └── gachaPlugin/
│   ├── config/                   # Runtime configuration services
│   │   ├── GlobalConfigManager.ts
│   │   ├── ConversationConfigService.ts
│   │   └── SessionUtils.ts
│   ├── message/                  # Message construction & parsing
│   │   ├── MessageBuilder.ts
│   │   └── MessageParser.ts
│   ├── googlecloud/              # Google Cloud Run ComfyUI client
│   ├── runpod/                   # RunPod serverless clients & workflows
│   └── utils/                    # Logger, static file server, helpers
├── plugins/                      # External plugin directory (user-defined)
├── prompts/                      # Prompt template files
├── docs/                         # Additional architecture docs
├── config.example.jsonc          # Annotated configuration template
├── config.jsonc                  # Active configuration (not committed)
├── package.json
└── tsconfig.json
```

---

## Architecture

### High-Level Overview

```
QQ Client
   |
LLBot Server  (protocol forwarding layer)
   |-- Milky endpoint    ws + http
   |-- OneBot11 endpoint ws + http
   |-- Satori endpoint   ws + http
         |
   ConnectionManager
         |
   Protocol Adapters   (normalize raw events)
         |
   EventDeduplicator   (drop cross-protocol duplicates)
         |
   EventRouter         (dispatch by event type)
         |
   ConversationManager
         |
   MessagePipeline     (6-stage lifecycle)
   +-----------------------------------------+
   | 1. ON_MESSAGE_RECEIVED                  |
   | 2. PREPROCESS  (whitelist, access ctrl) |
   | 3. PROCESS     (commands, AI tasks)     |
   | 4. PREPARE     (pre-send hooks)         |
   | 5. SEND        (deliver reply)          |
   | 6. COMPLETE    (persist, post hooks)    |
   +-----------------------------------------+
         |
   APIClient --> Protocol Adapters --> LLBot --> QQ
```

### Message Processing Lifecycle

Every incoming message passes through a 6-stage pipeline managed by `Lifecycle.ts`. Each stage runs registered **Systems** in priority order and fires **Hooks** that plugins can subscribe to.

| Stage | Systems (priority) | Key hooks fired |
|---|---|---|
| `ON_MESSAGE_RECEIVED` | — | `onMessageReceived` |
| `PREPROCESS` | WhitelistPlugin sets `postProcessOnly` | `onMessagePreprocess` |
| `PROCESS` | `CommandSystem` (100), `TaskSystem` (20) | `onTaskAnalyzed`, `onMessageBeforeAI`, `onAIGenerationStart`, `onAIGenerationComplete` |
| `PREPARE` | — | `onMessageBeforeSend` |
| `SEND` | — | — |
| `COMPLETE` | `DatabasePersistenceSystem` | `onMessageSent` |

### Task System Flow

When no explicit command is matched, `TaskSystem` uses `AIService.analyzeTask()` to ask the LLM what the user intends. The result is a typed `Task`. For `reply`-type tasks the bot optionally searches the web, generates a response, and renders it as a card image if it is long.

```
TaskSystem.execute()
  |
  +-- AIService.analyzeTask()
  |     TaskAnalyzer --> LLM --> Task{type, params}
  |
  +-- (if reply task) AIService.generateReply()
  |     SearchService.performSmartSearch()  (optional)
  |     LLMService.generate()
  |     CardRenderingService.renderCard()   (if response is long)
  |
  +-- TaskManager.execute()  --> TaskExecutor
  |
  context.reply  -->  MessagePipeline.handleReply()  --> send
```

### API Context Flow

Every outgoing API call travels through a single context object:

```
plugin/handler
  --> APIClient.call(action, params, protocol?, timeout)
  --> APIContext created
  --> APIRouter selects adapter (priority / round-robin / capability)
  --> ProtocolAdapter.sendAPI(context)
  --> WebSocket / HTTP request to LLBot
  --> response correlated via echo ID stored in context
```

---

## Configuration

Copy `config.example.jsonc` to `config.jsonc`. The file is annotated with comments. Key sections are shown below.

### Protocols

```jsonc
"protocols": [
  {
    "name": "milky",        // "milky" | "onebot11" | "satori"
    "enabled": true,
    "priority": 1,
    "mockSendMessage": false,
    "connection": {
      "url": "ws://your-llbot:3010/event",
      "apiUrl": "http://your-llbot:3010/api",
      "accessToken": "your_token"
    },
    "reconnect": {
      "enabled": true,
      "maxRetries": 10,
      "backoff": "exponential",  // "exponential" | "linear"
      "initialDelay": 1000,
      "maxDelay": 30000
    }
  }
]
```

### API Routing

```jsonc
"api": {
  "strategy": "priority",          // "priority" | "round-robin" | "capability"
  "preferredProtocol": "milky"
}
```

### Bot Identity & Permissions

```jsonc
"bot": {
  "selfId": null,           // auto-detected
  "owner": "123456789",     // highest permission, all commands
  "admins": ["987654321"]   // admin-level commands
}
```

### Database

```jsonc
"database": {
  "type": "sqlite",              // "sqlite" | "mongodb"
  "sqlite": { "path": "data/bot.db" }
  // "mongodb": { "connectionString": "...", "database": "qqbot" }
}
```

### AI Providers

```jsonc
"ai": {
  "defaultProviders": {
    "llm": "ollama",             // default LLM provider key
    "text2img": "novelai"        // default image generation provider key
  },
  "providers": {
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "llama3",
      "temperature": 0.7
    },
    "openai": {
      "type": "openai",
      "apiKey": "sk-...",
      "model": "gpt-4o",
      "baseURL": "https://api.openai.com/v1"
    },
    "anthropic": {
      "type": "anthropic",
      "apiKey": "sk-ant-...",
      "model": "claude-opus-4-6"
    },
    "novelai": {
      "type": "novelai",
      "accessToken": "your_token",
      "baseURL": "https://image.novelai.net",
      "model": "nai-diffusion-4-5-full",
      "defaultSteps": 45,
      "defaultWidth": 832,
      "defaultHeight": 1216
    }
    // also: deepseek, doubao, gemini, openrouter, runpod,
    //        google-cloud-run, local-text2img, laozhang
  }
}
```

### Context Memory

```jsonc
"contextMemory": {
  "maxBufferSize": 30,          // messages kept in ring buffer
  "useSummary": false,          // compress old history with LLM
  "summaryThreshold": 20,
  "maxHistoryMessages": 10      // messages injected into AI prompt
}
```

### Prompt Templates

```jsonc
"prompts": { "directory": "prompts" }
```

Template files live in the `prompts/` directory. They are managed by `PromptManager` and referenced by dotted key (e.g. `llm.reply`, `llm.reply.with_search`, `task.analyze`). See [`prompts/README.md`](prompts/README.md).

### MCP / Web Search

```jsonc
"mcp": {
  "enabled": true,
  "searxng": { "url": "http://localhost:8080" },
  "search": {
    "enabled": true,
    "mode": "direct",            // "direct" (REST) | "mcp" (MCP server)
    "autoTrigger": true,
    "triggerStrategy": "llm",   // "llm" | "keywords" | "none"
    "maxResults": 5,
    "language": "all"
  }
}
```

### TTS (Fish Audio)

```jsonc
"tts": {
  "apiKey": "your_fish_audio_key",
  "model": "s1",
  "format": "mp3"
}
```

### Static File Server

Serves generated images so they can be attached to QQ messages.

```jsonc
"staticServer": {
  "port": 8888,
  "host": "192.168.50.173",
  "root": "./output"
}
```

### Event Deduplication

```jsonc
"events": {
  "deduplication": {
    "enabled": true,
    "strategy": "first-received",  // "first-received" | "priority-protocol" | "merge"
    "window": 5000                 // ms window to consider events as duplicates
  }
}
```

---

## Plugin System

### Built-in Plugins

Plugins are enabled in `config.jsonc` under `plugins.list`. All built-in plugins live in `src/plugins/plugins/`.

| Class | Config name | Purpose |
|---|---|---|
| `WhitelistPlugin` | `whitelist` | Allow-list users/groups; marks non-listed senders as `postProcessOnly` so no reply is generated |
| `MemoryPlugin` | `memory` | Debounced LLM extraction of long-term facts from group chat; injects memory into AI replies |
| `MemoryTriggerPlugin` | `memoryTrigger` | On trigger keyword (e.g. bot name), asynchronously merges user input into memory |
| `ProactiveConversationPlugin` | `proactiveConversation` | Ollama-based analysis of group messages; joins conversation when topic matches configured preferences |
| `EchoPlugin` | *(internal)* | TTS echo command handler |
| `NudgePlugin` | `nudge` | Replies with bot status when nudged (戳一戳) |
| `ReactionPlugin` | `reaction` | Adds emoji reactions to incoming messages |
| `AutoRecallPlugin` | `autoRecall` | Automatically recalls messages under configured conditions |
| `MessageOperationPlugin` | `messageOperation` | Maps emoji reactions to operations (e.g. reaction ID 38 → recall bot message) |
| `RulePlugin` | `rule` | Executes built-in commands on cron schedules per group |
| `NsfwModePlugin` | `nsfwMode` | Toggles NSFW mode per session |
| `ConversationConfigPlugin` | `conversationConfig` | Applies dynamic per-session config adjustments |
| `Text2ImgSFWFilterPlugin` | `text2imgSfwFilter` | Forces SFW image templates for specific users in specific groups |
| `GachaPlugin` | `gacha` | One-click NAI image generation with DeepSeek prompt synthesis |

### Writing a Plugin

```typescript
// src/plugins/plugins/MyPlugin.ts
import type { Plugin, PluginContext } from '@/plugins/types';
import type { NormalizedMessageEvent } from '@/events/types';

export class MyPlugin implements Plugin {
  name = 'my-plugin';
  version = '1.0.0';
  description = 'Example plugin';

  async onEnable(context: PluginContext): Promise<void> {
    context.events.onEvent<NormalizedMessageEvent>('message', async (event) => {
      if (event.rawMessage === 'ping') {
        await context.api.call('send_group_msg', {
          group_id: event.groupId,
          message: 'pong',
        });
      }
    });
  }

  async onDisable(): Promise<void> {
    // cleanup resources
  }
}
```

Enable it in `config.jsonc`:

```jsonc
"plugins": {
  "list": [
    { "name": "my-plugin", "enabled": true }
  ]
}
```

### Plugin Lifecycle

1. **`onInit(context)`** — called when the plugin is loaded (optional)
2. **`onEnable(context)`** — called when the plugin is activated
3. **`onDisable()`** — called on shutdown or hot-disable

### Plugin Context

```typescript
interface PluginContext {
  api: APIClient;           // protocol-agnostic API calls
  events: EventRouter;      // subscribe to message / notice / request events
  hookManager: HookManager; // register lifecycle hooks
  bot: { getConfig: () => BotConfig };
}
```

---

## Hook System

Hooks let plugins intercept and modify the message processing pipeline at named extension points.

```typescript
hookManager.on('onMessageReceived',   async (ctx) => { /* first look at event */ });
hookManager.on('onMessagePreprocess', async (ctx) => { /* access control */ });
hookManager.on('onMessageBeforeAI',   async (ctx) => { /* inject extra context */ });
hookManager.on('onAIGenerationStart', async (ctx) => { /* log / modify prompt */ });
hookManager.on('onAIGenerationComplete', async (ctx) => { /* post-process AI text */ });
hookManager.on('onTaskAnalyzed',      async (ctx) => { /* inspect / override task */ });
hookManager.on('onTaskBeforeExecute', async (ctx) => { /* pre-execute gate */ });
hookManager.on('onTaskExecuted',      async (ctx) => { /* inspect result */ });
hookManager.on('onMessageBeforeSend', async (ctx) => { /* final reply edit */ });
hookManager.on('onMessageSent',       async (ctx) => { /* post-send side effects */ });
```

Hook handlers receive a `HookContext` that carries the full processing state: original event, conversation context, current task, reply content, and a type-safe metadata map.

---

## Command System

Commands use a prefix (default `/`). `CommandRouter` strips the prefix, parses the name and arguments, checks permissions, and dispatches to the registered handler.

### Permission Levels

| Level | Who |
|---|---|
| `owner` | Single bot owner defined in config — unrestricted |
| `admin` | Users listed in `bot.admins` — elevated commands |
| `user` | All other users — basic commands only |

### Registering a Command from a Plugin

```typescript
context.hookManager.registerCommand({
  name: 'hello',
  description: 'Say hello',
  permission: 'user',
  handler: async (ctx) => {
    setReply(ctx, 'Hello!', 'command');
    return true; // return true = handled
  },
});
```

---

## Memory System

Long-term memory provides persistent facts about users and groups that survive across sessions.

- **`MemoryService`** — reads and writes memory entries to the database; resolves memory by user ID or group ID
- **`MemoryExtractService`** — sends a batch of recent messages to an LLM and extracts structured facts

**`MemoryPlugin`** runs extraction on a configurable debounce timer and injects retrieved memories into the system prompt before AI generation.

**`MemoryTriggerPlugin`** triggers extraction on-demand when the bot is mentioned, allowing users to update their memory profile by talking to the bot.

---

## Proactive Conversation

`ProactiveConversationPlugin` enables the bot to participate in group conversations without being directly addressed.

1. Collects recent group messages in a sliding time window
2. Uses a secondary LLM (default: Ollama) to score topic relevance against configured preference keys (e.g. `preference.blender`, `preference.tech`)
3. Generates and sends a contextual reply when relevance exceeds the threshold

Configure which groups and preference profiles to use in the plugin config section.

---

## AI Providers

| Provider key | Type | Capabilities |
|---|---|---|
| `openai` | LLM / Vision | Chat, vision |
| `anthropic` | LLM / Vision | Chat, vision (Claude models) |
| `deepseek` | LLM | Chat |
| `doubao` | LLM / Vision | Chat, vision, reasoning |
| `gemini` | LLM / Vision / T2I | Chat, vision, image generation |
| `ollama` | LLM | Local chat |
| `openrouter` | LLM | Aggregated model marketplace |
| `novelai` | T2I | Anime-style image generation |
| `runpod` | T2I / I2V | ComfyUI serverless (image + video) |
| `google-cloud-run` | T2I | ComfyUI on Cloud Run |
| `local-text2img` | T2I | Local Python image server |
| `laozhang` | T2I | Gemini API forwarder |

Providers are selected per-call by `ProviderSelector`. Set a default per capability in `ai.defaultProviders` and override at call time if needed.

---

## Event System

### Event Types

| Type | Description |
|---|---|
| `message` | Private and group chat messages |
| `notice` | Member join/leave, reactions, nudges, recalls |
| `request` | Friend and group join requests |
| `meta_event` | Heartbeat, connection lifecycle |
| `*` | Wildcard — receives all events |

### Event Deduplication

Because all protocols connect to the same LLBot server, the same physical QQ event can arrive from multiple adapters at once. `EventDeduplicator` fingerprints each event (message ID, timestamp, content hash) and drops duplicates within a configurable time window (default 5 s).

---

## Development

```bash
bun run type-check    # TypeScript type checking (tsc --noEmit)
bun run lint          # Biome linter
bun run lint:fix      # Biome linter with auto-fix
bun run format        # Biome formatter
bun test              # Run tests
bun run build         # Production bundle
bun run build:dev     # Development bundle
bun run build:watch   # Watch mode bundle
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CONFIG_PATH` | `./config.jsonc` | Path to config file |

### TypeScript Path Alias

`@/` maps to `src/` (configured in `tsconfig.json` and `bunfig.toml`).

---

## Troubleshooting

**Bot does not connect**
- Verify LLBot is running and the WebSocket / HTTP URLs are correct
- Check `accessToken` matches LLBot's configuration
- Set `LOG_LEVEL=debug` for verbose connection logs

**Plugin not loading**
- The `name` in `plugins.list` must match the `name` property on the plugin class
- Ensure `"enabled": true` is set
- Review startup logs for plugin loading errors

**AI not responding**
- Verify the provider is configured and the API key / base URL are correct
- Check that `ai.defaultProviders.llm` points to an existing provider key
- Ensure at least one enabled protocol connection is established

**Configuration errors**
- `config.jsonc` must be valid JSONC — trailing commas and `//` comments are allowed
- Required top-level sections: `protocols`, `database`, `prompts`
- All other sections are optional

---

## Additional Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Detailed layer and component design
- [`docs/TASK_SYSTEM_ARCHITECTURE.md`](docs/TASK_SYSTEM_ARCHITECTURE.md) — Task system internals with sequence diagrams
- [`docs/CONTEXT_METADATA.md`](docs/CONTEXT_METADATA.md) — HookContext metadata keys reference
- [`docs/REPLY_METADATA_IMPROVEMENT.md`](docs/REPLY_METADATA_IMPROVEMENT.md) — Reply content design notes
- [`prompts/README.md`](prompts/README.md) — Prompt template authoring guide

## License

ISC
