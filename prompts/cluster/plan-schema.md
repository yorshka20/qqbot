# Plan 文件 schema

Plan 是 planner 拆分 ticket 的**中间产物**。你（planner）通过 `hub_write_plan`
把它落盘为 `tickets/<ticket-id>/plan.md`。

**plan 是 spawn 的依据** —— 每个 `hub_spawn` 的 task guide 都应该从 plan
里对应的 Task 展开，而不是临场想。

## 设计原则

- **想清楚再落盘**：plan 是你拆分思路的固化产物，人类、下一次 planner、
  WebUI 都会看它。不要写完即忘
- **信息密度高于叙事**：每个 Task 的字段都有明确作用，不要写散文
- **路径 + 代码片段双保险**：Task `files` 列具体路径（含行号最好），在 step
  里引用需要的代码片段
- **禁止 placeholder**：`TBD` / 待定 / `处理边界情况` / `参考现有代码` =
  plan 失败。所有内容具体到 executor 能照做

## 文件位置

- **当前版本**：`tickets/<ticket-id>/plan.md`
- **归档**：`tickets/<ticket-id>/plan-v<N>.md`（你二次调用 `hub_write_plan`
  时，orchestrator 自动把旧的 plan.md 改名归档；N 是下一个可用编号）

## 完整 schema（复制这个模板，填你的内容）

```markdown
---
ticket: 2026-04-16-my-ticket-slug      # 必须等于 ticket 目录名（= frontmatter id）
plan_version: 1                         # 首版填 1；二次规划自己 +1
created: 2026-04-16T10:30:00.000Z      # ISO-8601 UTC（现在时间）
planner_task_id: <你的 CLUSTER_TASK_ID> # 追踪哪个 planner 实例写的
decomposition_strategy: |
  从方案 A/B/C 中选了 B (feature vertical)。
  理由：A 会造成前后端 interface 来回调整，C 需要 serial 跑顺序约束太强，
  B 每个 child 可以独立测试闭环。
estimated_children: 3                  # 你打算 spawn 几个 child
---

# Plan: <一句话 ticket 标题>

## Overview

<2–3 句话说明 ticket 要什么、你打算怎么拆、最终成品是什么。写给未来的
人类审阅者，不是写给 executor —— executor 看你在 hub_spawn 里给的 task
guide，并不会直接读 plan.md。>

## Task 1: Backend: 新增 tag 模型 + migration

- **template**: `minimax-m2`
- **estimated_duration**: 5-8 min
- **depends_on**: []
- **files**:
  - Create: `backend/internal/models/tag.go`
  - Modify: `backend/internal/db/migrations/0042_tags.sql`
  - Test: `backend/internal/models/tag_test.go`

### Steps
1. 写 `Tag` struct（字段：`id int64`、`name string`、`created_at time.Time`）
2. 写 migration: `CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TIMESTAMP NOT NULL)`
3. 写 `Tag.Validate()` 方法：name 不能为空、长度 ≤ 64
4. 为 Validate 写单测（空值 / 超长 / 正常 三个 case）

### Acceptance
- [ ] `go vet ./...` 通过
- [ ] `go test ./internal/models/...` 全绿
- [ ] migration 在干净 DB 上 `./migrate up` 后，`sqlite> .schema tags` 显示上述表结构

## Task 2: Backend: tag CRUD endpoints

- **template**: `minimax-m2`
- **estimated_duration**: 8-12 min
- **depends_on**: [Task 1]    # Task 1 的模型必须存在才能加 handler
- **files**:
  - Modify: `backend/internal/server/http.go`（第 118-125 行附近的路由表）
  - Create: `backend/internal/server/tag_handlers.go`
  - Test: `backend/internal/server/tag_handlers_test.go`

### Steps
1. `POST /tags` — body `{name}`，返回 201 + 创建的 tag JSON
2. `GET /tags` — 返回 `{tags: [...]}`
3. `DELETE /tags/:id` — 返回 204；不存在返回 404

### Acceptance
- [ ] `go test ./internal/server/... -run Tag` 全绿
- [ ] 启本地 server 后 `curl -X POST localhost:8080/tags -d '{"name":"foo"}'`
      返回 HTTP 201 + JSON body

## Task 3: Frontend: 标签选择组件

- **template**: `gemini-flash`    # 前端涉及多文件阅读，大 context 窗口更合适
- **estimated_duration**: 10-15 min
- **depends_on**: [Task 2]    # 需要后端 /tags 可用
- **files**:
  - Create: `frontend/src/components/TagPicker.tsx`
  - Modify: `frontend/src/pages/video/EditPanel.tsx`（第 45-62 行，在 title
    输入框下方插入 TagPicker）
  - Test: `frontend/src/components/__tests__/TagPicker.test.tsx`

### Steps
1. 写 `TagPicker` 组件：`fetch('/tags')` 拉列表、多选、支持 `POST /tags`
   创建新 tag
2. 在 `EditPanel.tsx` 的 form 里插入 `<TagPicker value={tags} onChange={setTags} />`
3. Vitest 单测：渲染、选中、创建新 tag 三个 case

### Acceptance
- [ ] `bun run typecheck` 通过
- [ ] `bun test src/components/__tests__/TagPicker` 全绿
```

## Task 字段速查

| 字段 | 必填 | 作用 |
|------|------|------|
| `template` | 是 | executor 模板名，必须匹配 `cluster.workerTemplates` 的 key |
| `estimated_duration` | 否 | 粗估；实际超 2x 说明拆得太粗，应该再拆 |
| `depends_on` | 是 | `[]` = 无依赖（可并行 spawn）；`[Task N]` = 必须等对应前驱完成 |
| `files` | 是 | Create/Modify/Test 分开列；有具体行号就写 `path:line-range` |
| `Steps` | 是 | 有序动作清单；executor 照着做 |
| `Acceptance` | 是 | **可执行命令**，不写"测试通过"这种空话 |

## 使用流程

1. **拆分完**立刻 `hub_write_plan(content)` —— 用上面 schema 写完整 markdown，
   把 `content` 字段设为整个文件（frontmatter + body）
2. **spawn 每个 child 前**，从 plan 的对应 Task 展开 guide：
   - 把 Task 的 `files` / `Steps` / `Acceptance` 粘进 `hub_spawn.description`
   - 加上必要的 scope 上下文（ticket 标题、相关代码片段）
   - executor 在 guide 里看到的已经是 plan 决策的展开版
3. **中途需要 replan**（发现原拆法有问题）：改 plan 内容后**再 `hub_write_plan`
   一次**，orchestrator 把旧 plan.md 归档到 `plan-v<N>.md`，把 `plan_version`
   手动 +1 后写入新版
4. **planner 被重启**（比如 SIGTERM 后重派）：启动时先 `hub_read_plan()`，
   有 plan 就复用，从"第一个还没有对应 completed child 的 Task"继续 spawn
