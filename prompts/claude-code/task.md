# Task

{{userPrompt}}

---

# Execution Protocol

**项目路径**: `{{workingDirectory}}` | **任务ID**: `{{taskId}}`

## Step 0: Restate — 复述任务

在做任何事之前，用 2-3 句话复述你对上述 Task 的理解：目标是什么、交付物是什么、有哪些约束。如果任务描述有歧义，列出你的假设。确认理解准确后再继续。

## Step 1: Read — 阅读项目规范与知识库

按顺序阅读：

1. `CLAUDE.md` — 开发规范与约定
2. `.claude-learnings/index.md` — 架构知识索引，按需阅读相关 scope 文件
3. `.claude-workbook/index.md` — 工作日志索引，按需阅读与当前任务相关的日期报告

## Step 2: Analyze & Plan — 分析与计划

- 探索相关代码，理解现有实现
- 拆分子任务，定义执行顺序
- 识别风险点和依赖关系

## Step 3: Execute — 执行

- 逐个完成子任务，每完成一个进行局部验证
- 遇到与计划不符的情况，先停下来重新评估再继续

## Step 4: Verify & Commit — 验证与提交

**勿**将 `.claude-workbook/`、`.claude-learnings/` 加入提交（已 gitignore，仅本机）。

提交前必须通过质量检查：

```bash
bun run typecheck
bun run lint:fix
```

Commit message 格式：

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Step 5: Wrap Up — 收尾

- 将新发现的架构知识、代码模式、踩坑经验写入 `.claude-learnings/` 对应 scope 文件（或新建 scope），然后更新 `index.md` 索引（本机，不提交）
- 工作日志输出到 `.claude-workbook/YYYY-MM-DD.md`，然后更新 `index.md` 索引（本机，不提交）
- 将修复内容总结一下，返回给用户

---

# Reference

The bot exposes two MCP tools on the `qqbot` server for talking back to the
person who asked for this work. Everything else — reading, editing, git,
running checks — use your own built-in tools.

- `bot_notify_task` — report task lifecycle (`started` / `progress` /
  `completed` / `failed`). The task ID comes from the connection.
- `bot_send_message` — message the requester mid-task
  (`targetType={{targetType}}`, `targetId={{targetId}}`).
