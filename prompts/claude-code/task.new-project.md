# Task — 创建新项目

{{userPrompt}}

---

**目标路径**: `{{workingDirectory}}`　|　**项目类型**: {{projectType}}　|　**任务ID**: {{taskId}}

## Step 0: 复述任务

用 2-3 句话复述你对上述需求的理解：要创建什么项目、核心功能是什么、技术选型有哪些约束。如果需求描述有歧义，列出你的假设。

## Step 1: 初始化项目

1. 创建项目目录（如果不存在）
2. 初始化项目骨架（package.json / Cargo.toml / pyproject.toml 等）
3. 设置 `.gitignore`，确保包含 `.claude-learnings/` 和 `.claude-workbook/`
4. 安装必要依赖

## Step 2: 实现功能

根据需求描述实现核心功能。遵循所选技术栈的惯例和最佳实践。

## Step 3: 补全文档与知识库

1. **`README.md`** — 项目说明、使用方式、开发指南

2. **`.claude-learnings/`** — 架构知识目录（**本地文件，不提交 git**）：

   创建 `index.md`：

   ```markdown
   # Project Learnings Index

   本目录按 scope 记录项目的关键细节和设计要点。阅读时先看此索引，按需阅读具体 scope 文件。

   ## Scope 索引

   | Scope | 文件 | 主要内容 |
   |-------|------|----------|
   | Core | [core.md](core.md) | 项目架构概览、技术选型、核心模式 |
   ```

   创建首个 scope 文件（如 `core.md`），记录项目架构和技术选型决策。

3. **`.claude-workbook/`** — 工作日志目录（**本地文件，不提交 git**）：

   创建 `index.md`：

   ```markdown
   # Workbook Index

   本目录按日期记录每天的工作汇报。阅读时先看此索引，按需阅读具体日期的详细报告。

   ## 日报索引

   | 日期 | 文件 | 主要工作内容 |
   |------|------|-------------|
   | YYYY-MM-DD | [YYYY-MM-DD.md](YYYY-MM-DD.md) | 项目初始化 |
   ```

   创建首日工作日志 `YYYY-MM-DD.md`：

   ```markdown
   # Claude Code 工作日志 - YYYY-MM-DD

   ## 项目初始化

   - **任务**: 创建新项目
   - **实现**: （描述项目结构和技术选型）
   - **涉及文件**: （列出关键文件）
   ```

## Step 4: 提交

```bash
git init
git add -A
git commit -m "feat: init project

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

<details>
<summary>进度通知 API（可选）</summary>

```bash
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"progress","progress":50,"message":"进度描述"}'

curl -X POST {{mcpApiUrl}}/api/send \
  -H "Content-Type: application/json" \
  -d '{"target":{"type":"{{targetType}}","id":"{{targetId}}"},"content":"消息内容"}'
```

</details>
