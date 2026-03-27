# Task

{{userPrompt}}

---

**项目路径**: `{{workingDirectory}}`　|　**项目类型**: {{projectType}}　|　**任务ID**: {{taskId}}

{{projectDescription}}

## 执行流程

### Step 0: 复述任务

在做任何事之前，用 2-3 句话复述你对上述任务的理解：目标是什么、交付物是什么、有哪些约束。如果任务描述有歧义，列出你的假设。

### Step 1: RECEIVE — 接收与准备

1. 确认工作目录并同步远端：

   ```bash
   pwd && git status && git pull
   ```

2. 阅读项目文档：
   {{#if hasClaudeMd}}
   - `CLAUDE.md` — 项目开发规范（必读）
     {{else}}
   - 该项目没有 CLAUDE.md，根据 README 和现有代码风格理解约定
     {{/if}}
   - `.claude-learnings/` — 架构知识库（如存在，必读。**本地文件，已 gitignore**）
   - `.claude-workbook/` — 工作日志目录（按需查阅。**本地文件，已 gitignore**）
   - `README.md` — 项目说明

3. 检查 `.claude-learnings/`和 `.claude-workbook/`中是否有与当前任务相关的历史记录

### Step 2: ANALYZE — 分析理解

- 探索相关代码，理解现有实现和依赖关系
- 找到类似功能的参考实现
- 识别风险点

### Step 3: PLAN — 规划拆分

- 将任务拆分为可独立完成和验证的子任务
- 确定执行顺序（基础设施优先、核心功能次之）
- 定义每个子任务的验收标准

### Step 4: EXECUTE — 逐步实现

对每个子任务：实现 → 验证 → 确认完成。

代码原则：遵循项目现有风格、最小改动不做无关重构、添加必要的错误处理。

### Step 5: VERIFY — 验收交付

1. **质量检查**（提交前必须通过）：

   ```bash
   {{qualityCheckCommands}}
   ```

2. **回顾实现** — 检查所有修改，确认无遗漏

3. **更新文档** — 详见下方"知识库与工作日志维护"

4. **提交并推送**：

   ```bash
   git add <files>  # 不要 add .claude-learnings.md 和 .claude-workbook/
   git commit -m "type(scope): description

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```

   Type: `feat` / `fix` / `refactor` / `docs` / `test` / `chore`

---

## 知识库与工作日志维护

两者独立，均须维护。

### 架构知识 → `.claude-learnings.md`

仅记录**可复用的架构细节和经验教训**，不记录具体任务日志：

- 新的架构知识 → 更新"架构概览"
- 可复用的代码模式 → 更新"代码模式"
- 踩坑经验 → 提炼通用教训添加到"常见陷阱"（详细排查过程放工作日志）
- 待改进项 → 添加到"待改进项"
- 维护"工作汇报索引"表，添加当日条目

如果文件不存在，按以下结构创建：

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

### 工作日志 → `.claude-workbook/YYYY-MM-DD.md`

记录本次任务的**具体问题排查和解决过程**：任务描述、实现方案、涉及文件、遇到的问题和解决方式。当日文件已存在则在末尾追加（用 `---` 分隔），不存在则创建，标题为 `# Claude Code 工作日志 - YYYY-MM-DD`。

---

## 参考信息（按需查阅）

<details>
<summary>进度通知 API</summary>

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

</details>
