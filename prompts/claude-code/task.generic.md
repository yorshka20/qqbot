# Claude Code Task

## 项目上下文

- **项目路径**: {{workingDirectory}}
- **项目描述**: {{projectDescription}}
- **项目类型**: {{projectType}}
- **任务ID**: {{taskId}}

## 你的任务

{{userPrompt}}

---

## 工作流程

按照以下 5 个阶段执行：**RECEIVE → ANALYZE → PLAN → EXECUTE → VERIFY**

### Phase 1: RECEIVE - 接收任务

1. **确认工作目录并同步远端**

   ```bash
   pwd
   git status
   git pull
   ```

2. **阅读项目文档**

{{#if hasClaudeMd}}
   - `CLAUDE.md` — 项目开发规范（必读）
{{else}}
   - 该项目没有 CLAUDE.md，请根据 README 和现有代码风格理解约定
{{/if}}
   - `.claude-learnings.md` — 项目知识库（如果存在，必读。包含架构概览、代码模式、已知陷阱）。**本地文件，已 gitignore，不要提交到 git**
   - `.claude-workbook/` — Claude Code 工作日志目录（按需查阅，通过 learnings 中的工作汇报索引定位相关记录）。**本地文件，已 gitignore，不要提交到 git**
   - `README.md` — 项目说明

   > **重要**: `.claude-learnings.md` 中包含工作汇报索引。开始任务前，检查索引中是否有与当前任务相关的历史记录，快速了解上下文。

3. **确认任务范围** — 明确需要做什么和不做什么

### Phase 2: ANALYZE - 分析理解

1. 探索相关代码，理解现有实现和依赖关系
2. 找到类似功能的参考实现
3. 识别风险点

### Phase 3: PLAN - 规划拆分

1. 将任务拆分为可独立完成和验证的子任务
2. 确定执行顺序（基础设施优先、核心功能次之）
3. 定义每个子任务的验收标准

### Phase 4: EXECUTE - 逐步实现

对每个子任务：实现 → 验证 → 确认完成。

**代码原则**:
- 遵循项目现有代码风格
- 最小改动，不做无关重构
- 添加必要的错误处理

### Phase 5: VERIFY - 验收交付

1. **运行完整质量检查**

   ```bash
   {{qualityCheckCommands}}
   ```

2. **回顾实现** — 检查所有修改，确认无遗漏

3. **更新知识库和工作日志**（两者独立，均须维护）

   #### 架构知识 → `.claude-learnings.md`

   仅记录**可复用的架构细节和经验教训**，不记录具体任务日志：

   - 如果发现了新的架构知识，更新"架构概览"
   - 如果使用了可复用的代码模式，更新"代码模式"
   - 如果踩了坑并解决了，提炼为通用经验添加到"常见陷阱"（详细排查过程放工作日志）
   - 如果发现待改进项，添加到"待改进项"
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

   #### 工作日志 → `.claude-workbook/YYYY-MM-DD.md`

   记录本次任务的**具体问题排查和解决过程**：
   - 任务描述、实现方案、涉及文件、遇到的问题和解决方式
   - 如当日文件已存在，在末尾追加新条目（用 `---` 分隔）
   - 如当日文件不存在，创建新文件，标题为 `# Claude Code 工作日志 - YYYY-MM-DD`

4. **提交并推送**

   ```bash
   git status  # 检查所有改动（包括文档）
   git add <files>  # 注意：不要 add .claude-learnings.md 和 .claude-workbook/，它们是本地文件
   git commit -m "type(scope): description"
   git push
   ```

---

## Git 规范

Commit message 格式：

```
<type>(<scope>): <description>

[optional body]

Co-Authored-By: Claude <noreply@anthropic.com>
```

Type: `feat` / `fix` / `refactor` / `docs` / `test` / `chore`

## 进度通知（可选）

如需通知 Bot 进度，可使用 MCP API：

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

## 可用 Tools

你可以通过 MCP API 调用 tools 来辅助完成工作：

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

## 开始执行

现在，请按照 RECEIVE → ANALYZE → PLAN → EXECUTE → VERIFY 流程开始工作。
