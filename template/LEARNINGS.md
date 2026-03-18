# Project Learnings

本文档记录项目的**架构知识和代码模式**。仅记录可复用的架构细节和经验教训，不记录具体任务的工作日志。

> **使用方式**: 执行任务前阅读相关章节，任务完成后补充新发现的架构知识。
>
> **工作汇报**: Claude Code 的任务执行日志记录在 `workbook/YYYY-MM-DD.md`，按日期归档。

---

## 文档索引

| 文档                 | 位置                              | 用途                                             |
| -------------------- | --------------------------------- | ------------------------------------------------ |
| 项目开发规范         | `CLAUDE.md`                       | 命令、架构概览、代码约定、测试                   |
| 工作流程指南         | `template/WORKFLOW.md`            | 标准任务执行流程（RECEIVE→VERIFY）               |
| 项目知识库           | `template/LEARNINGS.md`（本文档） | 架构细节、代码模式、常见陷阱                     |
| Claude Code 工作日志 | `workbook/YYYY-MM-DD.md`          | Claude Code 每日任务记录、问题排查过程、解决方案 |

### 工作汇报索引

| 日期                                    | 主要内容                                                          |
| --------------------------------------- | ----------------------------------------------------------------- |
| [2026-03-18](../workbook/2026-03-18.md) | Gemini tool use 多轮会话格式修复；toolCallId 缺失导致卡片渲染失败；CardRenderer 外部 CDN 超时修复；Gemini thinking model thought_signature 修复；max rounds 空回复修复 |
| [2026-03-19](../workbook/2026-03-19.md) | 知乎 Feed 订阅服务实现（ZhihuClient / ZhihuContentParser / ZhihuFeedService / ZhihuDigestService + Plugin） |

---

## 架构概览

### 核心模块关系

```
┌─────────────────────────────────────────────────────────────┐
│                         Bot (核心)                          │
├─────────────────────────────────────────────────────────────┤
│  ConnectionManager  ──▶  EventRouter  ──▶  MessagePipeline  │
│         │                     │                   │         │
│         ▼                     ▼                   ▼         │
│  Protocol Adapters      HookManager          ReplySystem    │
│  (Milky/OneBot/Satori)                      CommandSystem   │
└─────────────────────────────────────────────────────────────┘
```

### 独立服务

| 服务       | 位置                       | 职责                            |
| ---------- | -------------------------- | ------------------------------- |
| ClaudeCode | `src/services/claudeCode/` | Claude CLI 任务执行 + MCP Tools |
| WeChat     | `src/services/wechat/`     | 微信消息同步和处理              |
| Zhihu      | `src/services/zhihu/`      | 知乎关注动态拉取 + 摘要推送     |
| MCP        | `src/services/mcp/`        | MCP 客户端管理                  |

### ClaudeCode MCP Tools 架构

```
ClaudeCodeService
├── MCPServer              # HTTP API (port 9876)
│   ├── POST /api/tools/execute  # 执行 tool
│   └── GET  /api/tools/list     # 列出 tools
└── ToolRegistry           # Tool 注册和执行
    ├── ReadFileExecutor   # 读文件
    ├── ProjectInfoExecutor # 项目信息/git状态
    ├── GitCommitExecutor  # git commit
    ├── QualityCheckExecutor # typecheck/lint/test/build
    ├── GitBranchExecutor  # 分支管理
    └── GitPRExecutor      # 创建 PR
```

---

## 代码模式

### 依赖注入

项目使用 `tsyringe` 进行依赖注入。

```typescript
// 定义服务
@injectable()
@singleton()
export class MyService {
  constructor(@inject(SomeDependency) private dep: SomeDependency) {}
}

// 注册 token
container.register(DITokens.MY_SERVICE, { useClass: MyService });

// 解析
const service = container.resolve<MyService>(DITokens.MY_SERVICE);
```

**注意**:

- 使用 `@singleton()` 确保全局单例
- DI token 定义在各模块的 `tokens.ts` 或 `DITokens.ts`
- **token 文件必须零导入**（不 import 任何项目内模块），以避免 barrel re-export 导致的循环依赖 TDZ 错误。executor 应直接从 `tokens.ts` 导入 token，而非从 barrel `index.ts` 导入

### Tool Executor 模式

项目有两种 executor 体系：

#### AI Tool Executor（`src/tools/executors/`，LLM tool use）

通过 `@Tool()` 装饰器注册，由 `ToolManager` 管理。LLM 的 function calling / tool_calls 触发执行。

```typescript
@Tool({
  name: 'tool_name',
  description: '工具描述',
  executor: 'tool_name',
  visibility: ['reply', 'subagent'],  // 可选，默认 ['reply', 'subagent']
  parameters: {
    param1: { type: 'string', required: true, description: '...' },
  },
  whenToUse: '何时使用此工具',
})
@injectable()
export class MyToolExecutor extends BaseToolExecutor {
  name = 'tool_name';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    // 实现逻辑
    return this.success('结果', { data: ... });
  }
}
```

**visibility 控制工具暴露范围:**
- `['reply', 'subagent']`（默认）— LLM 回复流和 SubAgent 都可调用
- `['reply']` — 仅在回复流中可用（如 `format_as_card`）
- `['internal']` — 不暴露给 LLM，仅内部调用（如 `reply`、`deduplicate_files`）

**注册方式:** 装饰器 + 在 `src/tools/executors/index.ts` 中 export（确保装饰器在 import 时执行）。

#### ClaudeCode MCP Tool Executor（独立体系）

位于 `src/services/claudeCode/`，用于 ClaudeCode MCP Server 暴露的 tools（如 git_commit、quality_check 等），直接执行 shell 命令。

**要点**: 不要把两种 executor 混淆。`@Tool()` 装饰的 executor 是给 AI 对话流使用的 tool，MCP Tool Executor 是给 Claude Code CLI 使用的。

### 配置访问

```typescript
// 获取配置
const config = container.resolve(Config);
const botConfig = config.bot;
const aiConfig = config.ai;

// 特定服务配置
const claudeConfig = config.getClaudeCodeServiceConfig();
```

---

## 常见陷阱

### 1. 异步初始化顺序与 DI 循环依赖

**问题**: 服务之间有依赖关系，初始化顺序错误会导致空引用。barrel 文件（`index.ts`）的 re-export 会引发循环导入链，使 `const` 在 decorator 求值时仍处于 TDZ（Temporal Dead Zone），表现为 `ReferenceError: Cannot access 'X' before initialization`。

**解决**:

- 所有初始化逻辑集中在 `src/core/bootstrap.ts` 的 `bootstrapApp()` 函数中，`src/index.ts` 和 `src/cli/smoke-test.ts` 都调用它，禁止在其他地方复制初始化逻辑
- DI token 常量（如 `WechatDITokens`）必须放在独立的 `tokens.ts` 文件中（零导入），executor 直接从 `tokens.ts` 导入，而非从 barrel 导入，以切断循环链
- 使用 `Initializer` 模式（如 `ClaudeCodeInitializer`）
- 对可选依赖使用 `@optional()` 装饰器
- **使用 `bun run smoke-test` 验证**：typecheck 无法检测此类运行时错误

### 2. 协议差异

**问题**: Milky/OneBot11/Satori 的 API 返回格式不完全一致。

**解决**:

- 使用 `APIClient` 统一调用
- 检查返回值中 `message_id` 或 `message_seq` 的存在

```typescript
const result = await apiClient.call<SendResult>(action, params, protocol);
const messageId = result?.message_id ?? result?.message_seq;
```

### 3. 类型导入

**问题**: 循环依赖导致类型错误。

**解决**:

- 使用 `import type` 导入类型
- 将共享类型提取到独立的 `types.ts`

```typescript
import type { SomeType } from "./types"; // 正确
import { SomeType } from "./types"; // 可能导致循环依赖
```

### 4. 路径别名

**问题**: 使用相对路径导致深层嵌套难以维护。

**解决**: 始终使用 `@/` 路径别名

```typescript
import { logger } from "@/utils/logger"; // 正确
import { logger } from "../../../utils/logger"; // 避免
```

### 5. CardRenderer 不得引用外部资源

**问题**: HTML 模板中引用外部 CDN（如 unpkg.com）会导致 `networkidle0` 在网络不可达时超时 30 秒，所有卡片渲染失败。

**解决**: CardRenderer 的 HTML 模板必须完全自包含（内联 CSS/JS），使用 `waitUntil: 'domcontentloaded'`。详见 [2026-03-18 工作日志](../workbook/2026-03-18.md)。

### 6. Gemini Provider 的 tool use 格式

**问题**: Gemini 需要原生 Content[] 格式处理多轮 tool use 会话，且不返回 `toolCallId`。

**解决**: 详见 [2026-03-18 工作日志](../workbook/2026-03-18.md)。核心要点：

- Gemini 需要 `mapChatMessagesToGeminiContents()` 转换为原生格式
- 缺少 `toolCallId` 时需生成合成 ID，确保所有 provider 使用统一的结构化 `tool_calls` 格式

### 7. Gemini thinking model 的 `thoughtSignature`

**问题**: Gemini thinking model（如 gemini-2.5-flash）返回 functionCall 时附带 `thoughtSignature`，如果下一轮不回传则 API 返回 400。

**解决**: `thoughtSignature` 必须在整个 tool use 管线中透传：`generateContentText()` 捕获 → `AIGenerateResponse.thoughtSignature` → `ChatMessageToolCall.thought_signature` → `mapChatMessagesToGeminiContents()` 回填到 functionCall part。详见 [2026-03-18 工作日志](../workbook/2026-03-18.md)。

---

## 最佳实践

### 错误处理

```typescript
// 使用项目定义的错误类型
import { ConfigError, APIError, ConnectionError } from "@/core/errors";

// 错误日志
logger.error("[ModuleName] Error description:", error);

// 在 executor 中返回错误
return this.error("用户可见的错误信息", "详细技术信息");
```

### 日志规范

```typescript
// 模块前缀
logger.info("[ModuleName] Action description");
logger.debug("[ModuleName] Debug info", { data });
logger.error("[ModuleName] Error:", error);

// 避免
console.log("..."); // 不要使用
```

### 文件组织

```
src/services/myService/
├── MyService.ts           # 主服务类
├── MyServiceInitializer.ts # 初始化逻辑
├── types.ts               # 类型定义
├── executors/             # Tool executors
│   ├── index.ts
│   └── SomeExecutor.ts
└── index.ts               # 导出
```

---

## 测试要点

### 必须通过的检查

```bash
bun run typecheck    # 静态类型检查
bun run lint         # 代码规范
bun run smoke-test   # 初始化完整性验证（必须！）
```

> **smoke-test 是硬性要求。** 它调用与 `src/index.ts` 相同的 `bootstrapApp()`（定义在 `src/core/bootstrap.ts`），执行完整的应用初始化流程：Config → DI 注册 → 工具系统 → 插件加载 → 服务验证。typecheck 无法检测循环导入导致的 TDZ 错误、DI token 注册缺失等运行时问题。**变更未通过 smoke-test 不视为完成。**

### 常见 lint 错误

1. **未使用的变量**: 删除或添加 `_` 前缀
2. **any 类型**: 定义具体类型
3. **console.log**: 使用 logger

### 测试新功能

```bash
# 启动开发模式
bun run dev

# 调试模式（mock 消息发送）
bun run debug
```

---

## 待改进项

- [ ] 待改进项1
- [ ] 待改进项2

---

## 更新记录

| 日期       | 更新内容                                                                         | 更新者 |
| ---------- | -------------------------------------------------------------------------------- | ------ |
| 2026-03-18 | 重构文档结构：分离工作汇报到 reports/；修正 Tool Executor 模式说明；添加文档索引 | Claude |
| 2026-03-18 | 添加 ClaudeCode MCP Tools 架构说明                                               | Claude |
| 2024-XX-XX | 初始版本                                                                         | Claude |
