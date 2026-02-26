# QQ Bot

A production-ready, AI-powered QQ bot framework built with TypeScript and Bun. Connects to QQ via [LLBot](https://github.com/LLOneBot/LLOneBot) (Milky / OneBot11 / Satori), runs a structured message pipeline with commands and AI task execution, and supports plugins, memory, and multiple AI providers.

## Features

- **Multi-Protocol**: Milky, OneBot11, Satori via LLBot with automatic reconnection
- **AI Pipeline**: 6-stage message lifecycle, task analysis, reply generation, card rendering for long replies
- **AI Providers**: OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, OpenRouter, NovelAI, RunPod, Google Cloud Run, and more
- **Plugins**: Whitelist, memory, proactive conversation, image generation, gacha, nudge, reaction, auto-recall, rule scheduler, etc.
- **Commands**: Prefix-based routing with owner/admin/user permissions
- **Memory**: Per-user and per-group long-term memory with LLM extraction
- **MCP**: Model Context Protocol and SearXNG search for RAG
- **Persistence**: SQLite and MongoDB; Puppeteer card rendering; TypeScript strict + tsyringe DI

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [LLBot](https://github.com/LLOneBot/LLOneBot) server with protocol endpoints

## Installation

```bash
git clone <repository-url>
cd qqbot
bun install
cp config.example.jsonc config.jsonc
```

Edit `config.jsonc` (JSONC with inline comments). Required: `protocols`, `database`, `prompts`; others optional.

## Quick Start

```bash
bun run dev      # development + debug logging
bun run build && bun run start   # production
bun run debug    # mock message sending
```

## Project Structure

```
qqbot/
├── src/
│   ├── core/           # Bot, config, connection management
│   ├── protocol/       # Milky, OneBot11, Satori adapters
│   ├── conversation/   # MessagePipeline, CommandRouter, TaskSystem, lifecycle
│   ├── command/        # CommandManager, parsers, built-in handlers
│   ├── task/           # TaskAnalyzer, TaskManager, executors
│   ├── ai/             # AIService, providers, prompt, card rendering
│   ├── hooks/          # HookManager, AI/Command/Message/Task hooks
│   ├── plugins/        # PluginManager, PluginBase, built-in plugins
│   ├── memory/         # MemoryService, MemoryExtractService
│   ├── database/       # SQLite & MongoDB adapters
│   └── ...
├── plugins/            # User-defined plugins
├── prompts/            # Prompt templates
├── docs/               # Architecture and design docs
├── config.example.jsonc
└── config.jsonc        # Local config (not committed)
```

## Architecture (Summary)

Messages flow: **LLBot → ConnectionManager → Protocol adapters → EventDeduplicator → EventRouter → ConversationManager → MessagePipeline** (6 stages: receive → preprocess → process → prepare → send → complete). Commands and AI tasks run in the process stage; hooks allow plugins to intercept each stage. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TASK_SYSTEM_ARCHITECTURE.md](docs/TASK_SYSTEM_ARCHITECTURE.md) for details.

## Configuration

Copy `config.example.jsonc` to `config.jsonc`. The example file is annotated; configure at least:

- **protocols** — connection URLs and `accessToken` for each protocol
- **database** — `type` (sqlite | mongodb) and path/connection string
- **bot** — `owner`, optional `admins`
- **ai** — `defaultProviders.llm` (and optionally `text2img`), plus `providers.*` for each service (API keys, base URLs, models)

Other sections (events, staticServer, mcp, contextMemory, tts, plugins, etc.) are optional. See `config.example.jsonc` for the full shape.

## Plugins

Built-in plugins are enabled under `plugins.list` in config. Examples: `whitelist`, `memory`, `memoryTrigger`, `proactiveConversation`, `nudge`, `reaction`, `autoRecall`, `rule`, `gacha`, `conversationConfig`, `text2imgSfwFilter`, and others. Implement custom plugins by extending `PluginBase`, using `PluginContext` (api, events, hookManager), and registering in `plugins.list`. See `src/plugins/PluginBase.ts` and plugins in `src/plugins/plugins/`.

## Hooks, Commands, Memory

- **Hooks**: Register on `onMessageReceived`, `onMessagePreprocess`, `onMessageBeforeAI`, `onAIGenerationComplete`, `onTaskAnalyzed`, `onMessageBeforeSend`, `onMessageSent`, etc. via `hookManager`. Context and metadata: [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md).
- **Commands**: Prefix (default `/`), permission levels owner/admin/user. Plugins register via `hookManager.registerCommand()`.
- **Memory**: `MemoryService` + `MemoryExtractService`; `MemoryPlugin` does debounced extraction; `MemoryTriggerPlugin` triggers on mention.

## AI Providers

Default provider keys (e.g. `ollama`, `openai`, `anthropic`, `deepseek`, `doubao`, `gemini`, `openrouter`, `novelai`, `runpod`, `google-cloud-run`, `local-text2img`, `laozhang`) are configured under `ai.providers`. Set `ai.defaultProviders.llm` and optionally `text2img`; `ProviderSelector` chooses per call.

## Development

```bash
bun run type-check   # tsc --noEmit
bun run lint         # Biome
bun run lint:fix
bun run format
bun test
bun run build        # production bundle
```

**Env**: `LOG_LEVEL` (default `info`), `CONFIG_PATH` (default `./config.jsonc`). Path alias `@/` → `src/`.

## Troubleshooting

- **No connection**: Check LLBot URLs and `accessToken`; use `LOG_LEVEL=debug`.
- **Plugin not loading**: `plugins.list[].name` must match the plugin class `name`; ensure `enabled: true`.
- **No AI reply**: Check provider config and API keys; ensure `ai.defaultProviders.llm` exists and at least one protocol is connected.
- **Config errors**: Use valid JSONC; required top-level: `protocols`, `database`, `prompts`.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Layer and component design
- [docs/TASK_SYSTEM_ARCHITECTURE.md](docs/TASK_SYSTEM_ARCHITECTURE.md) — Task system and executors
- [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md) — HookContext metadata
- [docs/REPLY_METADATA_IMPROVEMENT.md](docs/REPLY_METADATA_IMPROVEMENT.md) — Reply content design
- [prompts/README.md](prompts/README.md) — Prompt template authoring

## License

ISC
