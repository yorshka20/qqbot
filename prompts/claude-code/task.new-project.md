# Claude Code Task — 创建新项目

## 任务

在 `{{workingDirectory}}` 创建一个新项目。

**项目类型**: {{projectType}}
**需求描述**: {{userPrompt}}

**任务ID**: {{taskId}}

## 执行步骤

1. 创建项目目录（如果不存在）
2. 初始化项目骨架（package.json / Cargo.toml / pyproject.toml 等）
3. 安装必要依赖
4. 实现需求描述中的功能
5. 添加 `README.md`
6. 创建 `.claude-learnings.md` — 记录项目架构概览和关键设计决策（**本地文件，加入 .gitignore，不提交到 git**）
7. 创建 `.claude-workbook/` 目录和首日工作日志（**本地文件，加入 .gitignore，不提交到 git**）
8. 在 `.gitignore` 中添加 `.claude-learnings.md` 和 `.claude-workbook/*`
9. 初始化 git 仓库并做首次提交

### `.claude-learnings.md` 模板

```markdown
# Project Learnings

本文档记录项目的架构知识和代码模式，供后续 Claude Code 任务参考。

## 工作汇报索引

| 日期 | 主要内容 |
| ---- | -------- |

## 架构概览

（描述模块关系、关键组件）

## 代码模式

（记录项目中常用的模式和约定）

## 常见陷阱

（容易出错的地方和解决方案）

## 待改进项

（发现但未处理的问题）
```

### `.claude-workbook/YYYY-MM-DD.md` 模板

```markdown
# Claude Code 工作日志 - YYYY-MM-DD

## 项目初始化

- **任务**: 创建新项目
- **实现**: （描述项目结构和技术选型）
- **涉及文件**: （列出关键文件）
```

## Git 规范

Commit message 格式：

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

## 进度通知（可选）

```bash
# 任务进度
curl -X POST {{mcpApiUrl}}/api/notify \
  -H "Content-Type: application/json" \
  -d '{"taskId":"{{taskId}}","status":"progress","progress":50,"message":"进度描述"}'

# 发送消息
curl -X POST {{mcpApiUrl}}/api/send \
  -H "Content-Type: application/json" \
  -d '{"target":{"type":"{{targetType}}","id":"{{targetId}}"},"content":"消息内容"}'
```

## 开始执行

现在，请按照上述步骤创建项目并实现需求。
