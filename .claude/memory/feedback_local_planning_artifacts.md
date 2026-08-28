---
name: Planning artifacts stay local (gitignored), only code + tracked docs reach the repo
description: qqbot project — workbook / learnings / roadmap / design docs are本机笔记, never git add
type: feedback
originSessionId: 4b19e2c0-8568-4314-a019-c7c45a8d473e
---
qqbot 仓库的"规划与笔记"全部本机化、不入 git。已 ignore 的位置：

- `.claude-workbook/` — 按日期日报
- `.claude-learnings/` — scope 内知识 + 头部 ROADMAP 表（scope 内 SoT）
- `docs/local/` — 本机设计文档（如 `mind-system-design.md`）
- `/ROADMAP.md` — **仓库根**的跨 scope 索引仪表盘（用户明确选择放根目录而非 docs/local/，便于第一眼看到；走 .gitignore 单条目 `/ROADMAP.md` 排除）

**Why**：用户明确把 roadmap / planning / 决策日志 等"过程产物"和"代码 + 跟踪文档"分开。提交与协作以仓库内已跟踪的代码与文档（`CLAUDE.md` / `README.md` / `prompts/` / `packages/**` 等）为准。规划面常变、决策性强、含 session 上下文，跟踪进 git 会污染历史和让别人困惑。

**How to apply**：
1. 新建任何"规划 / 索引 / TODO 仪表盘 / 决策日志 / 设计文档"类文件，**默认放进已 ignore 的位置**（按用途选）：
   - 跨 scope active 索引 → `/ROADMAP.md`（根目录单条 ignore）
   - 单 scope 知识 + roadmap 表 → `.claude-learnings/<scope>.md`
   - 按日期日报 → `.claude-workbook/YYYY-MM-DD.md`
   - 设计文档 / 长文 → `docs/local/`
2. 不要主动把这类文件 `git add`；提交前用 `git status` 确认它们在 ignore 区
3. 如果用户问"放哪儿"，先确认是否属于规划面 —— 是 → 上述 4 个位置之一；否 → 才考虑跟踪进 git
4. CLAUDE.md 里关于 workbook / learnings 的 SOP（"开始工作时读、完成后更新"）继续执行
5. **代码注释里也不要塞 session 上下文 / 当前任务背景**（CLAUDE.md "注释风格" 段已规定）—— 那些信息属于 commit message / PR 描述 / `docs/local/` / `.claude-workbook/`
