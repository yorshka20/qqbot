---
# ── 必填字段（生成 ticket 时务必填写，缺失会导致 WebUI 显示 (untitled)）──
id: YYYY-MM-DD-<slug>           # 与 tickets/ 下目录名完全一致（kebab-case，ASCII）
title: <一句话标题>              # 展示在 WebUI 列表，必须是人类可读的中/英文标题，不能留空
status: draft                   # draft | ready | dispatched | done | abandoned
project: <项目名>                # 如 qqbot / video-knowledge-backend / video-knowledge-client
created: 2026-01-01T00:00:00.000Z   # ISO-8601；生成时填当前时间
updated: 2026-01-01T00:00:00.000Z   # ISO-8601；生成时与 created 相同
# ── 可选字段 ─────────────────────────────────────────────
# template: claude-planner       # 指定 worker 模板；不确定就不要写
# usePlanner: true               # 需要 planner 拆解时填 true；单纯 executor 任务留空
maxChildren: 3                   # planner 最多 spawn 几个子任务（默认 5）
estimatedComplexity: medium      # trivial | low | medium | high —— 影响 executor 选型
# 注意：priority / tag 等字段**不被解析**，不要写进来
---

## 目标
<!-- 一到两句话。完成后什么是"真"的？
     写成可验证的终态描述，而不是过程描述。
     ✅ "/api/users 接口返回基于游标的分页结果，默认每页 20 条"
     ❌ "给 users API 加上分页功能" -->

## 上下文

### 代码定位
<!-- 帮 planner（和 executor）快速找到相关代码。
     列出具体路径 — executor 只能看到你写在这里的信息。
     planner 会把这些路径转写进子任务的 task guide 里。 -->
- **仓库 / 分支**：
- **关键文件**：
  - `path/to/file.ts` —（一句话说明职责）
- **相关模块**：
- **技术栈备注**：（框架版本、构建工具、任何不显而易见的东西）

### 当前行为
<!-- 现在是什么表现？附上报错信息、日志或截图（如有）。 -->

### 期望行为
<!-- 应该是什么表现？具体到 executor 能据此写出测试用例的程度。 -->

### 为什么重要
<!-- 业务 / 用户层面的影响。当子任务冲突时帮 planner 做优先级判断。 -->

## 验收标准
<!-- 每条标准必须能被 executor 独立验证。
     尽量标注作用域提示，方便 planner 分配到对应子任务。
     写明具体的验证命令（如 bun run typecheck、bun test 等）。

     ⚠️ Go 项目注意：`go build ./...` **不编译 _test.go 文件**。
     扩展 interface 或改 struct 签名时，test 文件里的 stub 违反 interface
     不会在 `go build` 报错，但会在 `go vet` / `go test` 报错。
     Go 项目的验收**必须包含** `go vet ./...` 和 `go test ./...`（从 repo root），
     不能只跑 `go build ./...`。若本 ticket 涉及 interface 变更，
     单独加一条"更新所有实现该 interface 的 struct（含 _test.go 里的 stub）"。 -->
- [ ] （标准 — 验证方式：`bun run typecheck`、`bun test` 等）
- [ ] （标准 — 验证方式）

## 约束

### 禁止改动
<!-- 冻结的文件、模块或行为。务必写明 —
     executor 只知道这里写的内容，不会自己推断。 -->
-

### 子任务间依赖
<!-- 如果任务 B 必须等任务 A 的产出才能开始，在此说明。
     planner 会据此决定串行还是并行 spawn。
     如果所有工作可以并行，留空即可。 -->
-

### 非功能性要求
<!-- 性能预算、向后兼容、不得引入新依赖 等。 -->
-

## 交付与文档维护（必做）

<!-- 这一段是**所有 ticket 必须包含**的收尾动作。agent 完成代码后容易忘记这些，
     把它们作为 ticket 的一部分强制执行。跳过任何一项视为 ticket 未完成。 -->

- [ ] **Workbook 日报**：在 `.claude-workbook/YYYY-MM-DD.md` 追加新 session (`## SN: <topic>`)，格式：Problem / Solution / 涉及文件 / 验证。若当天文件不存在则新建
- [ ] **Workbook 索引**：在 `.claude-workbook/index.md` 对应日期行摘要末尾追加本次工作的一句话描述
- [ ] **Learnings**：把本次确立的设计决策 / interface 变更 / 新暴露的 API / 需要记住的坑 更新到 `.claude-learnings/<scope>.md`（按涉及模块选 scope；没有合适 scope 就新建）；同步更新 `.claude-learnings/index.md`
- [ ] **ROADMAP**：若本 ticket 对应 ROADMAP 的某条任务，状态改 ✅，链接从原 todo 文件改成本次 workbook 日报条目
- [ ] **模块 TODO**：若涉及 `internal/**/todo*.md` 等模块级 TODO 文件，勾选对应 `[x]` 或补充新发现的 `[ ]`
- [ ] **Git commit**：按项目惯例拆 commit（重构和新功能分开；前后端分开），commit message 结尾带 `Co-Authored-By:` trailer（参考最近的 git log）
- [ ] **Git push**：最后 `git push` 到远端同分支，让用户 pull 时拿到完整历史

## 备注
<!-- 其他任何信息：已确定的设计决策、已失败需要避开的方案、
     相关文档/issue 链接、偏好的库 等。
     如果对 executor 选择有偏好，可以在这里注明
    （如"此任务需要大上下文分析，建议 gemini-pro"）。 -->
