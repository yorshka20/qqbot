# Task

{{userPrompt}}

---

# Execution Protocol

**项目路径**: `{{workingDirectory}}` | **任务ID**: `{{taskId}}`

## Step 0: Restate — 复述任务

在做任何事之前，用 2-3 句话复述你对上述 Task 的理解：目标是什么、交付物是什么、有哪些约束。如果任务描述有歧义，列出你的假设。确认理解准确后再继续。

## Step 1: Read — 阅读项目规范

按顺序阅读：

1. `CLAUDE.md` — 开发规范与约定
2. `template/LEARNINGS.md` — 架构知识库 & 工作日志索引
3. 检查索引中是否有与当前任务相关的历史记录，如有则查阅 `workbook/` 中对应日志

## Step 2: Analyze & Plan — 分析与计划

- 探索相关代码，理解现有实现
- 拆分子任务，定义执行顺序
- 识别风险点和依赖关系

## Step 3: Execute — 执行

- 逐个完成子任务，每完成一个进行局部验证
- 遇到与计划不符的情况，先停下来重新评估再继续

## Step 4: Verify & Commit — 验证与提交

提交前必须通过质量检查：

```bash
bun run typecheck
bun run lint
```

Commit message 格式：

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Step 5: Wrap Up — 收尾

- 架构知识更新到 `template/LEARNINGS.md`
- 工作日志输出到 `workbook/YYYY-MM-DD.md`
- 在 LEARNINGS.md 索引中添加条目

---

# Reference（按需查阅，不需预读）

<details>
<summary>进度通知 API</summary>

```bash
# 任务进度
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"progress","progress":50,"message":"完成了计划阶段"}'

# 发送消息
curl -X POST {{mcpApiUrl}}/api/send \
  -H "Content-Type: application/json" \
  -d '{"target":{"type":"{{targetType}}","id":"{{targetId}}"},"content":"消息内容"}'
```

</details>

<details>
<summary>MCP Tools 调用方式</summary>

```bash
# 查看所有可用 tools
GET {{mcpApiUrl}}/api/tools/list

# 调用 tool
POST {{mcpApiUrl}}/api/tools/execute
Content-Type: application/json
{
  "tool": "tool_name",
  "parameters": { ... },
  "taskId": "{{taskId}}"
}
```

**`git_commit`** — 创建 Git 提交

```json
{
  "tool": "git_commit",
  "parameters": {
    "message": "feat: add feature",
    "scope": "module",
    "body": "可选描述",
    "files": ["src/file.ts"],
    "skipHooks": false
  }
}
```

**`git_branch`** — 分支管理（create/switch/list/delete/merge）

```json
{
  "tool": "git_branch",
  "parameters": { "action": "create", "name": "feat/xxx", "from": "main" }
}
```

**`git_create_pr`** — 创建 GitHub PR

```json
{
  "tool": "git_create_pr",
  "parameters": {
    "title": "feat: xxx",
    "body": "可选描述",
    "base": "main",
    "draft": false
  }
}
```

**`quality_check`** — 运行 typecheck / lint / test / build

```json
{
  "tool": "quality_check",
  "parameters": { "checks": ["typecheck", "lint"], "fix": false }
}
```

**`project_info`** — 查询：`structure` / `dependencies` / `recent-changes` / `git-status` / `git-log`

```json
{ "tool": "project_info", "parameters": { "query": "git-status" } }
```

**`read_file`** — 读取文件

```json
{
  "tool": "read_file",
  "parameters": { "path": "src/index.ts", "startLine": 1, "endLine": 50 }
}
```

</details>
