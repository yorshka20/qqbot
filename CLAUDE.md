# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

```bash
# Development with hot reload + WebUI
bun run dev

# Production: build, then run under the supervisor (scripts/supervisor/)
bun run build && bun run start
bun run status | restart | stop | logs

# Remove cluster worktrees no pool claims (--dry-run lists them)
bun run cluster:gc

# Update a running deployment: fetch, fast-forward only, bun install, restart
bun run deploy          # `bun run deploy --check` reports what it would do

# Type checking
bun run typecheck
# or
bun run type-check

# Linting and formatting
bun run lint          # Check for issues (Biome + lint:di)
bun run lint:di       # Container-lookup check: see Code Conventions → Constructor Injection
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

**Restarting vs. deploying.** In production the bot runs under its own supervisor (`scripts/supervisor/`, `bun run start`), which restarts it whenever it exits. A restart — `bun run restart`, a crash restart, or `/restart` in chat — runs the code already checked out and never pulls or installs. Updating is `bun run deploy` (or `/deploy`): fetch, fast-forward only, hold the bot stopped, `bun install` while it is stopped (nothing holds `node_modules`, so no bun `EEXIST`), start it. It refuses before stopping the bot when the branch has diverged or a fast-forward would run over uncommitted changes. On macOS start the supervisor from Terminal.app or over SSH: only those reach the local network unconditionally (Apple TN3179), and a launchd agent does not reach it at all. The WebUI is separate (`bun run ui:start`).

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
- **Tool System**: LLM-callable tools (search, memory, fetch_page, etc.) with visibility scopes (`reply`/`subagent`/`internal`/`agent`). Defined via `@Tool()` decorator in `packages/bot/src/tools/executors/`
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
- **Dependency Injection**: A service is a `@singleton()` class that names every constructor dependency with an explicit `@inject(Class)` or `@inject(DITokens.X)` — never rely on inferred metadata (Biome turns type-only class imports into `import type`, which silently breaks it). Read config values from an injected `Config` in the constructor. Don't add a `registerInstance` / factory for a service; keep `DITokens` for external values, config-assembled registries, interfaces, gated optionals and startup products, and expose a class under a string token only with `registerAlias`. A service module never imports its own consumers — decorator registries are imported by `bootstrap.ts`. The container is global (`getContainer()`) and is never passed as a parameter
- **Constructor Injection, Not Lookup**: an object the container builds, whose dependencies exist when it is built, takes them all in its constructor — no `getContainer().resolve()` in its constructor or methods. Run-time lookup is correct only for: plugins (built by `PluginManager`, deliberately outside DI — never convert them), the composition root and startup steps (bootstrap / app / wiring / `*Initializer` / cli), registries resolving members by class (ToolManager, CommandManager, FanoutManager), objects DI does not build (AI providers, static-server backends), core code reading plugin state via `PluginManager`, and config-gated optional services checked with `isRegistered`. The full rule is in `docs/ARCHITECTURE.md` (Dependency injection). `bun run lint:di` (run by the pre-commit hook) fails on any other `getContainer()` call unless it is marked `// container-lookup: <registry|not-di-built|plugin-state|optional-service|startup> <why>` — add that marker only after deciding the lookup is really one of these exceptions
- **Async/Await**: Prefer async/await over callbacks
- **Error Handling**: Custom error types (ConfigError, APIError, ConnectionError)
- **Control Flow**: Always use curly braces for `if`/`else`; ESM `import` only, never inline `require()`
- **No Defensive Optionals**: Make a field non-optional when the value is always set (metadata, protocol types); don't add an optional param plus fallbacks for a case the config already guarantees
- **Single Representation**: One field, not a boolean alongside a parallel enum — use `replyTriggerType` alone, never `triggeredByAtBot` + `triggeredByWakeWord` + `replyTriggerType`
- **An LLM Is a Target**: Address an LLM as one `LLMTarget` (`{ provider, model? }`) everywhere — config, call sites, routing, session overrides, fallback. Never carry a provider name and a model separately (no `XModel` key beside `X`, no `model` in call options): a model means nothing to another provider, and split fields let it reach the wrong one
- **One Shape for Single/Multi**: Keep the same format for one and many — a card deck is always an array, a single card is `[card]`
- **Derive, Don't Hardcode**: Never hardcode a list or an ordering the module can supply (capabilities come from `ProviderRegistry`); default to alphabetical ordering unless there is a stated reason
- **Reuse Over Reimplementation**: Use the existing shared utility (e.g. image-to-base64 + mime) and promote common logic into a shared module instead of writing a second copy
- **One Entry Point**: Unify duplicate code paths behind a single entry (e.g. `handleCardReply`) rather than parallel methods that duplicate logic
- **Keep Provider Code in the Provider**: Don't put non-provider modules inside the provider directory; provider-specific state (e.g. key mode) belongs on the provider class
- **Gate Permissions Once**: Check at the service that invokes the LLM (`ReplyGenerationService`, `ProactiveConversationService.runAnalysis`), not redundantly at every caller

## Engineering Principles

- **Read docs before implementing, update docs after changing implementation**: Read the relevant design docs before writing code, and when you change the actual implementation, update the documents it affects. Architecture reference: `docs/ARCHITECTURE.md`.
- **Prefer good third-party libraries**: Do not hand-roll a poor implementation when a high-quality library is available.
- **Hold a high implementation bar**: Code with weak architectural design is never acceptable. Always respect the existing module/system design when implementing a new feature within a given scope.
- **Correct me when I'm wrong**: Always respect the truth. I may be wrong, and you must not accept a wrong suggestion. If your view differs from mine, check whether I've made a mistake before agreeing.

## Bug-Fixing Principle: No Patch Mindset (Root Cause First)

**Hard constraint**: When you hit a bug, you must first locate the **root cause** and fix it at the design level. It is **forbidden** to suppress symptoms by stacking local patches / safety nets / fallbacks / caches / special-case handling.

### Execution Rules

1. **Diagnose the root cause before writing code**: Before you start fixing, you must be able to answer "why does this bug happen" in a single sentence. If the answer is "at some moment some variable held a wrong value" — that's a symptom, not the root cause. Keep asking "why did that variable hold a wrong value, which design assumption broke" until you reach "a design flaw in some abstraction / data flow / state machine".
2. **The fix must eliminate the root cause, not work around it**: A good fix **removes** the cause of the problem (a wrong fallback path / a missing authoritative state / inconsistent semantics); a bad fix **stacks** new code (adding a memo / drift / retry / special check). If the fix makes the code more complex and adds more checks, first suspect that you haven't found the root cause.
3. **Typical signals of patch thinking — stop and re-examine when these appear**:
   - "If we remembered it last time…" (last-emitted memo)
   - "Add another fallback" (there's already a fallback, adding one more layer)
   - "Check Y before X" (special-case guard)
   - "Slowly drift to the correct value" (diluting a wrong state with time)
   - "Temporarily turn off / skip in this case" (feature-flag safety net)
   - "Retry N times" (don't know why it fails, so try our luck)
4. **The only scenario where a patch is allowed: a genuine edge case** — confirmed to be an uncontrollable external factor (a specific vendor's API jitter / a known third-party library bug / a one-off hardware case), and the cost of a root-cause fix vastly exceeds its impact. In this case you must **state it explicitly**:
   - In the PR / commit message / code comment, **write that this is an edge-case patch**, not a design fix
   - Explain what the edge case is and why it can't be properly cured
   - Leave a follow-up link (issue / ticket) recording "when this should be upgraded to a proper fix"

### How to Collaborate with the User

- Before proposing a fix, **present the root-cause diagnosis first**, then explain how the fix eliminates the root cause; let the user review "whether the diagnosis is right", not just "whether the code is right".
- If you notice your own fix is stacking patches (symptom A gets a fallback, symptom B gets a memo…), **stop and re-examine on your own**: "Wait, this is treating symptoms, the root cause might be X" — don't wait for the user to point it out.
- If the user rejects the fix and says "no patches", **redo the root-cause diagnosis**; don't submit another patch from a different angle.

## Comment Style: No Session-Context Comments

**Write no comments by default**. The code's identifiers already explain "what it does"; only write a comment when the *why* is not obvious — a hidden constraint, a counter-intuitive invariant, a workaround for some external bug, a point in the flow that needs caution.

Comments are written in **English**. This default governs the comments you *add*: when editing existing code, do not delete comments that are already there.

### Forbidden Comment Types

When writing comments, it is **forbidden** to smuggle in anything that can only be understood within the current task/session context:

- ❌ "Added this line today to solve problem XX", "added to fix issue #123", "found while debugging last time…"
- ❌ "Currently / today / for now / temporarily like this", "revisit later", "come back and change this when we want the raw content"
- ❌ "Keep consistent with field XX" (pointing at temporary consistency from the current change, not a long-term invariant)
- ❌ "Called by X / used by flow Y" (this info belongs in the PR description or git blame; it goes stale as the code evolves)
- ❌ Adding standalone JSDoc to one type / interface field while no other field in the same interface has comments — this kind of "abrupt local explanation" is almost always session-context leakage.

If a passage can't be understood by someone outside the current conversation, or is just "a decision log for this change", then it belongs in the commit message / PR description / `_kb/workbook/`, **not in a code comment**.

### Allowed Comment Types

Comments should be written so that "someone who doesn't know the current task still benefits":

- ✅ Explain **why this code must exist** (eliminates a class of bug, maintains some invariant, a hard constraint of an external protocol it interfaces with)
- ✅ Mark **error-prone points in the flow** ("the call order can't be swapped, X depends on Y's side effect", "this looks redundant but removing it triggers Z")
- ✅ Cite **external specs / vendor docs / standards** ("per RFC xxxx §3.2", "works around chromium bug crbug/12345") — locatable and verifiable.
- ✅ Mark an **edge-case patch** (per the rules in the previous section, must be explicitly declared with a follow-up link).

### Self-Check

After writing a comment, ask yourself: **"Half a year from now, will a newcomer reading this line understand it?"** If the answer depends on "knowing the history of this change", delete it.

## Testing Approach

When testing changes:
1. Run `bun run typecheck` — static type checking
2. Run `bun run lint` — code quality
3. Run `bun run smoke-test` — **MANDATORY**. Boots the real application through `startApp()` (`packages/bot/src/core/app.ts`) without live connections — full bootstrap, plugins enabled as configured, a settle window for async failures, then the real shutdown — verifying DI registration, module loading order, and plugin initialization. This catches circular imports, TDZ errors, and missing DI tokens that typecheck cannot detect. **A change is NOT considered fixed/complete until smoke-test passes.**
4. Use `bun run debug` for interactive mock message testing when needed
5. Check WebSocket connections with `LOG_LEVEL=debug` for protocol-level debugging

**Tests never wait out a production delay.** A full `bun test` is meant to stay around 20 s. Drive a
fixed delay with fake timers (`jest.useFakeTimers()`; `Bun.sleep` never resolves under them, `setImmediate`
stays real) or shorten it through the config value or option that sets it; poll for a condition
instead of sleeping for a guessed time. Tests that need real git share one seed repository through
`worktreeFixtures`. Rank files with `bun test --reporter=junit --reporter-outfile=<file>` before
blaming a suspect. Discovery is scoped in `bunfig.toml`: a directory of checkouts anywhere but a dot
directory must be listed in `pathIgnorePatterns`, or every copy runs as part of the suite.

When template files already exist on disk, load them with `loadTemplatesFromDirectory()` so the test exercises the production path; don't hand-register via `registerTemplate` when the file is right there.

**Never put real user data in tests or in prompt files.** No real QQ numbers, group ids,
nicknames, or verbatim chat content — not in fixtures, not in assertions, not in the
few-shot examples inside `prompts/`. Use obviously-synthetic stand-ins (`10000001`,
`测试用户甲`, `甲`/`乙`). Copying identifiers straight out of a `logs/llm-dumps/` file while
debugging is the usual way this happens: those dumps are local-only, the tests and prompts
are committed and shared. Anonymising costs nothing — a fixture never needs the real name
to prove the behaviour.

### Why smoke-test is required

`typecheck` and `build` only validate static types — they cannot catch runtime initialization order issues (circular imports causing TDZ errors, DI tokens referenced before registration, etc.). The `smoke-test` runs the exact same `startApp()` as `packages/bot/src/index.ts`, only without `connect`, so it loads the same module graph and exercises the same initialization and shutdown code.

### Bootstrap architecture

All initialization logic lives in `packages/bot/src/core/bootstrap.ts` as a single `bootstrapApp()` function, reached only through `startApp()` in `packages/bot/src/core/app.ts`, which adds the connect phase and the one shutdown sequence. Production, the smoke test, cluster-e2e and the debug CLI all call `startApp()`. When adding new services or changing initialization order, only modify `bootstrap.ts` / `app.ts` — never duplicate initialization logic elsewhere.

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

## Packages

A `packages/*` bun workspace. **A package never imports the bot**; inside a package use relative
paths, not `@/`. Glue that needs bot internals (tool executors, commands, plugins) stays in the bot.
Config types travel with their package — the package exports its own slice and `BotConfig` composes
them, so the dependency only ever runs bot → package.

- **`@qqbot/shared`** (`packages/shared/`) — the base layer everything sits on: `logger`, `logFiles`,
  `repoRoot`, `randomUUID`, `dateTime`, `duration`, the error hierarchy, `HttpClient`,
  `ResourceDownloader` and `writeFileUnderDirectory`. Image resizing (sharp) is the separate
  `@qqbot/shared/image` entry so the root barrel never loads a native binding. The logger
  knows nothing about messages: it reads per-entry context through `setLogContextSource`, which the
  bot installs in `bootstrap.ts` from `packages/bot/src/context/logContextSource.ts` (where the
  per-group/user filter rules live). The health-check contract (`HealthCheckable`, `HealthStatus`,
  `BaseHttpHealthCheck`) is in the root barrel; `HealthCheckManager`, which runs the checks, is the
  separate `@qqbot/shared/health` entry — it is a tsyringe singleton, and tsyringe throws on import
  without `reflect-metadata`, which the barrel's 370 importers should not have to load for a logger.
- **`@qqbot/api-types`** (`packages/api-types/`) — the HTTP contract between
  `packages/bot/src/services/staticServer/` backends and the WebUI. Types only, no runtime code, no
  dependencies. Both sides import it, so a response shape that changes on one side alone fails to
  compile. A backend never re-declares a wire shape: either it imports the contract type, or it pins
  the domain object it sends with an explicit `jsonResponse<T>(...)` at the response site.
- **`@qqbot/avatar`** (`packages/avatar/`) — VRM / Cubism body layer; depends only on
  `@qqbot/shared` and `tsyringe`.
- **`@qqbot/agent-cluster`** (`packages/agent-cluster/`) — everything that runs coding-agent CLIs:
  the cluster (`src/cluster/`: scheduler, worker pool, hub + `HubMCPServer`, ticket storage and
  format, and `workspace/`: the per-project git worktree pool, task branches and merges into a job's
  integration branch), the coding-agent task layer (`src/codingAgent/`: executors, `CodingAgentTaskManager`, its
  on-disk record store, `ProjectRegistry`) and the CLI stream parsers (`src/cli/`). Its config types
  (`CodingAgentConfig`, `ProjectRegistryConfig`, `TicketsConfig`) live in `src/config.ts`.
  `ProjectRegistry` is the separate `@qqbot/agent-cluster/projects` entry for the same reason as
  health above, and takes its options through the package's `PROJECT_REGISTRY_OPTIONS` token, which
  `core/wiring.ts` registers. The chat side — `CodingAgentService` with its MCP server, delivery and
  tool bridge, the `/claude` `/codex` `/dsh` plugin, owner escalation for `hub_ask`, and the cluster,
  ticket and task WebUI backends — is glue in `packages/bot/src/integrations/agent-cluster/`.
- **`@qqbot/llm`** (`packages/llm/`) — calling a model: the `AIProvider` contract and capabilities,
  every vendor's implementation, `AIManager` / `ProviderRegistry` / `ProviderFactory`, batch
  submission, the RunPod / Cloud Run ComfyUI clients, and the provider config types with `LLMTarget`,
  `describeLLMTarget` and `ReasoningEffort` (`src/config.ts`). No DI inside: the bot builds `AIManager`
  in `ai/createAIManager.ts` and registers it in `core/wiring.ts`. A provider sends exactly the
  `messages` (or `systemPrompt` + `prompt`) it is given and keeps its vendor's wire quirks to itself
  (DeepSeek's DSML is parsed in `DeepSeekProvider`). Which provider a message goes to (`ProviderRouter`,
  `ProviderSelector`, `LLMService` fallback), the prompt it gets and what happens to the reply stay in
  the bot — so do `LLMService`'s own types (tool-loop options, trace entries) in `packages/bot/src/ai/types.ts`.
- **`@qqbot/retrieval`** (`packages/retrieval/`) — retrieval without an LLM: web search (SearXNG
  direct or over MCP, Serper, provider fallback), page fetching (Readability, Jina Reader, SSRF
  guards) and vector RAG (embeddings + Qdrant). Its config types (`MCPConfig` for the `mcp` key,
  `RAGConfig` for `rag`) live in `src/config.ts`. `RetrievalService` is the separate
  `@qqbot/retrieval/service` entry (a tsyringe singleton) and injects the package's
  `RETRIEVAL_OPTIONS`, which `core/wiring.ts` registers. Deciding what to search, rendering results
  for a model (the `search` tool) and LLM filter-refine (proactive replies) stay in the bot, as does
  the Qdrant explorer WebUI backend (`packages/bot/src/integrations/retrieval/`).
- **`@qqbot/webui`** (`packages/webui/`) — Vite + React admin console; talks to the bot only over HTTP.

Remaining splits are planned in the knowledge base (`_kb/tasks/09-monorepo-and-package-split/`).

## Important Files and Locations

- **Entry Point**: `packages/bot/src/index.ts`
- **Bootstrap (initialization single source of truth)**: `packages/bot/src/core/bootstrap.ts`
- **Core Bot**: `packages/bot/src/core/Bot.ts`
- **Message Pipeline**: `packages/bot/src/conversation/MessagePipeline.ts`
- **AI Service**: `packages/bot/src/ai/AIService.ts`
- **LLM providers**: `packages/llm/src/providers/` (registry: `packages/llm/src/AIManager.ts`)
- **TTS (bot core)**: `packages/bot/src/services/tts/` — `TTSManager`, providers (`FishAudioProvider`, `SovitsProvider`), health adapters under `packages/bot/src/core/health/TtsProviderHealthAdapter.ts`; `/tts` command: `packages/bot/src/command/handlers/TTSCommandHandler.ts`
- **HTTP backends (WebUI/REST)**: `packages/bot/src/services/staticServer/backend.ts` — the `Backend` extension point and its registry. Each module registers its own routes at import time (`ClusterAPIBackend` in `cluster/`, `MemoryStatusBackend` in `memory/`, …); `packages/bot/src/core/staticBackends.ts` is the list the composition root pulls in. `staticServer` must not import a feature module.
- **Cluster tickets**: `packages/agent-cluster/src/cluster/tickets/` — `storage.ts` (on-disk bucket layout), `markdown.ts` (frontmatter format); `/api/tickets` is `packages/bot/src/integrations/agent-cluster/TicketBackend.ts`. The cluster hub, the agenda dispatcher and the WebUI all read tickets through these.
- **Tool System**: `packages/bot/src/tools/ToolManager.ts`
- **Plugin Manager**: `packages/bot/src/plugins/PluginManager.ts`
- **Session Memo Store**: `packages/bot/src/conversation/memo/SessionMemoStore.ts` — LLM-writable per-session memo/blackboard with TTL + pin. Complements AuditEventStore (bot-written) and MemoryService (long-term).
- **QQ Face Table**: `packages/bot/src/message/qqFace.ts` + `qqFaces.json` — id↔name table, `[表情:名字]` marker expansion, reaction id resolution, prompt vocabulary.
- **Session Memo Tool**: `packages/bot/src/tools/executors/SessionMemoToolExecutor.ts` — `session_memo` tool exposed to LLM at reply stage (`action=add|delete|list`).
- **Configuration**: `config.jsonc` (local, not committed)

## Domain Notes

Non-obvious specifics that are easy to get wrong:

- **Card rendering**: `convert_to_card` output is a JSON array of cards; a single card is `[card]`. The comparison card takes `leftHeader` / `rightHeader` from data, not fixed labels.
- **Reply trigger**: centralized in `MessageTriggerPlugin`; the type lives on `replyTriggerType` (`at` | `reaction` | `wakeWordConfig` | `wakeWordPreference` | `providerName`).
- **Whitelist config**: per-group limited permissions use the `groups` key (array of `{ id, capabilities }`). `groupIds` must stay a plain string array — putting objects there breaks lookup.
- **QQ faces**: `[表情:名字]` is the canonical text form of a `face` segment in both directions — inbound rendering, the marker the LLM writes, and what lands in history. The name↔id table is `packages/bot/src/message/qqFaces.json`; never hand-write a face list beside it.
- **Reactions (贴表情)**: every reaction goes through `ReactionPlugin.react()`, which owns the whitelist capability check and the per-group cooldown. Callers (the `react` tool, proactive analysis) never send one directly.

## Where Conventions Live

A rule's home depends on who has to see it:

- **`CLAUDE.md`** (this file, tracked) — commands, architecture, code conventions, comment style,
  commit style, testing. **A rule about how code is written or how work is delivered belongs here**,
  next to its peers.
- **`.claude/memory/`** (tracked) — accumulated learned preferences and hard-won project facts, one
  file per entry, indexed by `.claude/memory/MEMORY.md`. The kind of thing that surfaces through a
  correction ("don't thread that value through", "that silence marker is intentional").
- **`_kb/CLAUDE.md`** (the local knowledge base, a separate private repo) — how the **documentation**
  is organised: roadmap, tasks, workbook, learnings, design docs. Rules about recording work go there.

**Code rules stay tracked in this repo on purpose.** The user works across several machines, and the
cluster's CLI workers read this repository's files — they cannot see a knowledge base that exists on one
machine. A code convention parked in `_kb/` (or in an agent's own private memory directory) silently
stops applying the moment the user switches machines or a worker picks up a ticket.

So an agent working on this code reads **two** files: this one (how to write code) and `_kb/CLAUDE.md`
(how to record what you did). Do not consolidate them — a copy in either direction just drifts.

`AGENTS.md` is a pointer to this file, not a second copy — codex and gemini read it and are directed
here. Do not start a parallel rule list there.

## Git Commit Messages

**Write them in English — subject and body both.** No Chinese in a commit message, whatever
language the conversation that produced the change was in.

**Keep them short.** A one-line subject plus a few sentences saying what changed and why it was needed. Root-cause analysis, empirical findings, endpoint/API comparisons, benchmark numbers, design trade-offs — none of that belongs in a commit body.

Concretely: **body ≤ 5 lines of prose, and no bullet lists, tables, code blocks, or logs.** Reaching
for any of those means the content belongs in the workbook, not here. A body that enumerates every
affected call site is already too long — name the defect once and point at the report.

Those details go into that day's `_kb/workbook/` report, and the commit body points at it:

```
refactor(cluster): check worker credentials over HTTP instead of spawning CLIs

The startup probe really spawned a CLI per enabled template, trading a fixed ~11.8k input
tokens for 9 output tokens each time. Each backend now hits its provider's model-metadata
endpoint through verifyCredentials(): no process, no tokens.

See workbook 2026-08-27-cluster-probe.
```

Write the workbook entry first, then write the commit against it. The analysis then exists in exactly one place instead of being written twice and drifting.

The `Co-Authored-By:` trailer convention is unchanged.

## Workflow: Planning Docs Live in the Local Knowledge Base (`_kb/`)

The roadmap, per-task plans, workbook and learnings are **not in this repo** anymore. They live in a
private local knowledge base, linked into the repo as **`_kb/`** (a symlink ignored via
`.git/info/exclude`). Moved out on 2026-11-02 so the code history never carries private notes and the
docs can be committed on their own.

**Read `_kb/CLAUDE.md`** for the documentation conventions — it governs how the roadmap, tasks,
workbook and learnings are organised, and it replaces what this section used to describe at length.

| What | Where |
|---|---|
| Active work, one row per task | `_kb/ROADMAP.md` |
| Task list (21 tasks) | `_kb/tasks/index.md`, then that task's `plan.md` |
| A task's items / open decisions | `_kb/tasks/NN-<code>/roadmap.md` · `todo.md` |
| Start-context for a half-finished task | `_kb/tasks/NN-<code>/handoff/` |
| Dated work reports (problem / root cause / fix / verification) | `_kb/workbook/YYYY-MM/` |
| Knowledge per scope (key details, pitfalls) | `_kb/learnings/<scope>.md` |
| Local design docs (was `docs/local/`) | `_kb/design/` |

**When starting work:** read this file, then `_kb/CLAUDE.md`; scan `_kb/ROADMAP.md`, and for the task
at hand its `plan.md` / `roadmap.md` and latest handoff; `grep -rn "keyword" _kb/workbook/` instead of
reading reports top to bottom.

**When work is done:** write the workbook entry (`_kb/workbook/YYYY-MM/YYYY-MM-DD-<topic>.md`), put new
facts and pitfalls in the matching `_kb/learnings/<scope>.md`, update the task's `roadmap.md` / `todo.md`,
then refresh the generated scope views: `cd _kb && python3 ../_shared/scripts/kb-roadmap.py .`
(the `## Roadmap（生成视图）` block at the top of each learnings file is generated — never edit it by hand).

**If `_kb` is missing** on this machine or in a fresh worktree, ask the user for the kb root and run
`<kb>/kb-link.sh qqbot` from the repo root.

**What stays in this repo:** the docs under `docs/` that describe the shipped architecture
(`ARCHITECTURE.md`, `FLOW_DIAGRAMS_EN.md`, `CONTEXT_METADATA.md`, `REPLY_PERSISTENCE.md`,
`SETUP_OUTLINE.md`, `AGENT_CLUSTER_DESIGN.md`), this file, `AGENTS.md`, `README.md` and
`.claude/memory/` — see "Where Conventions Live".
