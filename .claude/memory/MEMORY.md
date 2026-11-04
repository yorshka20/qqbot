# Memory Index

Accumulated user preferences and project facts for this repo, one file per entry. Tracked in git so they travel across machines.

**Read this index at the start of a work session** and open whichever entries look relevant — nothing loads them automatically. Structured instructions (commands, architecture, code conventions, comment style, commit style) live in [`CLAUDE.md`](../../CLAUDE.md); see its "Where Conventions Live" section for which home a new rule belongs in.

## Working agreements

- [feedback_local_planning_artifacts.md](feedback_local_planning_artifacts.md) — 规划产物（workbook / learnings / roadmap / docs/local）留本地 gitignore，不进 git
- [feedback_workbook_no_file_lists.md](feedback_workbook_no_file_lists.md) — 日报不写"涉及文件"清单，git log 已记录
- [feedback_workbook_small_changes_skip.md](feedback_workbook_small_changes_skip.md) — 小改动不写 workbook 日报，commit message 足够
- [feedback_commit_current_branch.md](feedback_commit_current_branch.md) — 始终在当前分支提交，不主动开分支
- [feedback_ticket_series_naming.md](feedback_ticket_series_naming.md) — 同批 ticket（≥2）title 用 `series [i/N]` 命名
- [feedback_no_os_service_integration.md](feedback_no_os_service_integration.md) — 进程守护留在 Bun/Node 生态内（scripts/supervisor），不装 launchd/systemd/Windows 服务
- [feedback_config_example_sync.md](feedback_config_example_sync.md) — config.d/<topic>.jsonc 是运行时真相，example 是参考文档，两边同改

- [feedback_console_ia_and_dispatch.md](feedback_console_ia_and_dispatch.md) — cluster 控制台：Claude-app 式两级导航（收件箱 + 对话），设置等是二级；反馈先进规格再派一张 ticket，不给 planner 补消息，验收 owner 做

- [feedback_prompts_live_in_prompt_files.md](feedback_prompts_live_in_prompt_files.md) — prompt 文字只能在 prompts/ 模板文件里，代码只加载并填 {{TOKEN}}，一句 prose 都不能写进 .ts

- [feedback_subsessions_use_opus.md](feedback_subsessions_use_opus.md) — 开的子 session / subagent 一律 claude-opus-5-5，不用 fable

## Code-shape corrections

- [feedback_no_defensive_optionals.md](feedback_no_defensive_optionals.md) — 上游保证有值就别做可选参数 + 条件 fallback
- [feedback_tests_import_constants.md](feedback_tests_import_constants.md) — 测试不复制实现常量：export 后 import，fixture 由常量推导
- [feedback_avoid_prop_drilling.md](feedback_avoid_prop_drilling.md) — 别反射性透传；先看能不能从已持有的依赖或既有 context 读，新增 context 字段要论证
- [feedback_tool_output_budget.md](feedback_tool_output_budget.md) — 工具输出截断要配杠杆+续读指引，逼出额外一轮调用就是负收益
- [feedback_no_module_state_prefer_statics.md](feedback_no_module_state_prefer_statics.md) — 别用模块级可变状态；访问器挂到拥有该概念的类上做 static

## Project facts

- [feedback_cross_platform_user_binding.md](feedback_cross_platform_user_binding.md) — 跨平台身份绑定（unified_user_id）暂不实现，但改动不能把门关死
