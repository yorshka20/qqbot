# QQ Bot

An AI chat bot that runs on [Bun](https://bun.sh/). It talks to QQ through [LLBot](https://github.com/LLOneBot/LuckyLilliaBot) (Milky, OneBot11, Satori) and can also connect to Discord. Incoming messages go through one pipeline: commands, plugins, a multi-provider LLM, and tools the model can call. Long-term memory, scheduled actions, and an optional admin UI sit beside that pipeline.

## What it does

- **Several protocols at once.** Milky, OneBot11, and Satori via LLBot, plus Discord. The same event arriving on more than one protocol is deduplicated. Connections reconnect on their own.
- **One message lifecycle.** Receive, preprocess, process, prepare, send, complete. Commands are handled in process; if the message is for the model, that path can call tools across multiple turns before a reply is sent.
- **Pluggable models.** OpenAI, Anthropic, DeepSeek, Doubao, Gemini, Ollama, OpenRouter, and others. Which provider runs a call is chosen per call, with a configured default.
- **Tools.** Model-callable tools (search, page fetch, memory, image generation, and others) with a visibility scope: `reply`, `subagent`, or `internal`.
- **Plugins and commands.** Plugins hook the pipeline. Commands are prefix-routed at owner, admin, or user permission.
- **Memory.** Per-user and per-group long-term memory, extracted by the model and recalled when relevant.
- **Agenda.** Proactive actions on a cron, a one-shot time, or an event, written as markdown.
- **Agent cluster.** Optional workers (Claude Code, Gemini, Codex) for batched tasks.
- **Avatar and admin UI.** Optional Live2D speech driver, and a React admin UI (files, reports, memory, cluster, and related views).
- **Storage.** SQLite by default, or MongoDB. Config is JSONC, one file or a directory of files merged by top-level key.
- **Search and retrieval.** Optional SearXNG (or Serper) for web search, and Qdrant for vector retrieval.

## Architecture

The bot is one Bun process. Chat platforms stay outside it.

```
QQ client ── PMHQ ── LLBot ──┐
                             ├── bot process ── LLM providers
Discord ─────────────────────┘         │
                                       ├── plugins / commands / tools
                                       ├── memory, agenda, cluster
                                       └── SQLite or MongoDB
```

LLBot is the QQ protocol bridge: it logs into QQ and exposes Milky / OneBot11 / Satori. Discord connects directly. Each enabled protocol has its own connection. Events are deduplicated, then each message runs the same six stages:

1. **Receive** — the event arrives.
2. **Preprocess** — metadata, permissions, filtering.
3. **Process** — a command, or the model. Tool calls can loop inside this stage.
4. **Prepare** — turn the reply into the segments that will be sent (including an image card when a long reply is rendered).
5. **Send** — deliver on the originating protocol.
6. **Complete** — persist the exchange and any retrieval side effects.

Hooks run at those stages and at a few narrower points (command match, model call, tool call, notices). A handler can stop the rest of the chain. The hook list and when each one fires is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#hook-system).

Commands, tools, and plugins are the three extension surfaces. A command is a prefix the user types. A tool is something the model chooses to call. A plugin is process code that registers hooks, commands, or both, and is turned on from config.

Memory, agenda, and the agent cluster read and write the same sessions from outside those six stages. Search and Qdrant are optional services the tools call when those features are turned on.

Design reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Stage diagrams: [docs/FLOW_DIAGRAMS_EN.md](docs/FLOW_DIAGRAMS_EN.md).

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- Docker with Compose v2, if you use QQ, SearXNG, Qdrant, or WeChat
- A Discord bot token, if you use Discord and skip the QQ bridge
- An API key for at least one LLM provider
- Optional: a system Chromium, if long replies should render as images (`puppeteer-core`)

## Deploy

QQ login and this bot are two different processes:

| Process | What it is | Default port |
|---|---|---|
| LLBot WebUI | QQ login and protocol settings, inside Docker | 3080 |
| This bot | The Bun process, plus its own admin UI | bot has no HTTP port by default; admin UI is separate (`bun run dev` / `bun run ui:start`) |

Discord-only setups skip the Docker section.

### Docker services

`docker compose up` reads only `docker/docker-compose.yml`. That file is the QQ bridge. Everything else is in `docker/docker-compose.optional.yml` and stays stopped until you name its profile.

| | Services | When you need it |
|---|---|---|
| Required for QQ | `pmhq`, `llbot` | The bot talks to QQ |
| Optional | `searxng` | Web search (`mcp.searxng`) |
| Optional | `qdrant` | Vector retrieval (`rag.qdrant`) |
| Optional | `wechat_mysql`, `wechat_redis`, `wechatpadpro` | WeChat ingest (`wechatIngest`) |

Discord does not use either file. SearXNG and WeChat are independent of each other; start only the one you use.

### 1. QQ bridge (required for QQ)

`docker/docker-compose.yml` starts LLBot in PMHQ mode: a privileged `pmhq` container runs the QQ client, and `llbot` talks to it. Current images expect `PROTOCOL_MODE=pmhq`, an auth token, and a config directory on disk.

```bash
cd docker
cp .env.example .env
```

Edit `.env`:

- `LLBOT_AUTH_TOKEN` — from [auth.luckylillia.com](https://auth.luckylillia.com). Current images will not sign in without it.
- Leave `AUTO_LOGIN_QQ` empty the first time. After a successful login you can set it to recover that account across restarts.
- Pin `LLBOT_TAG` and `PMHQ_TAG` once a pair is known-good. `latest` tracks upstream.
- `LLBOT_IMAGE_PREFIX` stays empty for Docker Hub (`linyuchen/llbot`, `linyuchen/pmhq`). Set it only if you pull through a mirror, and include the trailing slash.

The WebUI password is one line in a file:

```bash
mkdir -p llbot_config
printf '%s\n' 'choose-a-webui-password' > llbot_config/webui_token.txt
docker compose up -d
docker compose logs -f llbot
```

Open `http://localhost:3080`, sign in with that password, and log the QQ account in (QR, or the account in `AUTO_LOGIN_QQ`). Then enable the protocols this bot should use, on the ports published by Compose:

- Milky on `LLBOT_MILKY_PORT` (default **3010**)
- OneBot11 on `LLBOT_OB11_PORT` (default **3001**), only if you enable that protocol

The access token you set there must be the same value as `protocols[].connection.accessToken` in the bot config. `docker/.env` and `docker/llbot_config/` are gitignored. `llbot_config/` holds the WebUI password and protocol config; the `qq_volume` volume holds the QQ session. Treat both as secrets.

`pmhq` is `privileged: true` because the image runs the QQ desktop client. Do not point this compose at a shared Docker host.

Upstream detail: [LLBot Docker notes](https://github.com/LLOneBot/LuckyLilliaBot/blob/main/docs/docker.md).

### 2. Optional services

Run these from `docker/`, after the variables for that profile are set in `.env`. Passwords should be alphanumeric; they are interpolated into a MySQL URL and a Redis CLI argument. Each command starts only that profile.

```bash
# SearXNG. Bot config: mcp.searxng.url = http://localhost:8080
docker compose -f docker-compose.optional.yml --profile search up -d

# Qdrant. Also needs an embeddings API (rag.embedding in the bot config: SiliconFlow or any OpenAI-compatible endpoint).
docker compose -f docker-compose.optional.yml --profile rag up -d

# WeChat ingest (WeChatPadPro + MySQL + Redis).
# Set WECHAT_MYSQL_ROOT_PASSWORD, WECHAT_MYSQL_PASSWORD, WECHAT_REDIS_PASSWORD, WECHAT_ADMIN_KEY.
docker compose -f docker-compose.optional.yml --profile wechat up -d
```

WeChatPadPro listens on `WECHAT_HTTP_PORT` (default 8059). The bot's `wechatIngest` plugin listens on the **host** (`listenPort`, default 9920), not in this compose. Point the pad's webhook at `http://<bot-host>:9920/wechat/callback`. From inside the container, the host is `host.docker.internal`, not `localhost`.

### 3. Configure and start the bot

From the repository root:

```bash
bun install
cp config.example.jsonc config.jsonc
```

Or a split config: put several `.jsonc` files in `config.d/`. Files load in alphabetical order and shallow-merge by top-level key. Duplicate keys log a warning; the last file wins.

Resolution order:

1. `CONFIG_PATH` (file or directory)
2. `config.d/`
3. `config.jsonc`

Required keys:

- `protocols` — at least one enabled entry. For QQ, `connection.url` / `apiUrl` point at LLBot (for a bridge on this machine, `127.0.0.1` and the ports from step 1) and `accessToken` matches the token set in the LLBot WebUI. For Discord, set `accessToken` to the bot token and enable the intents listed in the example.
- `database` — `sqlite` plus a path, or `mongodb` plus a connection string
- `bot.owner` — your user id on that platform
- `ai.defaultProviders.llm` and the matching `ai.providers.<name>` (`apiKey`, `baseUrl`, `model`)
- `prompts` — `./prompts`

`config.jsonc` and `config.d/` are gitignored. The example file still shows placeholder hosts; replace them with the machine that actually runs LLBot.

```bash
bun run smoke-test    # boots the real app without live connections
bun run dev           # bot + admin UI, hot reload
```

`smoke-test` runs `startApp()` and then shuts down. It checks dependency-injection registration, module order, and plugin init. A change is not done until it exits 0.

Production, under PM2:

```bash
bun run build
bun run start         # git pull, bun install, pm2 start ecosystem.config.cjs (app name: qq-bot)
bun run ui:start      # admin UI, separate from that PM2 app
```

`pm2 restart qq-bot` is the restart path, including a restart the bot triggers on itself. Logs: `pm2 logs qq-bot`, and files under `logs/`. `LOG_LEVEL=debug` for protocol detail. `CONFIG_PATH` overrides the config location.

## Configuration notes

Subsystems are optional. Turn them on in config when you need them.

| Subsystem | What it is | More |
|---|---|---|
| Plugins | Whitelist, memory, proactive conversation, reactions, and others, via `plugins.list` | [Architecture](docs/ARCHITECTURE.md#plugin-system) |
| Tools | Model-callable tools and their visibility | [Architecture](docs/ARCHITECTURE.md#tool-system) |
| Agenda | Scheduled proactive actions | below |
| Cluster | Multi-worker task execution | [docs/AGENT_CLUSTER_DESIGN.md](docs/AGENT_CLUSTER_DESIGN.md) |
| Avatar | Live2D and speech | [packages/avatar/README.md](packages/avatar/README.md) |
| Admin UI | React UI over the bot's static server | [packages/webui/README.md](packages/webui/README.md) |
| TTS | Multi-provider speech, health-checked | [Architecture](docs/ARCHITECTURE.md#tts-text-to-speech) |
| Memory | Long-term memory and extraction | [Architecture](docs/ARCHITECTURE.md#memory-system) |
| LAN relay | Host/client split across machines | [packages/bot/src/lan/README.md](packages/bot/src/lan/README.md) |

A custom plugin extends `PluginBase`, uses the plugin context (`api`, `events`, `hookManager`), and is listed in `plugins.list` with `enabled: true`. The `name` in config must match the plugin's `name`.

Agenda items live in `data/agenda/schedule.md`:

```markdown
## Morning greeting
- 触发: `cron 0 8 * * *`
- 群: `123456789`
- 冷却: `23h`

每天早上 8 点给群里发一句早安，并简要总结昨天的群聊。
```

Triggers are `cron <expr>`, `once <ISO>`, or `onEvent <event-name>`. Per-run reports go to `data/agenda/reports/YYYY-MM-DD.md`.

Cluster end-to-end checks:

```bash
bun run cluster:e2e:claude
bun run cluster:e2e:gemini
bun run cluster:e2e:codex
```

Worker templates and the project registry are under `cluster` in config.

## Development

```bash
bun run typecheck
bun run lint          # Biome + the container-lookup check
bun run lint:fix
bun run format
bun test
bun run build         # bot bundle
bun run build:admin   # admin UI
bun run debug         # mock messages, no live protocol
```

`NO_FILE_LOG=1` suppresses file logging (smoke-test sets this).

## Troubleshooting

- **LLBot container never becomes healthy.** `docker compose logs pmhq llbot`. PMHQ must pass its healthcheck before LLBot starts. An empty `LLBOT_AUTH_TOKEN` or a missing `llbot_config/webui_token.txt` leaves you on the login page.
- **Bot does not connect.** Protocol URL, port, and `accessToken` must match what the LLBot WebUI is actually serving. `LOG_LEVEL=debug`.
- **No model reply.** `ai.defaultProviders.llm` must name a provider that exists, and that provider's key must be set. At least one protocol must be connected.
- **Plugin did not load.** `plugins.list[].name` matches the class `name`, and `enabled` is true.
- **Smoke-test fails.** The stack is usually a missing DI token or a circular import. Don't continue until it exits 0.
- **Card render is empty.** `puppeteer-core` needs a Chromium it can find; set the executable path in config if it is not on `PATH`.
- **Search or RAG does nothing.** Start the matching profile from `docker-compose.optional.yml` (`search` or `rag`). `mcp` / `rag` in config must point at those ports. RAG also needs the embeddings API in `rag.embedding` (url, apiKey, model).

## Documentation

- [docs/FLOW_DIAGRAMS_EN.md](docs/FLOW_DIAGRAMS_EN.md) — pipeline diagrams
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, hooks, tools, memory, TTS, cluster
- [docs/AGENT_CLUSTER_DESIGN.md](docs/AGENT_CLUSTER_DESIGN.md) — cluster design
- [docs/CONTEXT_METADATA.md](docs/CONTEXT_METADATA.md) — hook context
- [docs/REPLY_PERSISTENCE.md](docs/REPLY_PERSISTENCE.md) — what gets stored after a reply
- [docs/SETUP_OUTLINE.md](docs/SETUP_OUTLINE.md) — outline of a future end-user onboarding guide; deploy steps are in this file
- [packages/avatar/README.md](packages/avatar/README.md) — Live2D avatar
- [packages/webui/README.md](packages/webui/README.md) — admin UI
- [prompts/README.md](prompts/README.md) — prompt templates

## License

ISC
