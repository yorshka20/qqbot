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
   - `README.md` — 项目说明

3. 阅读知识库与工作日志（**本地文件，已 gitignore**）：
   - `.claude-learnings/index.md` — 架构知识索引（必读），按需阅读相关 scope 文件
   - `.claude-workbook/index.md` — 工作日志索引（必读），按需阅读相关日期报告
   - 如果目录不存在，在 Step 5 完成后创建（参见"知识库与工作日志维护"）

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
   git add <files>  # 不要 add .claude-learnings/ 和 .claude-workbook/
   git commit -m "type(scope): description

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```

   Type: `feat` / `fix` / `refactor` / `docs` / `test` / `chore`

5. **汇报修复内容** - 将修复内容总结一下，返回给用户

---

## 知识库与工作日志维护

两者独立，均须维护。两个目录均为本地文件（已 gitignore），不提交 git。

### 架构知识 → `.claude-learnings/`

按 scope 分文件记录**可复用的架构细节和经验教训**，不记录具体任务日志。

**目录结构**：

```
.claude-learnings/
├── index.md          # 所有 scope 的内容索引（必须维护）
├── rendering.md      # 示例 scope: 渲染相关
├── core.md           # 示例 scope: 核心工具函数
└── ...               # 按需新增 scope 文件
```

**更新规则**：
- 新的架构知识、可复用的代码模式、踩坑经验 → 写入对应 scope 文件（判断应写入已有 scope 还是新建 scope）
- 每次更新 scope 文件后，必须同步更新 `index.md` 索引
- 详细排查过程放工作日志，learnings 只保留提炼后的通用教训

**如果目录不存在**，创建 `index.md`：

```markdown
# Project Learnings Index

本目录按 scope 记录项目的关键细节和设计要点。阅读时先看此索引，按需阅读具体 scope 文件。

## Scope 索引

| Scope | 文件 | 主要内容 |
|-------|------|----------|
```

### 工作日志 → `.claude-workbook/`

按日期记录本次任务的**具体问题排查和解决过程**。

**目录结构**：

```
.claude-workbook/
├── index.md          # 所有日报的摘要索引（必须维护）
├── 2026-03-27.md     # 按日期记录
└── ...
```

**更新规则**：
- 当日文件（`YYYY-MM-DD.md`）已存在则在末尾追加（用 `---` 分隔），不存在则创建，标题为 `# Claude Code 工作日志 - YYYY-MM-DD`
- 记录：任务描述、实现方案、涉及文件、遇到的问题和解决方式
- 每次更新日报后，必须同步更新 `index.md` 索引

**如果目录不存在**，创建 `index.md`：

```markdown
# Workbook Index

本目录按日期记录每天的工作汇报。阅读时先看此索引，按需阅读具体日期的详细报告。

## 日报索引

| 日期 | 文件 | 主要工作内容 |
|------|------|-------------|
```

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
