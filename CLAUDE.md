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

## 修 Bug 原则：禁止 patch 思路（Root Cause First）

**强约束**：遇到 bug 必须先定位**根因**，从设计层面修复；**禁止**通过堆叠局部 patch / 兜底 / fallback / 缓存 / 特例处理来"压住"症状。

### 执行规则

1. **先诊断根因，再写代码**：在动手修之前，必须能用一句话回答"为什么会出这个 bug"。如果答案是"在某个时刻某变量是错值"——这是症状，不是根因。继续问"为什么那个变量是错值，是哪条设计假设崩了"，直到答到"某个抽象 / 数据流 / 状态机的设计漏洞"为止
2. **方案要消灭根因，不是绕开它**：好的修复**删除**问题成因（错误的 fallback 路径 / 缺失的权威状态 / 不一致的语义）；坏的修复**叠加**新代码（新增 memo / drift / retry / 特殊判断）。如果方案让代码变复杂、检查变多，先怀疑自己没找到根因
3. **Patch 思路的典型信号——出现这些就停下重审**：
   - "如果上次记住了……"（last-emitted memo）
   - "再加一个 fallback"（已经有 fallback 了，再加一层）
   - "在 X 之前先检查 Y"（特例守卫）
   - "缓慢 drift 到正确值"（用时间稀释错误状态）
   - "这种情况下临时关掉 / 跳过"（feature flag 兜底）
   - "重试 N 次"（不知道为啥会失败，所以试运气）
4. **唯一允许 patch 的场景：真正的 edge case**——确认是外部不可控因素（特定厂商 API 抖动 / 第三方库已知 bug / 硬件个例），且根因修复成本远超影响。这种情况必须**显式说明**：
   - 在 PR / commit message / 代码注释里**写明这是 edge-case patch**，不是设计修复
   - 说明 edge case 是什么、为什么不能根治
   - 留一个 follow-up 链接（issue / ticket）记录"什么时候应该升级为根治"

### 与用户协作的方式

- 提交方案前，**先讲根因诊断**，再讲方案如何消灭根因；让用户能审"诊断对不对"，而不是只审"代码对不对"
- 若发现自己的方案在叠 patch（symptom A 加 fallback，symptom B 加 memo……），**主动停下重审**："等等，这是症状治理，根因可能是 X"，不要等用户指出
- 若用户拒绝方案、说"不要 patch"，**重新做根因诊断**，不要换一个角度的 patch 再提交

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

`.claude-workbook/` 与 `.claude-learnings/` 已列入 `.gitignore`，**仅本机笔记**，不要 `git add` 或推送。交付与协作以仓库内已跟踪的代码与文档为准。

项目维护这两个目录，**建议**每次工作阅读并在完成后更新（可选但有用）：

### 开始工作时

1. 阅读本文件 (`CLAUDE.md`)
2. 阅读 `.claude-workbook/index.md` — 了解历史工作情况（先看索引，按需阅读具体日期报告）
3. 阅读 `.claude-learnings/index.md` — 了解项目关键细节和设计要点（先看索引，按需阅读相关 scope 文件）
4. 开始执行任务

### 完成工作后

1. **更新 `.claude-workbook/`**（本机）：在当天日期文件（`YYYY-MM-DD.md`）中记录工作内容（问题描述、根因分析、解决方案、涉及文件、验证结果），然后更新 `index.md` 索引
2. **更新 `.claude-learnings/`**（本机）：将新发现的关键细节和要点写入对应 scope 文件，或新建 scope 文件。然后更新 `index.md` 索引
3. 提交与推送时**只包含**仓库应跟踪的改动；**勿**将上述两目录纳入 `git add`

### 目录结构

```
.claude-workbook/
├── index.md              # 所有日报的摘要索引
├── 2026-03-27.md         # 按日期记录的工作汇报
├── 2026-03-26.md
└── ...

.claude-learnings/
├── index.md              # 所有 scope 的内容索引
├── rendering.md          # Scope: Puppeteer/渲染相关
├── wechat.md             # Scope: 微信 API 相关
├── core.md               # Scope: 核心工具函数/通用模式
├── ai-providers.md       # Scope: LLM provider 集成要点
├── plugins.md            # Scope: 插件开发要点
└── ...                   # 按需新增 scope 文件
```

### 规则

- **Workbook**: 按日期（`YYYY-MM-DD.md`）记录，`index.md` 是所有日报的摘要
- **Learnings**: 按 scope 分文件记录，scope 可按需新增。判断内容应写入已有 scope 还是新建 scope
- **两个目录的 `index.md`** 都必须在内容变更后同步更新，简要记录新增/修改的内容

### Roadmap（每个 scope 文件头部维护）

每个 `.claude-learnings/<scope>.md` 文件**头部**维护一段 ROADMAP 表，把该 scope 下的所有待办、进行中、已完成项汇总。这是规划与记录需求点的单一入口，**确保所有内容都不遗漏**——以后想到该 scope 的新需求，先记进 ROADMAP，再去拆 ticket / 写代码。

参考样例：[`/Users/yorshka/project/video-knowledge-backend/ROADMAP.md`](file:///Users/yorshka/project/video-knowledge-backend/ROADMAP.md)（VKB 仓库的全局 roadmap，本仓库放在 scope 文件头部即可，不必创建顶层 ROADMAP）。

#### Status Legend

- 🔴 **P0** — 阻塞其他工作 / 数据正确性 / 核心功能缺失
- 🟡 **P1** — 重要但不阻塞，按计划推进
- 🟢 **P2** — 改进项，有时间再做
- ⚪ **P3** — 优化 / nice-to-have / 已记录暂不实施
- ✅ **DONE** — 已完成
- 🚧 **WIP** — 进行中
- 📋 **TODO** — 待实施
- 💭 **DESIGN** — 待设计 / 待决策

#### 表格格式

```markdown
## Roadmap

| 状态 | 优先级 | 任务 | 链接 / 备注 |
|---|---|---|---|
| ✅ | — | **完成项标题** | workbook YYYY-MM-DD / commit hash / 备注 |
| 🚧 | 🟡 P1 | **进行中标题** | ticket id 或当前 worker |
| 📋 | 🟢 P2 | **待办标题** | 设计文档链接 / 简述 |
| 💭 | ⚪ P3 | **待设计标题** | 关键问题 / 暂搁原因 |
```

#### 触发更新时机

- **工作完成后**：把新做完的项移到 ✅，并在"链接"列填 workbook 日期 / commit
- **新发现需求**：写一行 📋，避免遗漏；不需要立即做，先记下
- **每次开始工作前**：扫一眼 ROADMAP 决定下一步做什么；ROADMAP 是 scope 内的"全局 TODO 列表"
- **scope 之间相互依赖**时：在备注里相互引用（如 `mind.md` 的 phenotype 任务依赖 `core.md` 的 SQLite 表）