# Memory Index

Accumulated user preferences and project facts for this repo, one file per entry. Tracked in git so they travel across machines.

**Read this index at the start of a work session** and open whichever entries look relevant — nothing loads them automatically. Structured instructions (commands, architecture, code conventions, comment style, commit style) live in [`CLAUDE.md`](../../CLAUDE.md); see its "Where Conventions Live" section for which home a new rule belongs in.

## Working agreements

- [feedback_local_planning_artifacts.md](feedback_local_planning_artifacts.md) — 规划产物（workbook / learnings / roadmap / docs/local）留本地 gitignore，不进 git
- [feedback_workbook_no_file_lists.md](feedback_workbook_no_file_lists.md) — 日报不写"涉及文件"清单，git log 已记录
- [feedback_commit_current_branch.md](feedback_commit_current_branch.md) — 始终在当前分支提交，不主动开分支
- [feedback_ticket_series_naming.md](feedback_ticket_series_naming.md) — 同批 ticket（≥2）title 用 `series [i/N]` 命名
- [feedback_config_example_sync.md](feedback_config_example_sync.md) — config.d/<topic>.jsonc 是运行时真相，example 是参考文档，两边同改

## Code-shape corrections

- [feedback_no_defensive_optionals.md](feedback_no_defensive_optionals.md) — 上游保证有值就别做可选参数 + 条件 fallback
- [feedback_avoid_prop_drilling.md](feedback_avoid_prop_drilling.md) — 别反射性透传；先看能不能从已持有的依赖或既有 context 读，新增 context 字段要论证
- [feedback_no_module_state_prefer_statics.md](feedback_no_module_state_prefer_statics.md) — 别用模块级可变状态；访问器挂到拥有该概念的类上做 static

## Project facts

- [feedback_cross_platform_user_binding.md](feedback_cross_platform_user_binding.md) — 跨平台身份绑定（unified_user_id）暂不实现，但改动不能把门关死
