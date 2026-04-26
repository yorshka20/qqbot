# QQ Bot

A production-ready, AI-powered QQ bot framework built with TypeScript and Bun. Connects to QQ via [LLBot](https://github.com/LLOneBot/LLOneBot) (Milky / OneBot11 / Satori), runs a structured message pipeline with commands and AI task execution, and supports plugins, memory, and multiple AI providers.

## Features

- **Multi-Protocol**: Milky, OneBot11, Satori via LLBot with automatic reconnection
- **AI Pipeline**: 6-stage message lifecycle with 8-stage inner AI pipeline, multi-turn tool calling, card rendering for long replies
- **AI Providers**: OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, OpenRouter, NovelAI, RunPod, Google Cloud Run, and more
- **Plugins**: Whitelist, memory, proactive conversation, image generation, gacha, nudge, reaction, auto-recall, rule scheduler, etc.
- **Commands**: Prefix-based routing with owner/admin/user permissions
- **Memory**: Per-user and per-group long-term memory with LLM extraction
- **MCP**: Model Context Protocol and SearXNG search for RAG
- **TTS**: Bot-core registry (`packages/bot/src/services/tts/`) — multi-provider config, health checks, `/tts` command; avatar consumes the same manager for SpeechService (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#tts-text-to-speech))
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
# or use the split layout:
# mkdir config.d && cp config.example.jsonc config.d/all.jsonc
```

Edit config (JSONC with inline comments). Required keys: `protocols`, `database`, `prompts`; others optional.

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
│   ├── core/           # Bot, config, DI, connection management
│   ├── protocol/       # Milky, OneBot11, Satori adapters
│   ├── conversation/   # MessagePipeline, Lifecycle, ReplySystem, proactive conversation
│   ├── command/        # CommandManager, parsers, built-in handlers
│   ├── ai/             # AIService, LLMService, providers, pipeline stages, prompt assembly
│   ├── tools/          # ToolManager, tool executors (LLM-callable tools)
│   ├── hooks/          # HookManager, hook types and priorities
│   ├── plugins/        # PluginManager, PluginBase, built-in plugins
│   ├── memory/         # MemoryService, MemoryExtractService
│   ├── agenda/         # AgendaService, AgentLoop, schedule-driven proactive tasks
│   ├── database/       # SQLite & MongoDB adapters
│   ├── events/         # EventRouter, EventDeduplicator
│   ├── api/            # APIClient, APIRouter, MessageAPI
│   └── ...
├── plugins/            # User-defined plugins
├── prompts/            # Prompt templates
├── docs/               # Architecture and design docs
├── config.example.jsonc  # Example config (single file)
├── config.jsonc          # Local config, single file (not committed)
└── config.d/             # Or: local config, split into multiple .jsonc files (not committed)
```

## Architecture (Summary)

Messages flow: **LLBot → ConnectionManager → Protocol adapters → EventDeduplicator → EventRouter → ConversationManager → MessagePipeline** (6 stages: receive → preprocess → process → prepare → send → complete). Commands and AI reply generation run in the process stage; hooks allow plugins to intercept each stage. See [docs/FLOW_DIAGRAMS_EN.md](docs/FLOW_DIAGRAMS_EN.md) for detailed visual walkthroughs and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component design.

## Configuration

Two config layouts are supported — choose whichever suits your workflow:

### Option A: Single file (simple)

```bash
cp config.example.jsonc config.jsonc
```

All config in one `config.jsonc` file.

### Option B: Split directory (recommended for large configs)

```bash
mkdir config.d
# Split into separate files, each contributing top-level keys:
# config.d/protocols.jsonc  — protocols, api, events
# config.d/bot.jsonc        — bot, memory, staticServer, fileReadService, claudeCodeService
# config.d/database.jsonc   — database
# config.d/ai.jsonc         — ai, contextMemory
# config.d/plugins.jsonc    — plugins
# config.d/services.jsonc   — prompts, tts, mcp, rag (or split further)
```

Files are loaded alphabetically and shallow-merged by top-level key. File names are free-form (no numeric prefix required). Duplicate top-level keys across files will log a warning; the last file wins.

### Resolution order

1. Constructor argument / `CONFIG_PATH` env var (file or directory)
2. `config.d/` directory in project root
3. `config.jsonc` file in project root

Configure at least:

- **protocols** — connection URLs and `accessToken` for each protocol
- **database** — `type` (sqlite | mongodb) and path/connection string
- **bot** — `owner`, optional `admins`
- **ai** — `defaultProviders.llm` (and optionally `text2img`), plus `providers.*` for each service (API keys, base URLs, models)

Other sections (events, staticServer, mcp, contextMemory, tts, plugins, etc.) are optional. See `config.example.jsonc` for the full shape.

## Plugins

Built-in plugins are enabled under `plugins.list` in config. Examples: `whitelist`, `memory`, `memoryTrigger`, `proactiveConversation`, `nudge`, `reaction`, `autoRecall`, `rule`, `gacha`, `conversationConfig`, `text2imgSfwFilter`, and others. Implement custom plugins by extending `PluginBase`, using `PluginContext` (api, events, hookManager), and registering in `plugins.list`. See `src/plugins/PluginBase.ts` and plugins in `src/plugins/plugins/`.

## Hooks, Commands, Memory

- **Hooks**: Register on `onMessageReceived`, `onMessagePreprocess`, `onMessageBeforeAI`, `onAIGenerationStart`, `onAIGenerationComplete`, `onCommandDetected`, `onCommandExecuted`, `onMessageBeforeSend`, `onMessageSent`, `onMessageComplete`, etc. via `hookManager`. Context and metadata: [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md).
- **Commands**: Prefix (default `/`), permission levels owner/admin/user. Plugins register via `hookManager.registerCommand()`.
- **Memory**: `MemoryService` + `MemoryExtractService`; `MemoryPlugin` does debounced extraction; `MemoryTriggerPlugin` triggers on mention.

## AI Providers

Default provider keys (e.g. `ollama`, `openai`, `anthropic`, `deepseek`, `doubao`, `gemini`, `openrouter`, `novelai`, `runpod`, `google-cloud-run`, `local-text2img`, `laozhang`) are configured under `ai.providers`. Set `ai.defaultProviders.llm` and optionally `text2img`; `ProviderSelector` chooses per call.

## Development

```bash
bun run typecheck    # tsc --noEmit
bun run lint         # Biome
bun run lint:fix
bun run format
bun test
bun run build        # production bundle
```

**Env**: `LOG_LEVEL` (default `info`), `CONFIG_PATH` (file or directory, default auto-detect `config.d/` then `config.jsonc`). Path alias `@/` → `src/`.

## Troubleshooting

- **No connection**: Check LLBot URLs and `accessToken`; use `LOG_LEVEL=debug`.
- **Plugin not loading**: `plugins.list[].name` must match the plugin class `name`; ensure `enabled: true`.
- **No AI reply**: Check provider config and API keys; ensure `ai.defaultProviders.llm` exists and at least one protocol is connected.
- **Config errors**: Use valid JSONC; required top-level: `protocols`, `database`, `prompts`.

## Documentation

- [docs/FLOW_DIAGRAMS_EN.md](docs/FLOW_DIAGRAMS_EN.md) — **Architecture flow diagrams** (English) — visual walkthroughs of every major pipeline: protocol layer, command system, reply system (8-stage AI pipeline), multi-turn tool calling loop, proactive reply (message-driven), and agenda (schedule-driven). Start here to understand how the pieces fit together.
- [docs/FLOW_DIAGRAMS_CN.md](docs/FLOW_DIAGRAMS_CN.md) — Same flow diagrams in Chinese
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Layer and component design (includes [TTS](docs/ARCHITECTURE.md#tts-text-to-speech): providers, health, avatar split)
- [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md) — HookContext metadata
- [docs/REPLY_METADATA_IMPROVEMENT.md](docs/REPLY_METADATA_IMPROVEMENT.md) — Reply content design
- [prompts/README.md](prompts/README.md) — Prompt template authoring

## License

ISC
