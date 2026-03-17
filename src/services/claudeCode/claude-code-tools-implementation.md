# Claude Code Tools Implementation Plan

## 概述

本文档定义了为 ClaudeCode 服务补充的 MCP Tools，使 AI 能够按照规范完成完整的 coding 工作流。

**目标**：让 Claude Code 在执行编程任务时，能够通过调用这些 tools 来：
1. 按照项目规范进行 Git 操作
2. 执行代码质量检查
3. 获取项目上下文信息
4. 与 Bot 系统交互反馈进度

---

## 文件结构

在 `src/services/claudeCode/` 下创建以下结构：

```
src/services/claudeCode/
├── ClaudeCodeService.ts       # 现有，需要扩展
├── ClaudeTaskManager.ts       # 现有
├── ClaudeCodePlugin.ts        # 现有
├── ClaudeCodeInitializer.ts   # 现有
├── index.ts                   # 现有，需要更新导出
├── executors/                 # 新建目录
│   ├── index.ts
│   ├── GitCommitExecutor.ts
│   ├── GitPRExecutor.ts
│   ├── GitBranchExecutor.ts
│   ├── QualityCheckExecutor.ts
│   ├── ProjectInfoExecutor.ts
│   └── ReadFileExecutor.ts
└── types.ts                   # 新建，tool 相关类型定义
```

---

## 一、MCP Server API 扩展

### 需要在 MCPServer.ts 中添加新端点

在 `/src/services/mcpServer/MCPServer.ts` 中添加以下端点：

```
POST /api/tools/execute    - 执行 tool
GET  /api/tools/list       - 列出可用 tools
```

### 请求/响应类型定义

在 `/src/services/mcpServer/types.ts` 中添加：

```typescript
// Tool 执行请求
export interface ToolExecuteParams {
  tool: string;                    // tool 名称
  parameters: Record<string, unknown>;  // tool 参数
  taskId?: string;                 // 关联的任务 ID（可选）
}

// Tool 执行结果
export interface ToolExecuteResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

// Tool 定义（用于列表）
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  examples?: string[];
  whenToUse?: string;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
  enum?: string[];
  default?: unknown;
}
```

---

## 二、Tool Executor 实现

所有 executor 继承 `BaseTaskExecutor`，使用 `@TaskDefinition` 装饰器注册。

### 2.1 GitCommitExecutor - 规范化 Git 提交

**文件**: `src/services/claudeCode/executors/GitCommitExecutor.ts`

```typescript
@TaskDefinition({
  name: 'git_commit',
  description: '按照项目规范创建 Git 提交。自动格式化 commit message，添加 Co-Author。',
  executor: 'git_commit',
  parameters: {
    message: {
      type: 'string',
      required: true,
      description: '提交信息。格式: <type>: <description>。type 可选: feat/fix/docs/refactor/test/chore',
    },
    files: {
      type: 'array',
      required: false,
      description: '要提交的文件列表。不指定则提交所有已修改文件。',
    },
    scope: {
      type: 'string',
      required: false,
      description: '影响范围，如 (api)、(ui)。会添加到 type 后面。',
    },
    body: {
      type: 'string',
      required: false,
      description: '详细描述（commit body）。',
    },
    skipHooks: {
      type: 'boolean',
      required: false,
      description: '是否跳过 git hooks。默认 false。',
    },
  },
  examples: [
    'git_commit message="feat: add user authentication"',
    'git_commit message="fix: resolve memory leak" scope="api"',
    'git_commit message="refactor: simplify login flow" body="Reduced code complexity by 30%"',
  ],
  whenToUse: '当需要提交代码变更时使用。确保遵循项目的 commit 规范。',
})
```

**实现逻辑**:
1. 验证 message 格式是否符合 conventional commits
2. 如果指定 files，执行 `git add <files>`；否则执行 `git add -A`
3. 构建完整的 commit message（包含 scope、body）
4. 添加 `Co-Authored-By: Claude <noreply@anthropic.com>`
5. 执行 `git commit`
6. 返回 commit hash 和变更摘要

---

### 2.2 GitPRExecutor - 创建 Pull Request

**文件**: `src/services/claudeCode/executors/GitPRExecutor.ts`

```typescript
@TaskDefinition({
  name: 'git_create_pr',
  description: '创建 GitHub Pull Request。自动生成规范的 PR 标题和描述。',
  executor: 'git_create_pr',
  parameters: {
    title: {
      type: 'string',
      required: true,
      description: 'PR 标题。',
    },
    body: {
      type: 'string',
      required: false,
      description: 'PR 描述。不指定则根据 commits 自动生成。',
    },
    base: {
      type: 'string',
      required: false,
      description: '目标分支。默认 main 或 master。',
    },
    draft: {
      type: 'boolean',
      required: false,
      description: '是否创建为 draft PR。默认 false。',
    },
    labels: {
      type: 'array',
      required: false,
      description: 'PR 标签列表。',
    },
    reviewers: {
      type: 'array',
      required: false,
      description: '请求 review 的用户列表。',
    },
  },
  examples: [
    'git_create_pr title="feat: add user authentication"',
    'git_create_pr title="fix: memory leak" labels=["bug", "priority-high"]',
  ],
  whenToUse: '当代码完成并通过测试，需要创建 PR 合并到主分支时使用。',
})
```

**实现逻辑**:
1. 检查当前分支是否有未推送的 commits
2. 如果有，先执行 `git push -u origin <branch>`
3. 使用 `gh pr create` 创建 PR
4. 自动生成 PR body（包含 Summary、Changes、Test Plan）
5. 添加 labels 和 reviewers
6. 返回 PR URL

---

### 2.3 GitBranchExecutor - 分支管理

**文件**: `src/services/claudeCode/executors/GitBranchExecutor.ts`

```typescript
@TaskDefinition({
  name: 'git_branch',
  description: 'Git 分支管理。创建、切换、列出或删除分支。',
  executor: 'git_branch',
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: '操作类型: create/switch/list/delete/merge',
      enum: ['create', 'switch', 'list', 'delete', 'merge'],
    },
    name: {
      type: 'string',
      required: false,
      description: '分支名称。create/switch/delete/merge 时必填。',
    },
    from: {
      type: 'string',
      required: false,
      description: '基于哪个分支创建。仅 create 时有效。默认当前分支。',
    },
    force: {
      type: 'boolean',
      required: false,
      description: '是否强制操作。用于 delete 未合并的分支。',
    },
  },
  examples: [
    'git_branch action="create" name="feat/user-auth"',
    'git_branch action="switch" name="main"',
    'git_branch action="list"',
    'git_branch action="merge" name="feat/user-auth"',
  ],
  whenToUse: '当需要创建新功能分支、切换分支或合并分支时使用。',
})
```

**实现逻辑**:
- `create`: 执行 `git checkout -b <name> [from]`
- `switch`: 执行 `git checkout <name>`
- `list`: 执行 `git branch -a` 返回格式化列表
- `delete`: 执行 `git branch -d <name>` 或 `-D`（force）
- `merge`: 执行 `git merge <name>`，处理冲突提示

---

### 2.4 QualityCheckExecutor - 代码质量检查

**文件**: `src/services/claudeCode/executors/QualityCheckExecutor.ts`

```typescript
@TaskDefinition({
  name: 'quality_check',
  description: '运行代码质量检查。包括类型检查、lint、测试。',
  executor: 'quality_check',
  parameters: {
    checks: {
      type: 'array',
      required: false,
      description: '要执行的检查类型: typecheck/lint/test/build/all。默认 all。',
      enum: ['typecheck', 'lint', 'test', 'build', 'all'],
    },
    fix: {
      type: 'boolean',
      required: false,
      description: '是否自动修复可修复的问题（仅 lint）。默认 false。',
    },
    files: {
      type: 'array',
      required: false,
      description: '指定要检查的文件。不指定则检查全部。',
    },
    testPattern: {
      type: 'string',
      required: false,
      description: '测试文件匹配模式。仅 test 时有效。',
    },
  },
  examples: [
    'quality_check checks=["typecheck", "lint"]',
    'quality_check checks=["lint"] fix=true',
    'quality_check checks=["test"] testPattern="auth"',
    'quality_check checks=["all"]',
  ],
  whenToUse: '在提交代码前或 PR 创建前，确保代码质量符合项目标准。',
})
```

**实现逻辑**:
1. 根据 checks 参数依次执行：
   - `typecheck`: `bun run typecheck`
   - `lint`: `bun run lint` 或 `bun run lint:fix`
   - `test`: `bun test [pattern]`
   - `build`: `bun run build`
2. 收集每个检查的输出和状态
3. 返回汇总结果，包含成功/失败项目和详细错误

---

### 2.5 ProjectInfoExecutor - 项目信息查询

**文件**: `src/services/claudeCode/executors/ProjectInfoExecutor.ts`

```typescript
@TaskDefinition({
  name: 'project_info',
  description: '获取项目结构和信息。用于了解项目布局、依赖和最近变更。',
  executor: 'project_info',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '查询类型: structure/dependencies/recent-changes/git-status/git-log',
      enum: ['structure', 'dependencies', 'recent-changes', 'git-status', 'git-log'],
    },
    path: {
      type: 'string',
      required: false,
      description: '指定路径。structure 时用于限定目录。',
    },
    depth: {
      type: 'number',
      required: false,
      description: '目录深度。structure 时有效。默认 3。',
    },
    limit: {
      type: 'number',
      required: false,
      description: '结果数量限制。recent-changes/git-log 时有效。默认 10。',
    },
  },
  examples: [
    'project_info query="structure" path="src/services"',
    'project_info query="dependencies"',
    'project_info query="git-status"',
    'project_info query="git-log" limit=5',
  ],
  whenToUse: '当需要了解项目结构、查看依赖或检查最近变更时使用。',
})
```

**实现逻辑**:
- `structure`: 使用 `find` 或 `tree` 生成目录结构
- `dependencies`: 读取 `package.json` 的 dependencies/devDependencies
- `recent-changes`: 执行 `git diff --stat HEAD~<limit>`
- `git-status`: 执行 `git status --porcelain`
- `git-log`: 执行 `git log --oneline -<limit>`

---

### 2.6 ReadFileExecutor - 读取文件

**文件**: `src/services/claudeCode/executors/ReadFileExecutor.ts`

```typescript
@TaskDefinition({
  name: 'read_file',
  description: '读取项目中的文件内容。支持指定行范围。',
  executor: 'read_file',
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: '文件路径（相对于项目根目录）。',
    },
    startLine: {
      type: 'number',
      required: false,
      description: '起始行号（1-indexed）。不指定则从头开始。',
    },
    endLine: {
      type: 'number',
      required: false,
      description: '结束行号。不指定则读到末尾。',
    },
    encoding: {
      type: 'string',
      required: false,
      description: '文件编码。默认 utf-8。',
    },
  },
  examples: [
    'read_file path="src/index.ts"',
    'read_file path="package.json"',
    'read_file path="src/services/claudeCode/ClaudeCodeService.ts" startLine=1 endLine=50',
  ],
  whenToUse: '当需要查看文件内容、了解实现细节或参考现有代码时使用。',
})
```

**实现逻辑**:
1. 验证文件路径安全性（不能读取项目外的文件）
2. 使用 `Bun.file()` 读取文件
3. 如果指定行范围，截取相应行
4. 返回文件内容和元信息（行数、大小）

---

## 三、ClaudeCodeService 扩展

### 3.1 添加 Tool Registry

在 `ClaudeCodeService.ts` 中添加 tool 管理：

```typescript
// 新增导入
import { ToolRegistry } from './ToolRegistry';
import type { ToolExecuteParams, ToolExecuteResult, ToolDefinition } from '../mcpServer/types';

// 在 constructor 中
this.toolRegistry = new ToolRegistry(config.workingDirectory);

// 新增方法
async executeTool(params: ToolExecuteParams): Promise<ToolExecuteResult> {
  return this.toolRegistry.execute(params);
}

listTools(): ToolDefinition[] {
  return this.toolRegistry.list();
}
```

### 3.2 创建 ToolRegistry

**文件**: `src/services/claudeCode/ToolRegistry.ts`

```typescript
/**
 * ToolRegistry - 管理和执行 Claude Code tools
 */
export class ToolRegistry {
  private tools: Map<string, ToolExecutor>;
  private workingDirectory: string;

  constructor(workingDirectory?: string) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.tools = new Map();
    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    // 注册所有内置 tools
    this.register(new GitCommitExecutor(this.workingDirectory));
    this.register(new GitPRExecutor(this.workingDirectory));
    this.register(new GitBranchExecutor(this.workingDirectory));
    this.register(new QualityCheckExecutor(this.workingDirectory));
    this.register(new ProjectInfoExecutor(this.workingDirectory));
    this.register(new ReadFileExecutor(this.workingDirectory));
  }

  register(executor: ToolExecutor): void {
    this.tools.set(executor.name, executor);
  }

  async execute(params: ToolExecuteParams): Promise<ToolExecuteResult> {
    const executor = this.tools.get(params.tool);
    if (!executor) {
      return { success: false, error: `Unknown tool: ${params.tool}` };
    }
    return executor.execute(params.parameters);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }
}
```

---

## 四、MCPServer API 扩展实现

在 `MCPServer.ts` 的 `handleRequest` 方法中添加：

```typescript
// POST /api/tools/execute - Execute a tool
if (url.pathname === '/api/tools/execute' && req.method === 'POST') {
  const body = (await req.json()) as ToolExecuteParams;

  if (!body.tool) {
    return this.jsonResponse(
      { error: 'Missing required field: tool' },
      400,
      corsHeaders,
    );
  }

  if (this.onExecuteTool) {
    const result = await this.onExecuteTool(body);
    return this.jsonResponse(result, result.success ? 200 : 400, corsHeaders);
  }
  return this.jsonResponse({ error: 'No tool executor registered' }, 500, corsHeaders);
}

// GET /api/tools/list - List available tools
if (url.pathname === '/api/tools/list' && req.method === 'GET') {
  if (this.onListTools) {
    const tools = this.onListTools();
    return this.jsonResponse({ tools }, 200, corsHeaders);
  }
  return this.jsonResponse({ error: 'No tool registry registered' }, 500, corsHeaders);
}
```

添加对应的 handler 设置方法：

```typescript
private onExecuteTool: ((params: ToolExecuteParams) => Promise<ToolExecuteResult>) | null = null;
private onListTools: (() => ToolDefinition[]) | null = null;

setExecuteToolHandler(handler: (params: ToolExecuteParams) => Promise<ToolExecuteResult>): void {
  this.onExecuteTool = handler;
}

setListToolsHandler(handler: () => ToolDefinition[]): void {
  this.onListTools = handler;
}
```

---

## 五、Prompt Template 更新

更新 `prompts/claude-code.task` 模板，告知 Claude Code 可用的 tools：

```markdown
# Claude Code Task

## Task ID
{{taskId}}

## User Request
{{userPrompt}}

## Working Directory
{{workingDirectory}}

## Available Tools

You have access to the following tools via the MCP API at {{mcpApiUrl}}:

### Git Operations
- `git_commit`: Create a commit following project conventions
- `git_create_pr`: Create a GitHub Pull Request
- `git_branch`: Manage branches (create/switch/list/delete/merge)

### Quality Checks
- `quality_check`: Run typecheck, lint, test, build

### Project Information
- `project_info`: Get project structure, dependencies, git status
- `read_file`: Read file contents

### Communication
- Use POST {{mcpApiUrl}}/api/send to send messages
- Use POST {{mcpApiUrl}}/api/notify to update task status

## How to Use Tools

To execute a tool, make a POST request to:
```
POST {{mcpApiUrl}}/api/tools/execute
Content-Type: application/json

{
  "tool": "tool_name",
  "parameters": { ... },
  "taskId": "{{taskId}}"
}
```

## Project Conventions

### Commit Message Format
- Format: `<type>(<scope>): <description>`
- Types: feat, fix, docs, refactor, test, chore
- Example: `feat(auth): add user login API`

### Before Creating PR
1. Run `quality_check checks=["all"]` to ensure code quality
2. Make sure all tests pass
3. Use descriptive PR title and body

## Your Task
Please complete the following request:

{{userPrompt}}

Remember to:
1. Update task progress via /api/notify
2. Follow project conventions
3. Run quality checks before committing
4. Report any blockers or questions
```

---

## 六、实现顺序

### Phase 1: 基础设施
1. 创建 `src/services/claudeCode/types.ts`
2. 创建 `src/services/claudeCode/ToolRegistry.ts`
3. 更新 `src/services/mcpServer/types.ts` 添加 tool 类型
4. 更新 `src/services/mcpServer/MCPServer.ts` 添加 tool 端点

### Phase 2: 核心 Tools
5. 实现 `ReadFileExecutor.ts`（基础能力）
6. 实现 `ProjectInfoExecutor.ts`（项目感知）
7. 实现 `GitCommitExecutor.ts`（核心工作流）

### Phase 3: 完整工作流
8. 实现 `QualityCheckExecutor.ts`
9. 实现 `GitBranchExecutor.ts`
10. 实现 `GitPRExecutor.ts`

### Phase 4: 集成
11. 更新 `ClaudeCodeService.ts` 集成 ToolRegistry
12. 更新 `ClaudeCodeInitializer.ts`
13. 更新 prompt template
14. 测试完整工作流

---

## 七、测试计划

### 单元测试
- 每个 executor 的参数验证
- 命令执行逻辑
- 错误处理

### 集成测试
```bash
# 测试 tool 列表
curl http://localhost:9900/api/tools/list

# 测试读取文件
curl -X POST http://localhost:9900/api/tools/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "read_file", "parameters": {"path": "package.json"}}'

# 测试 git 状态
curl -X POST http://localhost:9900/api/tools/execute \
  -H "Content-Type: application/json" \
  -d '{"tool": "project_info", "parameters": {"query": "git-status"}}'
```

### E2E 测试
1. 通过 bot 命令触发 Claude Code 任务
2. 验证 Claude Code 能正确调用 tools
3. 验证提交、PR 创建流程

---

## 八、安全考虑

1. **路径安全**: ReadFileExecutor 必须限制只能读取项目内文件
2. **命令注入**: 所有传递给 shell 的参数必须进行转义
3. **权限控制**: 继承 ClaudeCodeService 的用户权限检查
4. **日志脱敏**: 不要在日志中输出敏感信息（如 token）

---

## 九、配置扩展

在 `config.jsonc` 中可选添加：

```jsonc
{
  "claudeCodeService": {
    "enabled": true,
    "port": 9900,
    "workingDirectory": "/path/to/project",
    "allowedUsers": ["12345"],
    "tools": {
      "git": {
        "commitConvention": "conventional",  // conventional | angular | custom
        "coAuthor": "Claude <noreply@anthropic.com>",
        "autoStage": true
      },
      "quality": {
        "typecheck": "bun run typecheck",
        "lint": "bun run lint",
        "test": "bun test",
        "build": "bun run build"
      }
    }
  }
}
```

---

## 十、参考实现

参考 `src/services/wechat/executors/` 下的 executor 实现模式：
- 使用 `@TaskDefinition` 装饰器
- 继承 `BaseTaskExecutor`
- 使用 `this.success()` / `this.error()` 返回结果
- 使用 `tsyringe` 进行依赖注入

---

## 完成标准

- [ ] 所有 6 个 executor 实现完成
- [ ] MCPServer API 扩展完成
- [ ] ToolRegistry 实现完成
- [ ] ClaudeCodeService 集成完成
- [ ] Prompt template 更新完成
- [ ] 类型检查通过 (`bun run typecheck`)
- [ ] Lint 检查通过 (`bun run lint`)
- [ ] 基本功能测试通过
