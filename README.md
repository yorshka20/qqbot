# QQ Bot

A production-ready, AI-powered chat bot framework built with TypeScript and Bun. Connects to QQ via [LLBot](https://github.com/LLOneBot/LLOneBot) (Milky / OneBot11 / Satori), and also speaks Discord. Runs a structured 6-stage message pipeline with commands, plugins, multi-provider LLMs, LLM-callable tools, long-term memory, and optional Live2D avatar + admin WebUI.

## Highlights

- **Multi-Protocol**: Milky, OneBot11, Satori (via LLBot), Discord. Connect to several at once with automatic event deduplication and reconnection.
- **AI Pipeline**: 6-stage message lifecycle, multi-turn tool calling, optional card rendering for long replies (Puppeteer) and direct markdown cards.
- **AI Providers**: OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, OpenRouter, NovelAI, RunPod, Google Cloud Run, Laozhang, and more — selected per call via `ProviderSelector`.
- **Tools**: `@Tool()` decorator with visibility scopes (`reply` / `subagent` / `internal`). Built-ins include search (DuckDuckGo / SearXNG / Serper.dev), web fetch, memory ops, image generation, file read, user-avatar fetch, etc.
- **Plugins**: 14 hook points covering the full pipeline. Built-ins include whitelist, memory, memory-trigger, proactive conversation, nudge, reaction, auto-recall, rule scheduler, gacha, text2img filtering, and more.
- **Commands**: Prefix-based routing with owner / admin / user permission levels.
- **Memory**: Per-user and per-group long-term memory with LLM extraction and mention-triggered recall.
- **Agenda**: Schedule-driven proactive actions (cron / one-shot / event-triggered), authored as markdown.
- **Agent Cluster**: Multi-worker coordination for parallel AI task execution (Claude Code / Gemini / Codex workers).
- **Avatar**: Optional `@qqbot/avatar` package — Live2D action-map compiler, channel mixing, TTS-driven speech.
- **WebUI**: React + Vite admin UI (`@qqbot/webui`) with 14 backends (file browser, reports, memory inspector, cluster dashboard, ...).
- **Persistence**: SQLite (default) or MongoDB; JSONC config with single-file or split-directory layout.
- **MCP & RAG**: Model Context Protocol clients and search-backed retrieval.

## Monorepo Layout

```
qqbot/
├── packages/
│   ├── bot/                # @qqbot/bot — core framework, protocols, AI, plugins, tools, cluster
│   ├── avatar/             # @qqbot/avatar — Live2D animation compiler + speech driver
│   └── webui/              # @qqbot/webui — React admin UI
├── prompts/                # Prompt templates (scenes, tools, agenda, persona, ...)
├── plugins/                # Optional user-defined plugins
├── config.example.jsonc    # Reference config (copy to config.jsonc)
├── docs/                   # Architecture & flow diagrams
└── data/                   # Runtime data (SQLite DBs, agenda, reports) — not committed
```

`packages/bot/src/` (the core framework):

```
core/         # bootstrap, DI registry, config, lifecycle
protocol/     # Milky, OneBot11, Satori, Discord adapters
events/       # EventRouter, EventDeduplicator
conversation/ # MessagePipeline (6-stage), ReplySystem, proactive conversation
command/      # CommandManager, parsers, handlers
ai/           # AIService, LLMService, providers, prompt assembly
tools/        # ToolManager + executors (@Tool() definitions)
agent/        # SubAgentManager — sub-agent execution for advanced tools
hooks/        # 14 hook points
plugins/      # PluginManager, PluginBase, built-in plugins
memory/       # MemoryService, MemoryExtractService
agenda/       # Schedule-driven proactive actions
persona/      # Per-user persona / reaction / reflection
cluster/      # Multi-worker agent coordination
lan/          # Cross-machine host/client roles
api/          # APIClient, APIRouter, MessageAPI
database/     # SQLite & MongoDB adapters
services/     # TTS, static server, file read, claude-code, ...
integrations/ # Bridge to @qqbot/avatar
cli/          # smoke-test, debug, cluster-e2e entry points
```

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- One protocol endpoint:
  - **QQ**: [LLBot](https://github.com/LLOneBot/LLOneBot) (or compatible Milky / OneBot11 / Satori server)
  - **Discord**: bot token + intents
- One LLM provider API key (DeepSeek / OpenAI / Anthropic / ... — pick whatever you can sign up for)
- Optional: a system Chromium for `puppeteer-core` card rendering

## Quick Start

```bash
git clone <repository-url>
cd qqbot
bun install
cp config.example.jsonc config.jsonc
# Or split layout:  mkdir config.d && cp config.example.jsonc config.d/all.jsonc

# Edit config.jsonc — see Configuration below

bun run smoke-test               # MANDATORY — validates DI graph + module initialization
bun run dev                      # bot + WebUI dev server with hot reload
# or:  bun run build && bun run start    for production
```

Setting this up on a fresh machine? A step-by-step onboarding guide is being drafted — see [docs/SETUP_OUTLINE.md](docs/SETUP_OUTLINE.md) for the current outline (prose to follow).

## Configuration

The bot needs a `config.jsonc` (JSONC = JSON with comments). Two layouts:

**Single file:**
```bash
cp config.example.jsonc config.jsonc
```

**Split directory** (recommended for large configs):
```bash
mkdir config.d
# Drop multiple .jsonc files into config.d/, each contributing top-level keys.
# Files are loaded alphabetically and shallow-merged by top-level key.
# Duplicate keys log a warning; the last file wins.
```

**Resolution order:**
1. `CONFIG_PATH` env var (file or directory)
2. `config.d/` in project root
3. `config.jsonc` in project root

**Required top-level keys:**
- `protocols` — one or more protocol entries with `connection.url` + `accessToken`
- `database` — `type: "sqlite" | "mongodb"` + path or connection string
- `bot` — `owner` (QQ ID), optional `admins`
- `ai` — `defaultProviders.llm` (and optionally `text2img`) plus `providers.*` definitions
- `prompts` — directory pointing at `./prompts`

Other sections (`events`, `staticServer`, `mcp`, `contextMemory`, `tts`, `plugins`, `cluster`, ...) are optional. See `config.example.jsonc` for the full shape.

## Subsystems

Each of these is optional and configured in `config.jsonc` when needed.

| Subsystem | Code | Where to read more |
|---|---|---|
| Plugins (whitelist, memory, proactive, ...) | `packages/bot/src/plugins/` | This file + [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#plugin-system) |
| Tools (`@Tool()` decorator) | `packages/bot/src/tools/` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#tool-system) |
| Agenda (schedule-driven proactive actions) | `packages/bot/src/agenda/` | This file (see below) |
| Cluster (multi-worker coordination) | `packages/bot/src/cluster/` | [docs/AGENT_CLUSTER_DESIGN.md](docs/AGENT_CLUSTER_DESIGN.md) |
| Avatar (Live2D + speech) | `packages/avatar/` | [packages/avatar/README.md](packages/avatar/README.md) |
| WebUI (React admin UI) | `packages/webui/` | [packages/webui/README.md](packages/webui/README.md) |
| TTS (multi-provider, health-checked) | `packages/bot/src/services/tts/` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#tts-text-to-speech) |
| Memory (long-term + LLM extraction) | `packages/bot/src/memory/` | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#memory-system) |
| LAN (host/client cross-machine) | `packages/bot/src/lan/` | [packages/bot/src/lan/README.md](packages/bot/src/lan/README.md) |

### Plugins

Built-in plugins are enabled via `plugins.list` in config. Examples: `whitelist`, `memory`, `memoryTrigger`, `proactiveConversation`, `nudge`, `reaction`, `autoRecall`, `rule`, `gacha`, `conversationConfig`, `text2imgSfwFilter`. Custom plugins extend `PluginBase`, use the `PluginContext` API (`api` / `events` / `hookManager`), and register in `plugins.list`. See `packages/bot/src/plugins/PluginBase.ts` and the built-ins under `packages/bot/src/plugins/plugins/`.

### Agenda

Define proactive actions in `data/agenda/schedule.md`:

```markdown
## Morning greeting
- 触发: `cron 0 8 * * *`
- 群: `123456789`
- 冷却: `23h`

每天早上 8 点给群里发一句早安，并简要总结昨天的群聊。
```

Triggers can be `cron <expr>`, `once <ISO>`, or `onEvent <event-name>`. Per-run reports land in `data/agenda/reports/YYYY-MM-DD.md`.

### Agent Cluster

Run parallel AI workers for batched tickets. CLI entry points:

```bash
bun run cluster:e2e:claude
bun run cluster:e2e:gemini
bun run cluster:e2e:codex
```

Worker templates and the project registry are configured under `cluster.*` in config. See [docs/AGENT_CLUSTER_DESIGN.md](docs/AGENT_CLUSTER_DESIGN.md).

## Hooks & Commands

- **Hooks** (14 points): `onMessageReceived`, `onMessagePreprocess`, `onMessageBeforeAI`, `onAIGenerationStart`, `onAIGenerationComplete`, `onCommandDetected`, `onCommandExecuted`, `onMessageBeforeSend`, `onMessageSent`, `onMessageComplete`, plus event / connection hooks. Context shape: [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md).
- **Commands**: Prefix (default `/`), permission levels `owner` / `admin` / `user`. Register via `hookManager.registerCommand()`.

## AI Providers

Provider keys configured under `ai.providers` (examples: `ollama`, `openai`, `anthropic`, `deepseek`, `doubao`, `gemini`, `openrouter`, `novelai`, `runpod`, `google-cloud-run`, `local-text2img`, `laozhang`). Set `ai.defaultProviders.llm` (and optionally `text2img`); `ProviderSelector` chooses per call. Each provider needs at minimum `apiKey`, `baseUrl`, and `model`.

## Development

```bash
bun run typecheck      # tsc -b
bun run lint           # Biome
bun run lint:fix
bun run format
bun test
bun run build          # production bundle (@qqbot/bot)
bun run build:admin    # build WebUI (@qqbot/webui)
bun run debug          # mock message sending for local testing
```

**Smoke test (MANDATORY before commit):**
```bash
bun run smoke-test
```

This boots the real app through `packages/bot/src/core/bootstrap.ts` and verifies DI registration, module loading order, and plugin initialization. It catches circular imports, TDZ errors, and missing DI tokens that `typecheck` cannot. A change is **not** considered complete until `smoke-test` passes.

**Env vars:**
- `LOG_LEVEL` — default `info`, set `debug` for verbose logs
- `CONFIG_PATH` — override config location (file or directory)
- `NO_FILE_LOG=1` — suppress file logging (used by smoke-test / CI)

Path alias: `@/` → `packages/bot/src/`.

## Troubleshooting

- **No connection**: Verify protocol URL and `accessToken`; run with `LOG_LEVEL=debug`.
- **Plugin not loading**: `plugins.list[].name` must match the plugin class `name`; `enabled: true`.
- **No AI reply**: Check provider config / API keys; `ai.defaultProviders.llm` must exist; at least one protocol must be connected.
- **Smoke-test fails**: Read the stack — usually a missing DI token or a circular import. Don't proceed until smoke-test passes.
- **Card rendering empty / errors**: Verify Chromium is findable by `puppeteer-core` (set executable path in config if needed).

## Documentation

- **[docs/FLOW_DIAGRAMS_EN.md](docs/FLOW_DIAGRAMS_EN.md)** — visual walkthrough of every major pipeline (protocols, command, reply / 8-stage AI pipeline, multi-turn tool calling, proactive reply, agenda). Start here.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layer / component design (includes TTS, memory, cluster sections).
- [docs/AGENT_CLUSTER_DESIGN.md](docs/AGENT_CLUSTER_DESIGN.md) — agent cluster original design spec (implementation has since merged; see `packages/bot/src/cluster/` for current behavior).
- [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md) — `HookContext` and metadata flow.
- [docs/REPLY_PERSISTENCE.md](docs/REPLY_PERSISTENCE.md) — reply persistence invariants.
- [packages/avatar/README.md](packages/avatar/README.md) — Live2D avatar internals.
- [packages/webui/README.md](packages/webui/README.md) — admin UI deployment modes.
- [prompts/README.md](prompts/README.md) — prompt template authoring.
- [docs/SETUP_OUTLINE.md](docs/SETUP_OUTLINE.md) — outline of the upcoming step-by-step onboarding guide (Discord-first, English-default).

## License

ISC
