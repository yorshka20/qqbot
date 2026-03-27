# Task — 创建新项目

{{userPrompt}}

---

**目标路径**: `{{workingDirectory}}`　|　**项目类型**: {{projectType}}　|　**任务ID**: {{taskId}}

## Step 0: 复述任务

用 2-3 句话复述你对上述需求的理解：要创建什么项目、核心功能是什么、技术选型有哪些约束。如果需求描述有歧义，列出你的假设。

## Step 1: 初始化项目

1. 创建项目目录（如果不存在）
2. 初始化项目骨架（package.json / Cargo.toml / pyproject.toml 等）
3. 设置 `.gitignore`，确保包含 `.claude-learnings.md` 和 `.claude-workbook/*`
4. 安装必要依赖

## Step 2: 实现功能

根据需求描述实现核心功能。遵循所选技术栈的惯例和最佳实践。

## Step 3: 补全文档与知识库

1. **`README.md`** — 项目说明、使用方式、开发指南

2. **`.claude-learnings.md`** — 架构知识库（**本地文件，不提交 git**）：

   ```markdown
   # Project Learnings

   本文档记录项目的架构知识和代码模式，供后续 Claude Code 任务参考。

   ## 工作汇报索引

   | 日期 | 主要内容 |
   | ---- | -------- |

   ## 架构概览

   ## 代码模式

   ## 常见陷阱

   ## 待改进项
   ```

3. **`.claude-workbook/YYYY-MM-DD.md`** — 首日工作日志（**本地文件，不提交 git**）：

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
