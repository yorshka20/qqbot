# Claude Code Task

你正在为 QQBot 项目执行一个开发任务。

## 工作流程

**重要**: 在开始任务前，你必须先阅读工作流程指南：

```
请先阅读: template/WORKFLOW.md
```

这份文档定义了标准的工作流程：**RECEIVE → ANALYZE → PLAN → EXECUTE → VERIFY**

你需要严格按照 WORKFLOW.md 中定义的流程执行任务，包括：
- 每个阶段的具体动作
- 输出格式要求
- 检查点验证

## 项目上下文

- **项目路径**: {{workingDirectory}}
- **任务ID**: {{taskId}}

### 必读文档
1. `CLAUDE.md` - 项目开发规范
2. `template/LEARNINGS.md` - 项目知识库（架构、代码模式、已知陷阱）

> **重要**: LEARNINGS.md 包含了之前任务中积累的项目知识，可以帮助你避免重复踩坑。

## 你的任务

{{userPrompt}}

## 任务执行要求

### 1. 遵循 WORKFLOW 流程

按照 `template/WORKFLOW.md` 定义的 5 个阶段执行：

1. **RECEIVE** - 确认工作目录，阅读相关文档
2. **ANALYZE** - 探索代码，理解现有实现
3. **PLAN** - 拆分子任务，定义执行顺序
4. **EXECUTE** - 逐个完成子任务，每完成一个进行验证
5. **VERIFY** - 运行完整检查，输出完成报告

### 2. 质量检查

在提交代码前必须通过：
```bash
bun run typecheck
bun run lint
```

### 3. Git 规范

Commit message 格式：
```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

### 4. 进度通知（可选）

如需通知 Bot 进度，可使用 MCP API：

```bash
# 任务进度
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"progress","progress":50,"message":"完成了 PLAN 阶段"}'

# 发送消息
curl -X POST {{mcpApiUrl}}/api/send \
  -H "Content-Type: application/json" \
  -d '{"target":{"type":"{{targetType}}","id":"{{targetId}}"},"content":"消息内容"}'
```

## 可用 Tools

你可以通过 MCP API 调用以下 tools 来辅助完成工作流：

### 调用方式

```bash
POST {{mcpApiUrl}}/api/tools/execute
Content-Type: application/json

{
  "tool": "tool_name",
  "parameters": { ... },
  "taskId": "{{taskId}}"
}
```

查看所有可用 tools：
```bash
GET {{mcpApiUrl}}/api/tools/list
```

### Git 操作

**`git_commit`** - 按照项目规范创建 Git 提交
```json
{
  "tool": "git_commit",
  "parameters": {
    "message": "feat: add user authentication",
    "scope": "auth",
    "body": "可选的详细描述",
    "files": ["src/auth.ts"],
    "skipHooks": false
  }
}
```

**`git_branch`** - 分支管理（create/switch/list/delete/merge）
```json
{
  "tool": "git_branch",
  "parameters": {
    "action": "create",
    "name": "feat/user-auth",
    "from": "main"
  }
}
```

**`git_create_pr`** - 创建 GitHub Pull Request
```json
{
  "tool": "git_create_pr",
  "parameters": {
    "title": "feat: add user authentication",
    "body": "可选描述",
    "base": "main",
    "draft": false
  }
}
```

### 质量检查

**`quality_check`** - 运行类型检查、lint、测试、构建
```json
{
  "tool": "quality_check",
  "parameters": {
    "checks": ["typecheck", "lint"],
    "fix": false
  }
}
```

### 项目信息

**`project_info`** - 获取项目结构、依赖、git 状态
```json
{
  "tool": "project_info",
  "parameters": {
    "query": "git-status"
  }
}
```

查询类型：`structure` / `dependencies` / `recent-changes` / `git-status` / `git-log`

**`read_file`** - 读取文件内容
```json
{
  "tool": "read_file",
  "parameters": {
    "path": "src/index.ts",
    "startLine": 1,
    "endLine": 50
  }
}
```

## 开始执行

现在，请：
1. 阅读 `template/WORKFLOW.md` - 了解标准工作流程
2. 阅读 `CLAUDE.md` - 了解项目规范
3. 阅读 `template/LEARNINGS.md` - 了解项目架构和已知陷阱
4. 按照 WORKFLOW 流程开始执行任务

> **完成后**: 记得将本次任务中学到的知识更新到 `template/LEARNINGS.md`
