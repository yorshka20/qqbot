# Project Learnings

本文档记录 Claude Code 在执行任务过程中积累的项目知识。每次完成任务后，应更新相关内容。

> **使用方式**: 执行任务前阅读相关章节，任务完成后补充新发现的知识。

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
│  Protocol Adapters      HookManager          TaskSystem     │
│  (Milky/OneBot/Satori)                      CommandSystem   │
└─────────────────────────────────────────────────────────────┘
```

### 独立服务

| 服务 | 位置 | 职责 |
|------|------|------|
| ClaudeCode | `src/services/claudeCode/` | Claude CLI 任务执行 + MCP Tools |
| WeChat | `src/services/wechat/` | 微信消息同步和处理 |
| MCP | `src/services/mcp/` | MCP 客户端管理 |

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

### Task Executor 模式

参考 `src/services/wechat/executors/` 的实现：

```typescript
@TaskDefinition({
  name: 'task_name',
  description: '任务描述',
  executor: 'task_name',
  parameters: {
    param1: { type: 'string', required: true, description: '...' },
  },
})
@injectable()
export class MyTaskExecutor extends BaseTaskExecutor {
  name = 'task_name';

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    // 实现逻辑
    return this.success('结果', { data: ... });
  }
}
```

### 配置访问

```typescript
// 获取配置
const config = container.resolve(Config);
const botConfig = config.bot;
const aiConfig = config.ai;

// 特定服务配置
const claudeConfig = config.getClaudeCodeServiceConfig();
```

### ToolExecutor vs BaseTaskExecutor

**重要区别**：
- `BaseTaskExecutor` (in `src/task/executors/`) - 用于 AI 消息流水线中的任务执行，接收 `(task: Task, context: TaskExecutionContext)`
- `BaseToolExecutor` (in `src/services/claudeCode/types.ts`) - 用于 MCP Tools，接收 `(parameters: Record<string, unknown>)`，直接执行 shell 命令

不要混用这两种 executor 类型。

---

## 常见陷阱

### 1. 异步初始化顺序

**问题**: 服务之间有依赖关系，初始化顺序错误会导致空引用。

**解决**:
- 使用 `Initializer` 模式（如 `ClaudeCodeInitializer`）
- 在 `Bot.start()` 中按顺序初始化
- 对可选依赖使用 `@optional()` 装饰器

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
import type { SomeType } from './types';  // 正确
import { SomeType } from './types';        // 可能导致循环依赖
```

### 4. 路径别名

**问题**: 使用相对路径导致深层嵌套难以维护。

**解决**: 始终使用 `@/` 路径别名

```typescript
import { logger } from '@/utils/logger';        // 正确
import { logger } from '../../../utils/logger'; // 避免
```

---

## 最佳实践

### 错误处理

```typescript
// 使用项目定义的错误类型
import { ConfigError, APIError, ConnectionError } from '@/core/errors';

// 错误日志
logger.error('[ModuleName] Error description:', error);

// 在 executor 中返回错误
return this.error('用户可见的错误信息', '详细技术信息');
```

### 日志规范

```typescript
// 模块前缀
logger.info('[ModuleName] Action description');
logger.debug('[ModuleName] Debug info', { data });
logger.error('[ModuleName] Error:', error);

// 避免
console.log('...');  // 不要使用
```

### 文件组织

```
src/services/myService/
├── MyService.ts           # 主服务类
├── MyServiceInitializer.ts # 初始化逻辑
├── types.ts               # 类型定义
├── executors/             # Task executors
│   ├── index.ts
│   └── SomeExecutor.ts
└── index.ts               # 导出
```

---

## 测试要点

### 必须通过的检查

```bash
bun run typecheck  # 类型检查
bun run lint       # 代码规范
```

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

## 已解决的问题

### [日期] 问题标题

**问题描述**:
简述遇到的问题

**原因分析**:
为什么会出现这个问题

**解决方案**:
如何解决的

**相关文件**:
- `path/to/file.ts`

---

## 待改进项

- [ ] 待改进项1
- [ ] 待改进项2

---

## 更新记录

| 日期 | 更新内容 | 更新者 |
|------|----------|--------|
| 2026-03-18 | 添加 ClaudeCode MCP Tools 架构说明；添加 ToolExecutor vs BaseTaskExecutor 区别说明 | Claude |
| 2024-XX-XX | 初始版本 | Claude |
