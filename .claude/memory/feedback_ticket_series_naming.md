---
name: Ticket series naming for batched dispatch
description: Multi-ticket batches that share a logical theme (with OR without execution order) must use series naming in title (e.g. "mind-expansion [1/3]")
type: feedback
originSessionId: 64ac1fac-e436-4da7-86c6-865f9b5c166f
---
同一批次的多张 ticket（≥2，无论是否有执行顺序）**必须**在 `title` 字段里用 series 命名标记，格式 `<series-name> [i/N] — <slug>`：

- `mind-expansion [1/3] — Core DNA loader + PersonaModulation 六组`
- `mind-expansion [2/3] — Avatar Ambient gain bus`
- `mind-expansion [3/3] — Character Bible loader + PromptPatch + Reflection`

**Why**: 1) 用户批量 dispatch 时一眼看出哪些是同批次任务、属于哪个主题；2) WebUI ticket 列表按 title 字母序时序号自然聚集；3) hub_report 引用 series 名一目了然；4) 即便 parallel-dispatchable 也是"协调 batch"，series 名是任务**类型/分组标识**，不只是执行顺序——2026-04-29 用户纠正之前理解：同系列即用，方便识别任务类型，不要等到有串行依赖才加。

**How to apply**:
- ≥2 张同批次 ticket（同一天 dispatch、同主题、有共享背景）→ series 命名 mandatory，无论是否有 execution-order 依赖
- 单张孤立 ticket → 不用 series 命名
- series 名格式：短小、有领域/主题前缀（`mind-expansion` / `avatar-pipeline` / `cluster-batch10` / `vkb-ingest` 等）+ `[i/N]` + ` — ` + 任务 slug
- ID（目录名）不强制带 series 编号——目录名按 `YYYY-MM-DD-<slug>`，title 是人读用的，所以 series 编号在 title
- 若同批次内有 execution-order 依赖，[i/N] 编号反映**依赖顺序**；无依赖时编号反映**逻辑递进**（基础 → 上层）即可
- 若不确定是否同批次，先问用户再下笔，不要自作主张省略 series 命名
