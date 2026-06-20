# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

```bash
# Development with hot reload + WebUI
bun run dev

# Production build and start
bun run build && bun run start

# Type checking
bun run typecheck
# or
bun run type-check

# Linting and formatting
bun run lint          # Check for issues
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
- **Tool System**: LLM-callable tools (search, memory, fetch_page, etc.) with visibility scopes (`reply`/`subagent`/`internal`). Defined via `@Tool()` decorator in `packages/bot/src/tools/executors/`
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
- **Dependency Injection**: Use `@injectable()` and `@singleton()` decorators
- **Async/Await**: Prefer async/await over callbacks
- **Error Handling**: Custom error types (ConfigError, APIError, ConnectionError)

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

### Forbidden Comment Types

When writing comments, it is **forbidden** to smuggle in anything that can only be understood within the current task/session context:

- ❌ "Added this line today to solve problem XX", "added to fix issue #123", "found while debugging last time…"
- ❌ "Currently / today / for now / temporarily like this", "revisit later", "come back and change this when we want the raw content"
- ❌ "Keep consistent with field XX" (pointing at temporary consistency from the current change, not a long-term invariant)
- ❌ "Called by X / used by flow Y" (this info belongs in the PR description or git blame; it goes stale as the code evolves)
- ❌ Adding standalone JSDoc to one type / interface field while no other field in the same interface has comments — this kind of "abrupt local explanation" is almost always session-context leakage.

If a passage can't be understood by someone outside the current conversation, or is just "a decision log for this change", then it belongs in the commit message / PR description / `.claude-workbook/`, **not in a code comment**.

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
3. Run `bun run smoke-test` — **MANDATORY**. Boots the real application through the full initialization path (`packages/bot/src/core/bootstrap.ts`), verifying DI registration, module loading order, and plugin initialization. This catches circular imports, TDZ errors, and missing DI tokens that typecheck cannot detect. **A change is NOT considered fixed/complete until smoke-test passes.**
4. Use `bun run debug` for interactive mock message testing when needed
5. Check WebSocket connections with `LOG_LEVEL=debug` for protocol-level debugging

### Why smoke-test is required

`typecheck` and `build` only validate static types — they cannot catch runtime initialization order issues (circular imports causing TDZ errors, DI tokens referenced before registration, etc.). The `smoke-test` runs the exact same `bootstrapApp()` function as `packages/bot/src/index.ts`, ensuring every service, plugin, and tool executor initializes successfully without live network connections.

### Bootstrap architecture

All initialization logic lives in `packages/bot/src/core/bootstrap.ts` as a single `bootstrapApp()` function. Both `packages/bot/src/index.ts` (production) and `packages/bot/src/cli/smoke-test.ts` call this same function. When adding new services or changing initialization order, only modify `bootstrap.ts` — never duplicate initialization logic elsewhere.

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

## Important Files and Locations

- **Entry Point**: `packages/bot/src/index.ts`
- **Bootstrap (initialization single source of truth)**: `packages/bot/src/core/bootstrap.ts`
- **Core Bot**: `packages/bot/src/core/Bot.ts`
- **Message Pipeline**: `packages/bot/src/conversation/MessagePipeline.ts`
- **AI Service**: `packages/bot/src/ai/AIService.ts`
- **TTS (bot core)**: `packages/bot/src/services/tts/` — `TTSManager`, providers (`FishAudioProvider`, `SovitsProvider`), health adapters under `packages/bot/src/core/health/TtsProviderHealthAdapter.ts`; `/tts` command: `packages/bot/src/command/handlers/TTSCommandHandler.ts`
- **Tool System**: `packages/bot/src/tools/ToolManager.ts`
- **Plugin Manager**: `packages/bot/src/plugins/PluginManager.ts`
- **Configuration**: `config.jsonc` (local, not committed)

## Workflow: Workbook & Learnings

`.claude-workbook/` and `.claude-learnings/` are listed in `.gitignore` — they are **local-only notes**; do not `git add` or push them. Delivery and collaboration rely on the tracked code and docs inside the repo.

The project maintains these two directories; you are **encouraged** (optional but useful) to read them at the start of each work session and update them when done:

### When Starting Work

1. Read this file (`CLAUDE.md`)
2. Read `.claude-workbook/index.md` — to understand past work (read the index first, then specific dated reports as needed)
3. Read `.claude-learnings/index.md` — to understand the project's key details and design points (read the index first, then the relevant scope files as needed)
4. Start the task

### When Work Is Done

1. **Update `.claude-workbook/`** (local): in the current month's folder, record your work in that day's dated file (`YYYY-MM/YYYY-MM-DD.md`) — problem description, root-cause analysis, solution, files involved, verification results — then update **that month's** `YYYY-MM/index.md` (add a line). On the first day of a new month, create the month folder + month index, and add a line for the month in the top-level `index.md`.
2. **Update `.claude-learnings/`** (local): write newly discovered key details and points into the corresponding scope file, or create a new scope file. Then update the `index.md` index.
3. When committing and pushing, **include only** changes that the repo should track; **do not** add the two directories above to `git add`.

### Directory Structure

```
.claude-workbook/
├── index.md              # Top level: lists months only + grep guidance (no individual daily reports)
├── 2026-06/
│   ├── index.md          # Month index: one line per day
│   ├── 2026-06-07.md     # Daily work reports by date
│   └── ...
├── 2026-04/
│   ├── index.md
│   └── ...
└── ...                   # New folder per month (YYYY-MM/)

.claude-learnings/
├── index.md              # Pure pointer layer: one line per scope (stores no content)
├── rendering.md          # Scope: Puppeteer / rendering
├── wechat.md             # Scope: WeChat API
├── core.md               # Scope: core utility functions / common patterns
├── ai-providers.md       # Scope: LLM provider integration points
├── plugins.md            # Scope: plugin development points
└── ...                   # Add scope files as needed
```

### Rules

#### `index.md` Is a **Pure Pointer Layer**, Not a Content Summary (Core Constraint)

The sole job of the `index.md` in both directories is to **let you scan it in one glance and decide which file to open**. It **stores no content** — the single source of truth for content is the body of the scope files (learnings) / the daily files (workbook).

- **Format**: one line per file, `- [filename](file.md) — <one-line hook>` (aligned with the mature pattern in `memory/MEMORY.md`). The hook only answers "roughly what's in this file, and when to open it" — just enough to decide, no more.
- **🚫 Do not append dated deltas to the index** (`2026-XX-XX added: …`). This is the root cause of the current index bloat — every work session writes the change into an index cell, turning it into a second copy of the scope content with unbounded growth. Dated deltas belong in the body of the scope files (learnings) or the daily files (workbook), **not in the index**.
- **When to change an index line**: only when the file's overall theme / coverage changes do you update that one hook line; routine appends to a scope file **leave the index untouched**.
- **Size budget**: keep each `index.md` to a size you can read in one sitting (rule of thumb ≲ 60 lines / ≲ 4KB). If it exceeds that, it means content is being stuffed in again — go back and pull it into the scope / daily files per the rules above.

#### Workbook (Folders by Month, grep First)

- **Folders by month** `YYYY-MM/`, with daily files `YYYY-MM/YYYY-MM-DD.md` (multiple files on the same day use `-2`/`-3` suffixes) recording complete work (problem / root cause / solution / files involved / verification).
- **Search primarily with grep, don't read everything**: search by content with `grep -rn "keyword" .claude-workbook/` (across months); pin down a specific day with the month index. The index only tells you "roughly what was done on which day" — it doesn't replace grep.
- The three index layers each have their own job:
  - Top-level `index.md`: lists **months only** (`- [YYYY-MM](YYYY-MM/index.md) — <one-line theme for the month>`) + grep guidance. **Does not list** individual daily reports.
  - Month `YYYY-MM/index.md`: one line per day (`- [YYYY-MM-DD](YYYY-MM-DD.md) — <topic, ≤14 chars>`), dates in reverse order, multiple files on the same day ordered by `(2)(3)` ascending.
  - Daily files: the full content lives only here.

#### Learnings

- Split files by scope; scopes can be added as needed; judge whether content goes into an existing scope or a new one.
- Each scope file maintains at its **top**, in order: ① (only for large files) a "Table of Contents" TOC linking the major `##` sections via anchors, so people can jump without reading the whole thing; ② a Roadmap table (see "Roadmap Maintenance" below). Dated deltas, design details, and pitfalls all go in the body sections.
- **TOC trigger threshold**: when a scope file exceeds roughly 600 lines / 20KB, it must have a "Table of Contents" TOC at the top. Add a TOC line whenever you add a major section.
- `index.md`: one line per scope; the hook only states what domain the scope covers (e.g. `- [avatar](avatar.md) — Live2D/VRM animation compiler, layer stack, tag syntax, TTS/lipsync`), and **does not list** the specific changes under that scope.

### Roadmap Maintenance (Two-Layer Structure)

This repo's roadmap has two layers, **both gitignored, local-only notes**:

#### Cross-Scope Index: `/ROADMAP.md` (Repo Root)

`/ROADMAP.md` is the cross-scope dashboard / index of active tasks:

- Lists only the **currently active** P0/P1/P2/P3 items + links back to the scope details (including pre-merge checklists / short-term follow-ups / not-yet-started phases)
- **Does not duplicate** completed items (mark them ✅ in the scope file + fill in the commit hash / workbook date; here, a single "merged-history pointer" paragraph pointing at each scope is enough)
- Before **each work session**, scan the active section first to decide the next step; for a **newly discovered requirement**, record it here first, then expand it into the scope file

#### Per-Scope Details: Top of `.claude-learnings/<scope>.md`

Each scope file maintains a ROADMAP table at its **top**, aggregating all todo / in-progress / completed items under that scope (including the full historical phase table). This is the single source of truth within the scope — commit hashes / workbook dates are registered only here, and `/ROADMAP.md` merely references them.

Reference example: [`/Users/yorshka/project/video-knowledge-backend/ROADMAP.md`](file:///Users/yorshka/project/video-knowledge-backend/ROADMAP.md) (the VKB repo's global roadmap — similar pattern but flatter).

#### Status Legend

- 🔴 **P0** — blocks other work / data correctness / missing core functionality
- 🟡 **P1** — important but not blocking, proceed per plan
- 🟢 **P2** — an improvement, do it when there's time
- ⚪ **P3** — optimization / nice-to-have / recorded but deferred
- ✅ **DONE** — completed
- 🚧 **WIP** — in progress
- 📋 **TODO** — to be implemented
- 💭 **DESIGN** — to be designed / decided

#### Table Format

```markdown
## Roadmap

| Status | Priority | Task | Link / Notes |
|---|---|---|---|
| ✅ | — | **Completed item title** | workbook YYYY-MM-DD / commit hash / notes |
| 🚧 | 🟡 P1 | **In-progress title** | ticket id or current worker |
| 📋 | 🟢 P2 | **Todo title** | design doc link / brief |
| 💭 | ⚪ P3 | **To-be-designed title** | key question / reason deferred |
```

#### When to Update

- **After work is done**: in the scope file, move newly finished items to ✅ + fill in the workbook date / commit; at the same time remove them from the `/ROADMAP.md` active section (since they're no longer active).
- **Newly discovered requirement**: first record a 📋 line in the `/ROADMAP.md` active section (so it isn't forgotten), then expand it in the corresponding scope file (nailing down details, design, dependencies).
- **Before each work session**: scan the `/ROADMAP.md` active section first, then dive into scope files as needed.
- **When scopes depend on each other**: cross-reference them in the scope files' notes (e.g. the phenotype task in `persona.md` depends on the SQLite table in `core.md`).